import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult, AdapterConfigSchema, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { AdapterError, efforts, localOnly, parseConfig, providers, record, secretRedactor, supportedNode, supportedVersion, text, type DshConfig } from "./config.js";
import { environment } from "./home.js";
import { runProcess } from "./process.js";
import { validSessionId } from "./protocol.js";

export const schema: AdapterConfigSchema = { fields: [
  { key: "provider", label: "1. Provedor", type: "select", group: "Conexão", default: "deepseek", required: true,
    options: Object.entries(providers).map(([value, p]) => ({ value, label: p.label })),
    hint: "Selecione/crie a chave no SecretPicker (na edição: Variáveis de ambiente). OAuth não é suportado. Onde pego essa chave? " + Object.values(providers).filter((p) => p.console).map((p) => `${p.label}: ${p.console}`).join("; ") },
  { key: "providerId", label: "ID permanente do provedor", type: "text", group: "Conexão", required: true, meta: { visibleWhen: { key: "provider", value: "custom" } }, hint: "Só para Outro: minúsculas, números e hífens. Não renomeie após criar sessões." },
  { key: "baseURL", label: "URL base", type: "text", group: "Conexão", required: true, meta: { visibleWhen: { key: "provider", value: "custom" } }, hint: "Só para Outro: raiz da API, incluindo /v1 se exigido; nunca inclua a chave na URL." },
  { key: "protocol", label: "Protocolo", type: "select", group: "Conexão", default: "openai-completions", meta: { visibleWhen: { key: "provider", value: "custom" } },
    options: [{ value: "openai-completions", label: "OpenAI Chat Completions — /chat/completions" }, { value: "openai-responses", label: "OpenAI Responses — /responses" }, { value: "anthropic-messages", label: "Anthropic Messages — /messages" }], hint: "Só para Outro: escolha o protocolo que seu gateway implementa." },
  { key: "model", label: "3. Modelo", type: "combobox", group: "Modelo", required: true, meta: { providerModels: Object.fromEntries(Object.entries(providers).map(([key, p]) => [key, p.models])) },
    hint: "Use Testar ambiente para listar modelos sem gastar créditos. Selecione ou digite o ID e confirme com Enter; sugestões dependem da versão do catálogo instalado." },
  { key: "reasoningEffort", label: "Esforço de raciocínio", type: "select", group: "Modelo", default: "", options: efforts.map((value) => ({ value, label: value || "Padrão do provedor" })), hint: "Opcional. O modelo precisa suportar o esforço escolhido." },
  { key: "command", label: "Binário dsh", type: "text", group: "Execução", default: "dsh", hint: "dsh no PATH do serviço ou caminho absoluto. Instale @deepseek-ai/dsh externamente; o adapter não instala o CLI." },
  { key: "cwd", label: "Diretório de trabalho alternativo", type: "text", group: "Execução", hint: "Caminho absoluto. O workspace do Paperclip tem prioridade." },
  { key: "timeoutSec", label: "Timeout (segundos)", type: "number", group: "Execução", default: 1800, hint: "Entre 1 e 86400; encerra processo e filhos." },
  { key: "graceSec", label: "Carência de encerramento (segundos)", type: "number", group: "Execução", default: 5, hint: "Entre 1 e 60; depois de SIGTERM o grupo recebe SIGKILL." },
] };

/** No inference, no redirects carrying credentials, bounded response and timeout. */
export async function listProviderModels(config: DshConfig, fetcher: typeof fetch = fetch): Promise<string[]> {
  const key = config.env[config.key];
  if (!key?.trim()) throw new AdapterError("adapter_auth_missing", `Selecione/crie um segredo para ${config.key}.`);
  const anthropic = config.protocol === "anthropic-messages";
  const url = anthropic ? `${config.baseURL.replace(/\/v1$/, "")}/v1/models?limit=1000` : `${config.baseURL}/models`;
  const headers: Record<string, string> = anthropic ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` };
  try {
    const response = await fetcher(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (response.status === 401 || response.status === 403) throw new AdapterError("adapter_auth_missing", `Credencial recusada por ${config.label}. Revise o segredo e suas permissões.`);
    if (!response.ok) throw new AdapterError("dsh_models_failed", `Listagem de modelos retornou HTTP ${response.status}. Confira endpoint e permissões; o ID também pode ser digitado manualmente.`);
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "", bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) throw new Error();
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally { await reader.cancel(); }
    const parsed = record(JSON.parse(body));
    if (!Array.isArray(parsed.data) && (!parsed.models || typeof parsed.models !== "object" || Array.isArray(parsed.models))) throw new Error();
    const candidates = Array.isArray(parsed.data) ? parsed.data.map((m) => text(record(m).id))
      : Object.entries(record(parsed.models)).filter(([, v]) => v !== null && typeof v === "object").map(([id]) => id);
    return [...new Set(candidates.filter((id) => id.length > 0 && id.length <= 300 && !/[\x00-\x1f\x7f]/.test(id)))].sort();
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("dsh_models_failed", "Não foi possível listar modelos. Confira rede, URL e resposta JSON; digite o ID manualmente se a API não oferecer listagem.");
  }
}
export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  let home: string | undefined;
  try {
    localOnly(ctx);
    const config = parseConfig(ctx.config, false);
    if (!config.env[config.key]?.trim()) checks.push({ code: "adapter_auth_missing", level: "error", message: `Selecione/crie um segredo para ${config.key}.`, hint: config.console || "Obtenha a chave no console do seu gateway." });
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-dsh-probe-"));
    const cwd = await realpath(config.cwd || process.cwd());
    // Version probes do not need provider credentials.
    const env = environment(home, {});
    const options = { cwd, env, timeoutSec: 10, graceSec: 1 };
    const node = await runProcess("node", ["--version"], options);
    if (node.failed || node.timedOut || node.signal || node.exitCode !== 0 || !supportedNode(node.stdout)) throw new AdapterError("dsh_node_incompatible", "O Node no PATH do serviço precisa ser ^22.19 ou >=24.");
    checks.push({ code: "dsh_node", level: "info", message: `Node compatível: ${node.stdout.trim()}.` });
    const version = await runProcess(config.command, ["--version"], options);
    if (version.failed || version.timedOut || version.signal || version.exitCode !== 0 || !supportedVersion(version.stdout)) throw new AdapterError("dsh_binary_invalid", "Não foi possível validar dsh 0.2.1-alpha.1. Confira instalação externa, versão e PATH do usuário do serviço.");
    checks.push({ code: "dsh_version", level: "info", message: "Binário dsh 0.2.1-alpha.1 encontrado." });
    if (config.env[config.key]?.trim()) {
      const models = await listProviderModels(config);
      const redact = secretRedactor(config.env);
      checks.push({ code: "dsh_connected", level: "info", message: redact(`Conectado a ${config.label}; modelos disponíveis: ${models.slice(0, 8).join(", ") || "lista vazia"}. Sem inferência.`) });
      if (config.model && !models.includes(config.model)) checks.push({ code: "dsh_model_not_listed", level: "warn", message: "O ID escolhido não apareceu na listagem. Pode ser um modelo personalizado; confirme o acesso na primeira execução." });
    }
  } catch (error) {
    checks.push({ code: error instanceof AdapterError ? error.code : "dsh_environment", level: error instanceof AdapterError && error.code === "dsh_models_failed" ? "warn" : "error", message: error instanceof AdapterError ? error.message : "Falha ao preparar o ambiente local. Confira diretório, permissões e instalação." });
  } finally { if (home) await rm(home, { recursive: true, force: true }); }
  return { adapterType: "dsh_local", testedAt: new Date().toISOString(), status: checks.some((c) => c.level === "error") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "pass", checks };
}
export function createAdapterDefinition(base: Pick<ServerAdapterModule, "type" | "models" | "execute" | "agentConfigurationDoc">): ServerAdapterModule {
  return { ...base, supportsLocalAgentJwt: true, runtimeToolDelivery: "environment", supportsInstructionsBundle: true, requiresMaterializedRuntimeSkills: true,
    testEnvironment, getConfigSchema: () => schema,
    sessionCodec: {
      deserialize(raw) { const v = record(raw); return validSessionId(v.sessionId) && /^[a-f0-9]{64}$/.test(text(v.scope)) ? { sessionId: v.sessionId, scope: v.scope } : null; },
      serialize(params) { return this.deserialize(params); }, getDisplayId(params) { return text(params?.sessionId) || null; },
    } };
}
