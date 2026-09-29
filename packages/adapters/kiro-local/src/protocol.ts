import { record, text } from "./config.js";

export type TerminalResult = { ok: true; sessionId: string; finalText: string }
  | { ok: false; code: "kiro_run_error" | "kiro_invalid_output" | "kiro_missing_completion" };

/** Only terminal event shapes observed in Kiro issue 11069 are interpreted. */
export function parseTerminal(stdout: string): TerminalResult {
  let result: TerminalResult = { ok: false, code: "kiro_missing_completion" };
  let finished = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(line)); }
    catch {
      // V3 emits non-JSON diagnostics; malformed JSON records are not diagnostics.
      if (line.trimStart().startsWith("{")) return { ok: false, code: "kiro_invalid_output" };
      continue;
    }
    if (event.type === "runError") return { ok: false, code: "kiro_run_error" };
    if (event.type !== "runFinished") continue;
    const data = record(event.data);
    const sessionId = text(data.sessionId);
    if (finished || !/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId) || typeof data.finalText !== "string") {
      return { ok: false, code: "kiro_invalid_output" };
    }
    finished = true;
    result = { ok: true, sessionId, finalText: data.finalText };
  }
  return result;
}
