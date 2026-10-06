import { record, text } from "./config.js";

export const validSessionId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value);
export const authRequired = (output: string) => /authentication required|not authenticated|not logged in|(?:api.?key|credential).*(?:missing|invalid|required)|GEMINI_API_KEY.*not set|unauthorized/i.test(output);
export const keyringFailure = (output: string) => /keyring|secret.?service|dbus|d-bus|keychain/i.test(output);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parseUsage(value: unknown) {
  const usage = record(value);
  if (!["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"].every((key) => count(usage[key]))) return undefined;
  // output_tokens already includes thinking; never add it a second time.
  return { inputTokens: usage.input_tokens as number, outputTokens: usage.output_tokens as number,
    cachedInputTokens: usage.cache_read_tokens as number };
}
export function parseTerminal(stdout: string) {
  let terminal: Record<string, unknown> | undefined;
  let initId: string | undefined;
  let invalid = false;
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(line)); } catch { invalid = true; continue; }
    if (terminal) invalid = true;
    if (event.event === "init") {
      if (initId || !validSessionId(event.conversation_id)) invalid = true;
      else initId = event.conversation_id;
    }
    if (event.event === "result") {
      if (terminal) invalid = true;
      terminal = record(event.result);
    }
    if (["init", "step_update", "result"].includes(text(event.event))) events.push(event);
  }
  const usage = parseUsage(terminal?.usage);
  const status = text(terminal?.status);
  const sessionId = text(terminal?.conversation_id);
  const errorText = text(terminal?.error);
  const code = invalid ? "antigravity_invalid_output"
    : !terminal ? "antigravity_missing_completion"
    : authRequired(errorText) ? "adapter_auth_missing"
    : status !== "SUCCESS" ? ( ["ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"].includes(status) ? `antigravity_status_${status.toLowerCase()}` : "antigravity_invalid_output")
    : !validSessionId(sessionId) || typeof terminal.response !== "string" || (initId && initId !== sessionId) ? "antigravity_invalid_output"
    : null;
  return { ok: code === null, code, status, sessionId, response: text(terminal?.response), errorText, usage, terminal, events };
}

/** Documented `agy models`: slug, whitespace, display name; no invented JSON flag. */
export function parseModels(output: string) {
  const models = new Map<string, { id: string; label: string }>();
  for (const raw of output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/)) {
    const match = /^\s*([a-z][a-z0-9._:/]*-[a-z0-9._:/-]+)\s+([^\r\n]+?)\s*$/.exec(raw);
    if (match && match[1].length <= 200 && match[2].length <= 200) models.set(match[1], { id: match[1], label: match[2] });
  }
  return [...models.values()];
}
