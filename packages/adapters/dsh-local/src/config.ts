export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export const text = (value: unknown): string => typeof value === "string" ? value : "";
export class AdapterError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export const providers = {
  deepseek: { label: "DeepSeek", key: "DEEPSEEK_API_KEY", baseURL: "https://api.deepseek.com", protocol: "openai-completions", console: "https://platform.deepseek.com/api_keys", models: ["deepseek-flash", "deepseek-pro"] },
  anthropic: { label: "Anthropic", key: "ANTHROPIC_API_KEY", baseURL: "https://api.anthropic.com", protocol: "anthropic-messages", console: "https://console.anthropic.com/settings/keys", models: ["claude-sonnet-4-5", "claude-opus-4-1"] },
  openai: { label: "OpenAI", key: "OPENAI_API_KEY", baseURL: "https://api.openai.com/v1", protocol: "openai-responses", console: "https://platform.openai.com/api-keys", models: ["gpt-5", "gpt-5-mini"] },
  moonshotai: { label: "Kimi (Moonshot)", key: "MOONSHOT_API_KEY", baseURL: "https://api.moonshot.ai/v1", protocol: "openai-completions", console: "https://platform.moonshot.ai/console/api-keys", models: ["kimi-k2.5", "kimi-k2-thinking"] },
  zai: { label: "GLM (Z.ai)", key: "ZAI_API_KEY", baseURL: "https://api.z.ai/api/paas/v4", protocol: "openai-completions", console: "https://z.ai/manage-apikey/apikey-list", models: ["glm-4.7", "glm-4.6"] },
  custom: { label: "Outro / API compatível", key: "DSH_CUSTOM_API_KEY", baseURL: "", protocol: "openai-completions", console: "", models: [] as string[] },
} as const;
export const protocols = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export const efforts = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const keys = new Set(Object.values(providers).map((p) => p.key as string));
function limit(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > max) throw new AdapterError("dsh_config_invalid", "Limite de execução inválido.");
  return value;
}
function stringField(raw: Record<string, unknown>, key: string, fallback = "") {
  if (raw[key] === undefined) return fallback;
  if (typeof raw[key] !== "string" || /[\x00-\x1f\x7f]/.test(raw[key] as string)) throw new AdapterError("dsh_config_invalid", `Campo ${key} inválido.`);
  return (raw[key] as string).trim();
}
export function parseConfig(raw: Record<string, unknown>, requireModel = true) {
  const provider = stringField(raw, "provider", "deepseek");
  if (!Object.hasOwn(providers, provider)) throw new AdapterError("dsh_provider_invalid", "Selecione um provedor suportado; OAuth não é suportado.");
  const selected = providers[provider as keyof typeof providers];
  const providerId = provider === "custom" ? stringField(raw, "providerId") : provider === "deepseek" ? "deepseek-official" : provider;
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(providerId) || providerId.length > 100 || (provider === "custom" && ["deepseek-official", "deepseek", "constructor", "prototype", ...Object.keys(providers)].includes(providerId))) {
    throw new AdapterError("dsh_provider_invalid", "Outro exige ID permanente minúsculo (letras, números e hífens), sem reutilizar um provedor conhecido.");
  }
  const baseURL = provider === "custom" ? stringField(raw, "baseURL") : selected.baseURL;
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new AdapterError("dsh_url_invalid", "Informe uma URL base HTTP(S) válida para Outro."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AdapterError("dsh_url_invalid", "URL base deve usar HTTP(S), sem chave, usuário, senha, query ou fragmento.");
  // The connection test calls this URL from the Paperclip server: never toward
  // cloud metadata / link-local addresses (169.254.0.0/16, fe80::/10).
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || host === "metadata.google.internal") {
    throw new AdapterError("dsh_url_invalid", "URL base aponta para endereço de metadados/link-local; use o endereço do gateway.");
  }
  const protocol = provider === "custom" ? stringField(raw, "protocol", "openai-completions") : selected.protocol;
  if (!(protocols as readonly string[]).includes(protocol)) throw new AdapterError("dsh_protocol_invalid", "Escolha um dos três protocolos de API suportados.");
  const model = stringField(raw, "model");
  if ((requireModel && !model) || model.length > 300) throw new AdapterError("dsh_model_missing", "Escolha ou digite o ID do modelo (sem prefixo do provedor). Confirme com Enter.");
  const reasoningEffort = stringField(raw, "reasoningEffort");
  if (!efforts.includes(reasoningEffort)) throw new AdapterError("dsh_effort_invalid", "Esforço de raciocínio inválido.");
  if (raw.env != null && (typeof raw.env !== "object" || Array.isArray(raw.env))) throw new AdapterError("dsh_env_invalid", "env deve conter credenciais resolvidas pelo Paperclip.");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(raw.env))) {
    if (!keys.has(key) || typeof value !== "string" || value.includes("\0")) throw new AdapterError("dsh_env_invalid", "Use apenas as variáveis de chave dos provedores, com segredos resolvidos pelo host.");
    // Only the chosen provider's credential reaches dsh.
    if (key === selected.key) env[key] = value;
  }
  return { provider, providerId, label: selected.label, key: selected.key, console: selected.console, baseURL: baseURL.replace(/\/+$/, ""), protocol, model, reasoningEffort, env,
    command: stringField(raw, "command", "dsh") || "dsh", cwd: stringField(raw, "cwd"), instructionsFilePath: stringField(raw, "instructionsFilePath"),
    timeoutSec: limit(raw.timeoutSec, 1800, 86400), graceSec: limit(raw.graceSec, 5, 60) };
}
export type DshConfig = ReturnType<typeof parseConfig>;
export function parseExecutionConfig(runtime: Record<string, unknown>, configured: unknown) {
  const operatorEnv = record(configured).env;
  if (operatorEnv != null && (typeof operatorEnv !== "object" || Array.isArray(operatorEnv))) throw new AdapterError("dsh_env_invalid", "env do agente inválido.");
  for (const [key, binding] of Object.entries(record(operatorEnv))) {
    if (!keys.has(key)) throw new AdapterError("dsh_env_invalid", "Variável de ambiente não permitida no agente.");
    if (!["secret_ref", "user_secret_ref"].includes(text(record(binding).type))) throw new AdapterError("dsh_secret_binding_required", "Vincule a chave a um segredo do Paperclip; chaves literais não são aceitas.");
  }
  const config = parseConfig({ ...runtime, env: Object.fromEntries(Object.entries(record(runtime.env)).filter(([key]) => keys.has(key))) });
  if (!Object.hasOwn(record(operatorEnv), config.key)) throw new AdapterError("adapter_auth_missing", `Vincule ${config.key} a um segredo no env do agente.`);
  return config;
}
export function localOnly(ctx: { executionTarget?: { kind: string } | null; executionTransport?: { remoteExecution?: unknown } }) {
  if (ctx.executionTarget?.kind === "remote" || ctx.executionTransport?.remoteExecution) throw new AdapterError("dsh_local_only", "Este motor executa somente no host local do Paperclip.");
}
export function supportedNode(version: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return Boolean(match && (Number(match[1]) >= 24 || Number(match[1]) === 22 && Number(match[2]) >= 19));
}
export function supportedVersion(version: string) { return /\b0\.2\.1-alpha\.1\b/.test(version); }
export function secretRedactor(env: NodeJS.ProcessEnv) {
  const values = Object.entries(env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && typeof value === "string" && value)
    .flatMap(([, value]) => value ? [value, JSON.stringify(value).slice(1, -1)] : []).sort((a, b) => b.length - a.length);
  return (input: string) => values.reduce((out, value) => out.split(value).join("[REDACTED]"), input);
}
export function buildArgs(patch: string, sessionId = "") {
  return ["--profile", "headless", "--patch", patch, "--json", ...(sessionId ? ["--session-id", sessionId] : [])];
}
/** JSON flow syntax is valid YAML; escaping is delegated to JSON.stringify. */
export function overlay(config: DshConfig): string {
  const route = config.provider === "deepseek"
    ? { id: "llm-deepseek", config: { apiKeyEnv: config.key } }
    : { id: "llm-pi-ai", config: { providers: { [config.providerId]: {
      apiKeyEnv: config.key,
      ...(config.provider === "custom" ? { api: config.protocol, baseURL: config.baseURL } : {}),
      models: [{ id: config.model }],
    } } } };
  return JSON.stringify([route, { id: "agent-default-model", config: { provider: config.providerId, model: config.model,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) } }], null, 2) + "\n";
}
