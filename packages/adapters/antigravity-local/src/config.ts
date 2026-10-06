export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
const ENV_KEYS = /^(GEMINI_API_KEY|GOOGLE_GEMINI_BASE_URL)$/;

export class AdapterError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function localOnly(ctx: { executionTarget?: { kind: string } | null; executionTransport?: { remoteExecution?: unknown } }) {
  if (ctx.executionTarget?.kind === "remote" || ctx.executionTransport?.remoteExecution) {
    throw new AdapterError("antigravity_local_only", "Este plugin executa apenas no servidor local do Paperclip; SSH e sandbox remoto não são suportados.");
  }
}
export function parseExecutionConfig(runtime: Record<string, unknown>, configured: unknown) {
  const operatorEnv = record(configured).env;
  validateEnvObject(operatorEnv);
  if (Object.keys(record(operatorEnv)).some((key) => !ENV_KEYS.test(key))) {
    throw new AdapterError("antigravity_config_invalid", "Variável de ambiente não permitida na configuração do agente.");
  }
  const binding = record(operatorEnv).GEMINI_API_KEY;
  if ((binding !== undefined || record(runtime.env).GEMINI_API_KEY !== undefined) && !["secret_ref", "user_secret_ref"].includes(text(record(binding).type))) {
    throw new AdapterError("antigravity_secret_binding_required", "Selecione um segredo do Paperclip para GEMINI_API_KEY; não salve a chave diretamente no agente.");
  }
  // The host enriches env with scratch/git variables after resolving secrets.
  // Validate operator names separately; never forward those unrelated additions.
  return parseConfig({ ...runtime, env: Object.fromEntries(Object.entries(record(runtime.env)).filter(([key]) => ENV_KEYS.test(key))) });
}
function validateEnvObject(value: unknown) {
  if (value != null && (typeof value !== "object" || Array.isArray(value))) {
    throw new AdapterError("antigravity_config_invalid", "env deve ser um objeto de bindings de segredos.");
  }
}
function positive(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new AdapterError("antigravity_config_invalid", "Timeout e carência devem ser números positivos dentro dos limites documentados.");
  }
  return value;
}
export function parseConfig(raw: Record<string, unknown>) {
  const command = text(raw.command) || "agy";
  const model = text(raw.model);
  const effort = text(raw.effort);
  if (command.includes("\0") || command.startsWith("-") || (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model))
    || (effort && !["low", "medium", "high"].includes(effort))) {
    throw new AdapterError("antigravity_config_invalid", "Confira o caminho do agy, o slug do modelo e o esforço (low, medium ou high).");
  }
  if (raw.connectionMode != null && !["api_key", "subscription"].includes(String(raw.connectionMode))) {
    throw new AdapterError("antigravity_config_invalid", "Forma de conexão inválida.");
  }
  validateEnvObject(raw.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(raw.env))) {
    if (!ENV_KEYS.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new AdapterError("antigravity_config_invalid", "O host deve resolver os segredos antes de chamar o adapter. Somente GEMINI_API_KEY e GOOGLE_GEMINI_BASE_URL são aceitos.");
    }
    env[key] = value;
  }
  const endpoint = text(raw.baseUrl) || env.GOOGLE_GEMINI_BASE_URL;
  if (endpoint) {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new AdapterError("antigravity_endpoint_invalid", "Endpoint inválido; informe uma URL HTTPS sem credenciais."); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new AdapterError("antigravity_endpoint_invalid", "Endpoint deve usar HTTPS, sem credenciais, query ou fragmento.");
    }
    env.GOOGLE_GEMINI_BASE_URL = endpoint;
  }
  const connectionMode = raw.connectionMode === "subscription" ? "subscription" : "api_key";
  if (connectionMode === "subscription") { delete env.GEMINI_API_KEY; delete env.GOOGLE_GEMINI_BASE_URL; }
  return { connectionMode, command, model, effort, env, cwd: text(raw.cwd), instructionsFilePath: text(raw.instructionsFilePath),
    timeoutSec: positive(raw.timeoutSec, 3600, 86400), graceSec: positive(raw.graceSec, 5, 60),
    dangerouslySkipPermissions: raw.dangerouslySkipPermissions === true, sandbox: raw.sandbox === true };
}
export function secretRedactor(env: NodeJS.ProcessEnv) {
  const values = Object.entries(env)
    .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && value)
    .flatMap(([, value]) => value ? [value, JSON.stringify(value).slice(1, -1)] : [])
    .sort((a, b) => b.length - a.length);
  return (input: string): string => values.reduce((out, value) => out.split(value).join("[REDACTED]"), input);
}
