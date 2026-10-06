import { record, text } from "./config.js";
export const validSessionId = (value: unknown): value is string => typeof value === "string" && /^session-[a-zA-Z0-9_-]{1,190}$/.test(value);

/** Incremental terminal validation, independent of the transcript's lossy projection. */
export function createProtocol() {
  let sessionId = "", finalText = "", reason = "", errorMessage = "";
  let invalid = false, final = false, turnEnded = false, workStarted = false;
  let inputTokens = 0, outputTokens = 0, cachedInputTokens = 0;
  let steps = 0, completeUsage = true, completeCache = true;
  function consume(line: string) {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(line)); } catch { invalid = true; return; }
    if (!text(event.type) || final) { invalid = true; return; }
    if (event.type === "error") { errorMessage = text(event.message) || "Erro do dsh fora do turno."; return; }
    if (event.type === "session") {
      if (sessionId || !validSessionId(event.sessionId) || event.truncated) invalid = true;
      else sessionId = event.sessionId;
      return;
    }
    if (!sessionId) invalid = true;
    if (event.type === "status") {
      if (event.phase === "turn_start" || event.phase === "step_start") workStarted = true;
      if (event.phase === "turn_end") {
        if (turnEnded) invalid = true;
        turnEnded = true;
        reason = text(record(event.reason).kind);
        if (reason === "error") {
          const error = record(record(event.reason).error);
          errorMessage = [text(error.code), text(error.message)].filter(Boolean).join(": ") || "Erro durante o turno.";
        }
      }
      if (event.phase === "step_end") {
        steps++;
        const usage = record(event.usage);
        const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
        if (!valid(usage.inputTokens) || !valid(usage.outputTokens)) completeUsage = false;
        else { inputTokens += usage.inputTokens; outputTokens += usage.outputTokens; }
        if (!valid(usage.cacheReadTokens)) completeCache = false;
        else cachedInputTokens += usage.cacheReadTokens;
      }
    }
    if (["text", "thinking", "tool_call", "tool_result"].includes(text(event.type))) workStarted = true;
    if (event.type === "final") {
      if (typeof event.text !== "string" || event.truncated || !turnEnded) invalid = true;
      final = true;
      finalText = text(event.text);
    }
  }
  return { consume, result() {
    return { sessionId, finalText, errorMessage, reason, invalid, workStarted,
      ok: !invalid && final && Boolean(sessionId) && reason === "completed" && !errorMessage,
      usage: steps > 0 && completeUsage ? { inputTokens, outputTokens, ...(completeCache ? { cachedInputTokens } : {}) } : undefined };
  } };
}
export function parseOutput(stdout: string) { const parser = createProtocol(); stdout.split(/\r?\n/).forEach(parser.consume); return parser.result(); }
export function resumeRefused(message: string) {
  return /session "[^"\r\n]+" (?:does not exist; omit --session-id|was recorded in |recorded no working directory|runs under agent preset )/.test(message);
}
