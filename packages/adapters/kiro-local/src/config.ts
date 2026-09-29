export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function positive(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error("Invalid execution limit.");
  }
  return value;
}
export function parseConfig(raw: Record<string, unknown>) {
  const command = text(raw.command) || "kiro-cli";
  const agent = text(raw.kiroAgent);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(agent)) {
    throw new Error("Set kiroAgent to a named, operator-reviewed Kiro agent.");
  }
  const engine = raw.engine ?? "v2";
  if (engine !== "v2" && engine !== "v3") throw new Error("Kiro engine must be v2 or v3.");
  const trustedTools = text(raw.trustedTools ?? "read,grep");
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*(,[a-zA-Z][a-zA-Z0-9_-]*)*$/.test(trustedTools)) {
    throw new Error("trustedTools must be an explicit comma-separated list; wildcards are not supported.");
  }
  if (raw.model != null) throw new Error("Set the model in the named Kiro agent, not adapterConfig.model.");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(raw.env))) {
    // Host identity and process injection settings must not be overridden.
    if (!/^(KIRO_API_KEY|KIRO_HOME|AWS_PROFILE|AWS_REGION|AWS_DEFAULT_REGION)$/.test(key)
      || typeof value !== "string" || value.includes("\0")) {
      throw new Error("Unsupported environment variable. Only Kiro authentication/profile settings are accepted.");
    }
    env[key] = value;
  }
  if (raw.env != null && (typeof raw.env !== "object" || Array.isArray(raw.env))) {
    throw new Error("env must be an object with resolved string values.");
  }
  if (command.includes("\0")) throw new Error("Invalid command.");
  return {
    command, agent, engine, trustedTools, env,
    cwd: text(raw.cwd), instructionsFilePath: text(raw.instructionsFilePath),
    timeoutSec: positive(raw.timeoutSec, 1800, 86400),
    graceSec: positive(raw.graceSec, 5, 60),
    requireMcpStartup: raw.requireMcpStartup === true,
  };
}
export function supportedVersion(output: string): boolean {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(output);
  // Validate new major versions explicitly before widening this protocol contract.
  return Boolean(match && Number(match[1]) === 2 && Number(match[2]) >= 24);
}
export function secretRedactor(env: NodeJS.ProcessEnv) {
  const values = Object.entries(env)
    .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && value)
    .flatMap(([, value]) => value ? [value, JSON.stringify(value).slice(1, -1)] : [])
    .sort((a, b) => b.length - a.length);
  return (input: string): string => values.reduce((out, value) => out.split(value).join("[REDACTED]"), input);
}
