import type { TranscriptEntry } from "@paperclipai/adapter-utils";

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
export function createStdoutParser() {
  const calls = new Set<string>();
  const done = new Set<string>();
  let assistantSeen = false;
  function parseLine(line: string, ts: string): TranscriptEntry[] {
    if (!line.trim()) return [];
    try {
      const event = obj(JSON.parse(line));
      if (event.event === "init") return [{ kind: "init", ts, model: str(obj(event.init).model), sessionId: str(event.conversation_id) }];
      if (event.event === "step_update") {
        const step = obj(event.step_update);
        if (step.step_type === "agent_response" && str(step.text_delta)) {
          assistantSeen = true;
          return [{ kind: "assistant", ts, text: str(step.text_delta), delta: true }];
        }
        if (step.step_type === "tool") {
          const tool = obj(step.tool_info);
          const id = `${str(step.conversation_id)}:${step.step_index}`;
          const entries: TranscriptEntry[] = [];
          if (!calls.has(id)) {
            calls.add(id);
            entries.push({ kind: "tool_call", ts, toolUseId: id, name: str(tool.name) || str(step.tool_name) || "tool", input: tool.parameters ?? {} });
          }
          if (step.state === "DONE" && !done.has(id)) {
            done.add(id);
            entries.push({ kind: "tool_result", ts, toolUseId: id, content: str(tool.output) || str(obj(tool.error).message), isError: Boolean(tool.error) });
          }
          return entries;
        }
        return [];
      }
      if (event.event === "result") {
        const result = obj(event.result);
        const usage = obj(result.usage);
        const entries: TranscriptEntry[] = [];
        if (!assistantSeen && str(result.response)) entries.push({ kind: "assistant", ts, text: str(result.response) });
        // The legacy `result` transcript entry requires a numeric cost. Use a
        // system/stderr entry instead of falsely presenting unknown cost as $0.
        const tokens = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens"]
          .filter((key) => typeof usage[key] === "number").map((key) => `${key}: ${usage[key]}`).join(", ");
        entries.push({ kind: result.status === "SUCCESS" ? "system" : "stderr", ts,
          text: `${str(result.status)}${str(result.error) ? `: ${str(result.error)}` : ""}${tokens ? ` · ${tokens}` : ""} · custo não informado` });
        return entries;
      }
    } catch { /* Malformed output remains inspectable, never executable. */ }
    return [{ kind: "stdout", ts, text: line }];
  }
  return { parseLine, reset() { calls.clear(); done.clear(); assistantSeen = false; } };
}
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return createStdoutParser().parseLine(line, ts);
}
