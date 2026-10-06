import type { TranscriptEntry } from "@paperclipai/adapter-utils";
const text = (v: unknown) => typeof v === "string" ? v : "";
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  try {
    const event = JSON.parse(line);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error();
    const suffix = event.truncated ? "\n[Conteúdo truncado pelo dsh]" : "";
    switch (event.type) {
      case "session": return [{ kind: "system", ts, text: `Sessão ${text(event.sessionId)}` }];
      case "text": return [{ kind: "assistant", ts, text: text(event.text) + suffix }];
      case "thinking": return [{ kind: "thinking", ts, text: text(event.text) + suffix }];
      case "tool_call": return [{ kind: "tool_call", ts, name: text(event.tool) || "Ferramenta", toolUseId: text(event.callId), input: event.input ?? {} }, ...(suffix ? [{ kind: "system" as const, ts, text: suffix.trim() }] : [])];
      case "tool_result": return [{ kind: "tool_result", ts, toolUseId: text(event.callId), content: text(event.result) + suffix, isError: event.status === "error" }];
      case "final": return [{ kind: "assistant", ts, text: text(event.text) }];
      case "error": return [{ kind: "stderr", ts, text: text(event.message) + suffix }];
      case "status": return [{ kind: "system", ts, text: text(event.phase) + (event.reason ? `: ${text(event.reason.kind)}` : "") + suffix }];
    }
  } catch { /* Untrusted malformed output remains visible. */ }
  return [{ kind: "stdout", ts, text: line }];
}
