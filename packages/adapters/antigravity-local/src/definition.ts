import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult, AdapterConfigSchema, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { AdapterError, localOnly, parseConfig, record, text } from "./config.js";
import { environment, manualLoginHint, prepareHome, prepareAgentHome } from "./home.js";
import { runProcess } from "./process.js";
import { authRequired, keyringFailure, parseModels, validSessionId } from "./protocol.js";

const schema: AdapterConfigSchema = { fields: [
  { key: "connectionMode", label: "Forma de conexão", type: "select", group: "Conexão", default: "api_key",
    options: [{ value: "api_key", label: "Chave de API (Google AI Studio)" }, { value: "subscription", label: "Assinatura Google (conta já conectada na VPS)" }],
    hint: "Selecione/crie um segredo para GEMINI_API_KEY no campo de credencial. Para assinatura, conecte a conta manualmente no HOME do agente." },
  { key: "diagnosticAgentId", label: "ID do agente para testar assinatura", type: "text", group: "Conexão", hint: "Copie o ID do agente salvo. O contrato de teste não fornece esse ID; ele é usado somente para localizar o HOME no diagnóstico." },
  { key: "baseUrl", label: "Endpoint Google Gemini (opcional)", type: "text", group: "Conexão", hint: "URL HTTPS sem credenciais. Define GOOGLE_GEMINI_BASE_URL; deixe vazio para usar o endpoint do Google." },
  { key: "command", label: "Binário Antigravity", type: "text", group: "Execução", default: "agy", hint: "agy no PATH do serviço, ou caminho absoluto (ex.: /home/paperclip/.local/bin/agy). O plugin não instala o CLI." },
  { key: "model", label: "Modelo", type: "combobox", group: "Execução", hint: "Slug de agy models; pode ser digitado. Vazio usa o padrão do CLI. A descoberta global usa agy no PATH sem credenciais." },
  { key: "effort", label: "Esforço", type: "select", group: "Execução", options: [
    { value: "", label: "Padrão do CLI" }, { value: "low", label: "Baixo" }, { value: "medium", label: "Médio" }, { value: "high", label: "Alto" }], hint: "Esforço de raciocínio aceito pelo modelo." },
  { key: "cwd", label: "Diretório de trabalho alternativo", type: "text", group: "Execução", hint: "Caminho absoluto. O workspace fornecido pelo Paperclip tem prioridade." },
  { key: "dangerouslySkipPermissions", label: "Pular permissões", type: "toggle", group: "Permissões", default: false, hint: "Autoriza todas as ferramentas, inclusive shell e escrita. Ative somente após revisar o agente e o isolamento da VPS." },
  { key: "sandbox", label: "Sandbox do CLI", type: "toggle", group: "Permissões", default: false, hint: "Passa --sandbox. Requer suporte do sistema instalado; não é um ambiente remoto Paperclip." },
  { key: "timeoutSec", label: "Timeout em segundos", type: "number", group: "Execução", default: 3600, hint: "De 1 a 86400; aplicado ao processo e ao --print-timeout do CLI." },
  { key: "graceSec", label: "Carência para encerrar em segundos", type: "number", group: "Execução", default: 5, hint: "De 1 a 60; depois de SIGTERM o grupo recebe SIGKILL." },
] };

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  let home: string | undefined;
  let disposable = false;
  let loginHint: string | undefined;
  try {
    localOnly(ctx);
    const config = parseConfig(ctx.config);
    const subscription = config.connectionMode === "subscription";
    const agentId = text(ctx.config.diagnosticAgentId);
    loginHint = manualLoginHint(ctx.companyId, config.command, agentId);
    if (!subscription && !config.env.GEMINI_API_KEY?.trim()) {
      checks.push({ code: "adapter_auth_missing", level: "error", message: "Conecte a conta ou configure a chave. Selecione/crie um segredo GEMINI_API_KEY no Paperclip.", hint: manualLoginHint(ctx.companyId, config.command) });
      if (process.platform === "linux" && !process.env.DBUS_SESSION_BUS_ADDRESS) checks.push({ code: "antigravity_keyring_unavailable", level: "warn",
        message: "Sem D-Bus de sessão no serviço Linux. Login Google pode falhar ou travar; configure Secret Service desbloqueado para esse usuário, ou use chave de API. Não há fallback para arquivo confirmado." });
    }
    if (subscription) {
      if (!agentId) throw new AdapterError("adapter_auth_missing", "Informe o ID do agente salvo no campo de diagnóstico para testar a conta no HOME correto.");
      home = await prepareAgentHome(ctx.companyId, agentId, config.connectionMode);
      checks.push({ code: "antigravity_keyring_notice", level: "info", message: "Aviso: assinatura no Linux exige D-Bus de sessão e Secret Service desbloqueado para o usuário do serviço; HOME não isola o keyring por UID." });
    } else {
      home = await mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-probe-"));
      disposable = true;
      await prepareHome(home);
    }
    const cwd = await realpath(config.cwd || process.cwd());
    const env = environment(home, config.env, config.connectionMode);
    const probe = (args: string[]) => runProcess(config.command, args, { cwd, env, timeoutSec: 10, graceSec: 1 });
    const version = await probe(["--version"]);
    if (version.failed || version.timedOut || version.exitCode !== 0 || !/\b\d+\.\d+\.\d+\b/.test(version.stdout)) {
      throw new AdapterError("antigravity_binary_invalid", "Não foi possível validar o binário/versão. Instale o agy externamente e configure o caminho no serviço.");
    }
    checks.push({ code: "antigravity_version", level: "info", message: "Binário agy encontrado e versão identificada." });
    const help = await probe(["--help"]);
    // agy (Go flag) prints --help to stderr with exit 0; accept either stream.
    const helpText = help.stdout + help.stderr;
    if (help.failed || help.timedOut || help.exitCode !== 0 || !helpText.includes("--input-format") || !helpText.includes("--print-timeout")) {
      throw new AdapterError("antigravity_cli_incompatible", "Atualize o agy: são necessários --input-format stream-json e --print-timeout.");
    }
    if (subscription || config.env.GEMINI_API_KEY?.trim()) {
      const result = await probe(["models"]);
      if (result.timedOut) throw new AdapterError("antigravity_probe_timeout", "agy models excedeu 10 segundos e foi encerrado. Confira rede, endpoint e acesso ao keyring.");
      if (keyringFailure(result.stderr)) throw new AdapterError("antigravity_keyring_unavailable", "agy relatou erro no keyring. Confira modelProvider=gemini e o CLI; para assinatura, configure D-Bus e Secret Service desbloqueado.");
      if (authRequired(result.stderr + result.stdout)) throw new AdapterError("adapter_auth_missing", subscription ? "Conta Google não conectada. Execute o login manual indicado e teste novamente." : "Conecte a conta ou configure a chave. Revise o segredo GEMINI_API_KEY.");
      if (result.failed || result.exitCode !== 0) throw new AdapterError("antigravity_models_failed", "Não foi possível listar modelos. Confira chave, endpoint, rede e versão do agy.");
      const models = parseModels(result.stdout);
      if (!models.length) throw new AdapterError("antigravity_models_invalid", "agy models retornou um formato não reconhecido ou uma lista vazia.");
      checks.push({ code: "antigravity_models", level: "info", message: subscription ? `Conta Google conectada; ${models.length} modelos` : `${models.length} modelos disponíveis no CLI.` });
      if (config.model && !models.some((model) => model.id === config.model)) checks.push({ code: "antigravity_model_not_listed", level: "warn", message: "O slug configurado não aparece em agy models. Confira se é um modelo personalizado válido." });
      if (!subscription) checks.push({ code: "antigravity_auth_unverified", level: "warn", message: "Chave recebida e modelos listados, sem gastar créditos. O CLI pode validar a chave somente na primeira conversa; isso ainda não comprova acesso à inferência." });
    }
  } catch (error) {
    checks.push({ code: error instanceof AdapterError ? error.code : "antigravity_environment", level: "error",
      hint: error instanceof AdapterError && error.code === "adapter_auth_missing" ? loginHint : undefined,
      message: error instanceof AdapterError ? error.message : "Falha ao preparar o ambiente local. Confira diretório, permissões e instalação do agy." });
  } finally { if (home && disposable) await rm(home, { recursive: true, force: true }); }
  return { adapterType: "antigravity_local", testedAt: new Date().toISOString(),
    status: checks.some((c) => c.level === "error") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "pass", checks };
}

/** Host listModels has no config/company/agent argument. Never borrow server auth. */
export async function discoverModels() {
  const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-models-"));
  try {
    const result = await runProcess("agy", ["models"], { cwd: home, env: environment(home, {}), timeoutSec: 10, graceSec: 1 });
    return !result.failed && !result.timedOut && result.exitCode === 0 ? parseModels(result.stdout) : [];
  } finally { await rm(home, { recursive: true, force: true }); }
}
export function createAdapterDefinition(base: Pick<ServerAdapterModule, "type" | "models" | "execute" | "agentConfigurationDoc">): ServerAdapterModule {
  return { ...base, supportsLocalAgentJwt: true, runtimeToolDelivery: "environment", supportsInstructionsBundle: true,
    requiresMaterializedRuntimeSkills: true, testEnvironment, getConfigSchema: () => schema,
    listModels: discoverModels,
    // `models` has no selected/default marker. Guessing its first row is wrong.
    detectModel: async () => { await discoverModels(); return null; },
    sessionCodec: {
      deserialize(raw) { const value = record(raw); return validSessionId(value.sessionId) && /^[a-f0-9]{64}$/.test(text(value.scope)) ? { sessionId: value.sessionId, scope: value.scope } : null; },
      serialize(params) { return this.deserialize(params); },
      getDisplayId(params) { return text(params?.sessionId) || null; },
    },
  };
}
