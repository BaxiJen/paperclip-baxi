import { describe, expect, it } from "vitest";
import { buildArgs, overlay, parseConfig, parseExecutionConfig, providers, secretRedactor, supportedNode } from "../src/config.js";
import { createProtocol, parseOutput, resumeRefused } from "../src/protocol.js";
import { parseStdoutLine } from "../src/ui-parser.js";
const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");
const start = { type: "session", sessionId: "session-test" };
const end = { type: "status", phase: "turn_end", reason: { kind: "completed" } };

describe("configuração dsh", () => {
  it("põe launcher antes dos argumentos do app e nunca passa prompt em argv", () => {
    expect(buildArgs("/tmp/overlay.yml")).toEqual(["--profile", "headless", "--patch", "/tmp/overlay.yml", "--json"]);
    expect(buildArgs("/tmp/overlay.yml", "session-id").slice(-2)).toEqual(["--session-id", "session-id"]);
  });
  it.each(Object.entries(providers))("gera rota %s sem valor de chave", (provider, p) => {
    const config = parseConfig({ provider, providerId: "my-api", baseURL: "https://example.test/v1", model: "model\"safe", env: { [p.key]: "secret-never-persisted" } });
    const yaml = overlay(config);
    expect(yaml).not.toContain("secret-never-persisted");
    const rows = JSON.parse(yaml);
    expect(rows[0].id).toBe(provider === "deepseek" ? "llm-deepseek" : "llm-pi-ai");
    const route = provider === "deepseek" ? rows[0].config : rows[0].config.providers[config.providerId];
    expect(route.apiKeyEnv).toBe(p.key);
    expect(rows[1].config).toMatchObject({ provider: config.providerId, model: 'model"safe' });
    if (provider === "custom") expect(route).toMatchObject({ api: "openai-completions", baseURL: "https://example.test/v1", models: [{ id: 'model"safe' }] });
  });
  it.each(["openai-completions", "openai-responses", "anthropic-messages"])("gera protocolo personalizado %s", (protocol) => {
    expect(overlay(parseConfig({ provider: "custom", providerId: "my-api", protocol, baseURL: "http://localhost:9000/v1", model: "local" }))).toContain(protocol);
  });
  it("recusa URL base de metadados/link-local e aceita gateway comum", () => {
    const base = { provider: "custom", providerId: "meu-gateway", protocol: "openai-completions", model: "m1" };
    for (const baseURL of ["http://169.254.169.254/latest", "http://[fe80::1]/v1", "http://metadata.google.internal/v1"]) {
      expect(() => parseConfig({ ...base, baseURL })).toThrow(/metadados|link-local/);
    }
    expect(parseConfig({ ...base, baseURL: "https://gateway.example/v1" }).baseURL).toBe("https://gateway.example/v1");
    expect(parseConfig({ ...base, baseURL: "http://127.0.0.1:11434/v1" }).baseURL).toBe("http://127.0.0.1:11434/v1");
  });
  it("aceita env enriquecido do host e rejeita nomes/configuração do operador", () => {
    const runtime = { model: "m", env: { DEEPSEEK_API_KEY: "resolved", NODE_OPTIONS: "ignored", PAPERCLIP_API_KEY: "ignored", OPENAI_API_KEY: "other" } };
    expect(parseExecutionConfig(runtime, { env: { DEEPSEEK_API_KEY: { type: "secret_ref", secretId: "s" } } }).env).toEqual({ DEEPSEEK_API_KEY: "resolved" });
    expect(() => parseExecutionConfig(runtime, { env: { NODE_OPTIONS: { type: "plain", value: "x" } } })).toThrow();
    expect(() => parseExecutionConfig(runtime, { env: { DEEPSEEK_API_KEY: "raw" } })).toThrow();
  });
  it.each(["https://user:password@example.test", "https://example.test?key=secret", "file:///tmp/api"])("recusa URL %s", (baseURL) => {
    expect(() => parseConfig({ provider: "custom", providerId: "my-api", baseURL, model: "m" })).toThrow();
  });
  it.each(["../escape", "DeepSeek", "deepseek-official", "constructor", ""])("recusa ID %s", (providerId) => {
    expect(() => parseConfig({ provider: "custom", providerId, baseURL: "https://example.test", model: "m" })).toThrow();
  });
  it("confere Node e redacta strings JSON escapadas", () => {
    for (const version of ["22.19.0", "24.0.0", "25.0.0"]) expect(supportedNode(version)).toBe(true);
    for (const version of ["22.18.0", "23.0.0", "20.19.0", "invalid"]) expect(supportedNode(version)).toBe(false);
    expect(secretRedactor({ KEY: 'a"b' })('a"b a\\"b')).toBe("[REDACTED] [REDACTED]");
  });
});
describe("NDJSON", () => {
  it("preserva final completo, mesmo quando text foi truncado", () => {
    const final = "a".repeat(40000);
    const result = parseOutput(jsonl(start, { type: "text", text: "a", truncated: true }, end, { type: "final", text: final }));
    expect(result.ok).toBe(true); expect(result.finalText).toBe(final);
  });
  it("falha em error sem final, final vazio com reason error, linha corrompida e terminal duplicado", () => {
    for (const output of [jsonl({ type: "error", message: "recusado" }), jsonl(start, { ...end, reason: { kind: "error" } }, { type: "final", text: "" }), jsonl(start) + "\n{bad", jsonl(start, end, { type: "final", text: "ok" }, { type: "final", text: "ok" })]) expect(parseOutput(output).ok).toBe(false);
  });
  it("acumula somente uso completo desta execução", () => {
    const parser = createProtocol(); parser.consume(JSON.stringify(start));
    const usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1 };
    for (let i = 0; i < 2; i++) parser.consume(JSON.stringify({ type: "status", phase: "step_end", usage }));
    expect(parser.result().usage).toEqual({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 });
    parser.consume(JSON.stringify({ type: "status", phase: "step_end" }));
    expect(parser.result().usage).toBeUndefined();
  });
  it("reconhece apenas recusas de retomada", () => {
    expect(resumeRefused('session "session-x" was recorded in "/one", not "/two"')).toBe(true);
    expect(resumeRefused('session "session-x" does not exist; omit --session-id')).toBe(true);
    expect(resumeRefused('session "session-x" runs under agent preset "foo"')).toBe(true);
    expect(resumeRefused("API authentication failed")).toBe(false);
  });
  it("renderiza transcript rico e campos truncados sem lançar", () => {
    expect(parseStdoutLine('{broken', 'now')[0].kind).toBe('stdout');
    expect(parseStdoutLine(JSON.stringify({ type: 'thinking', text: 'penso', truncated: true }), 'now')).toEqual([{ kind: 'thinking', ts: 'now', text: 'penso\n[Conteúdo truncado pelo dsh]' }]);
    expect(parseStdoutLine(JSON.stringify({ type: 'tool_call', tool: 'shell', callId: 'c', input: {} }), 'now')[0]).toMatchObject({ kind: 'tool_call', name: 'shell', toolUseId: 'c' });
    expect(parseStdoutLine(JSON.stringify({ type: 'tool_result', status: 'error', callId: 'c', result: 'erro' }), 'now')[0]).toMatchObject({ kind: 'tool_result', isError: true });
  });
});
