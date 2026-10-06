import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createServerAdapter } from "../src/index.js";
import { runProcess } from "../src/process.js";
import { agentRuntimeHome } from "../src/home.js";
import { secretRedactor } from "../src/config.js";

// Unit boundary only. adapter.test.ts separately runs the actual fixture CLI;
// those integration tests are deliberately never skipped in restricted runners.
vi.mock("../src/process.js", () => ({ runProcess: vi.fn() }));
const adapter = createServerAdapter();
let dir: string;
let ctx: AdapterExecutionContext;
const secret = "unit-secret-\"special";
const terminal = (status = "SUCCESS", id = "session-123") => JSON.stringify({ event: "result", result: {
  conversation_id: id, status, response: `hello ${secret}`, error: status === "ERROR" ? `error ${secret}` : undefined,
  duration_seconds: 1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 50, total_tokens: 120 },
} });
beforeEach(async () => {
  vi.clearAllMocks();
  dir = await mkdtemp(path.join(os.tmpdir(), "antigravity-unit-"));
  vi.stubEnv("PAPERCLIP_HOME", path.join(dir, "data"));
  vi.mocked(runProcess).mockResolvedValue({ stdout: terminal(), stderr: "", failed: false, timedOut: false, cancelled: false, exitCode: 0, signal: null });
  ctx = { runId: "run", authToken: "unit-jwt", agent: { id: "agent", companyId: "company", name: "Test", adapterType: adapter.type,
    adapterConfig: { env: { GEMINI_API_KEY: { type: "user_secret_ref", key: "google", version: "latest" } } } },
    config: { cwd: dir, env: { GEMINI_API_KEY: secret, GH_TOKEN: "host-only", TMPDIR: "/wrong" }, paperclipRuntimeSkills: [] },
    context: { taskId: "task", paperclipWorkspace: { cwd: dir }, paperclipScratch: { dir } },
    runtime: { taskKey: "task", sessionId: null, sessionParams: null, sessionDisplayId: null }, onLog: vi.fn(async () => {}) };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

it("constructs a complete host invocation with isolated HOME, resolved key only in env, and a large stdin prompt", async () => {
  ctx.config.promptTemplate = "p".repeat(200_000);
  const result = await adapter.execute(ctx);
  expect(result).toMatchObject({ exitCode: 0, summary: "hello [REDACTED]", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 } });
  const [command, args, options] = vi.mocked(runProcess).mock.calls[0];
  expect(command).toBe("agy"); expect(args).not.toContain(secret); expect(args.join(" ").length).toBeLessThan(200);
  expect(JSON.parse(options.input!).message.content).toContain(ctx.config.promptTemplate);
  expect(options.env).toMatchObject({ GEMINI_API_KEY: secret, PAPERCLIP_API_KEY: "unit-jwt", TMPDIR: dir, HOME: agentRuntimeHome("company", "agent") });
  expect(options.env.GH_TOKEN).toBeUndefined();
  const settings = await readFile(path.join(options.env.HOME!, ".gemini/antigravity-cli/settings.json"), "utf8");
  expect(JSON.parse(settings)).toEqual({ modelProvider: "gemini" });
  expect(settings).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain(JSON.stringify(secret).slice(1, -1));
  expect(result.resultJson?.usage).toMatchObject({ thinking_tokens: 10, total_tokens: 120 }); expect(result.costUsd).toBeUndefined();
});
it("changes scope on company/agent/task/cwd/config changes and resumes only a valid matching conversation", async () => {
  const first = await adapter.execute(ctx); ctx.runtime.sessionParams = first.sessionParams ?? null;
  await adapter.execute(ctx); expect(vi.mocked(runProcess).mock.lastCall?.[1]).toContain("--conversation");
  ctx.agent.companyId = "other-company"; await adapter.execute(ctx); expect(vi.mocked(runProcess).mock.lastCall?.[1]).not.toContain("--conversation");
  ctx.agent.companyId = "company"; ctx.agent.id = "other-agent"; await adapter.execute(ctx); expect(vi.mocked(runProcess).mock.lastCall?.[1]).not.toContain("--conversation");
  ctx.agent.id = "agent"; ctx.runtime.taskKey = "other-task"; await adapter.execute(ctx); expect(vi.mocked(runProcess).mock.lastCall?.[1]).not.toContain("--conversation");
  ctx.runtime.taskKey = "task"; ctx.config.sandbox = true; await adapter.execute(ctx); expect(vi.mocked(runProcess).mock.lastCall?.[1]).not.toContain("--conversation");
  ctx.config.sandbox = false;
  vi.mocked(runProcess).mockResolvedValueOnce({ stdout: terminal("SUCCESS", "other-id"), stderr: "", failed: false, timedOut: false, cancelled: false, exitCode: 0, signal: null });
  expect(await adapter.execute(ctx)).toMatchObject({ errorCode: "antigravity_session_mismatch", clearSession: true });
});
it("preserves user settings, instructions and API endpoint without storing credentials", async () => {
  await adapter.execute(ctx);
  const settings = path.join(agentRuntimeHome("company", "agent"), ".gemini/antigravity-cli/settings.json");
  await writeFile(settings, JSON.stringify({ permissions: { allow: ["command(git)"] }, theme: "dark" }));
  const instructions = path.join(dir, "AGENTS.md"); await writeFile(instructions, "Read the test fixture.");
  ctx.config.instructionsFilePath = instructions; ctx.config.baseUrl = "https://example.com/gemini";
  await adapter.execute(ctx);
  expect(JSON.parse(await readFile(settings, "utf8"))).toMatchObject({ modelProvider: "gemini", theme: "dark", permissions: { allow: ["command(git)"] } });
  expect(vi.mocked(runProcess).mock.lastCall?.[2].env.GOOGLE_GEMINI_BASE_URL).toBe("https://example.com/gemini");
  expect(vi.mocked(runProcess).mock.lastCall?.[2].input).toContain("Read the test fixture.");
});
it("diagnostic executes only free probes with resolved credentials and removes its disposable HOME", async () => {
  ctx.config.env = { GEMINI_API_KEY: secret };
  vi.mocked(runProcess).mockImplementation(async (_cmd, args) => ({ stdout: args[0] === "--version" ? "agy 1.2.6" : args[0] === "--help" ? "--input-format --print-timeout" : "gemini-test  Gemini Test", stderr: "", failed: false, timedOut: false, cancelled: false, exitCode: 0, signal: null }));
  const result = await adapter.testEnvironment({ companyId: "company", adapterType: adapter.type, config: ctx.config });
  expect(result.status).toBe("warn"); expect(result.checks.map((c) => c.code)).toContain("antigravity_auth_unverified");
  expect(vi.mocked(runProcess).mock.calls.map((c) => c[1])).toEqual([["--version"], ["--help"], ["models"]]);
  const home = vi.mocked(runProcess).mock.lastCall?.[2].env.HOME!;
  expect(await readdir(home).catch(() => null)).toBeNull();
});
it("maps a provider error without leaking its key and does not suppress usage", async () => {
  vi.mocked(runProcess).mockResolvedValueOnce({ stdout: terminal("ERROR"), stderr: "", failed: false, timedOut: false, cancelled: false, exitCode: 1, signal: null });
  expect(await adapter.execute(ctx)).toMatchObject({ errorCode: "antigravity_status_error", errorMessage: "Antigravity retornou ERROR: error [REDACTED]", usage: { outputTokens: 20 } });
  expect(secretRedactor({ GEMINI_API_KEY: secret })(JSON.stringify({ response: secret }))).toBe('{"response":"[REDACTED]"}');
  // Early auth exit can close stdin while a large prompt is still being sent.
  vi.mocked(runProcess).mockResolvedValueOnce({ stdout: "", stderr: "authentication required", failed: true, timedOut: false, cancelled: false, exitCode: 1, signal: null });
  expect((await adapter.execute(ctx)).errorCode).toBe("adapter_auth_missing");
});

it("uses per-run result usage even when resuming a conversation", async () => {
  const first = await adapter.execute(ctx);
  ctx.runtime.sessionParams = first.sessionParams ?? null;
  const second = await adapter.execute(ctx);
  expect(vi.mocked(runProcess).mock.lastCall?.[1]).toContain("--conversation");
  // Equal per-execution usage must not become a zero delta on the second run.
  expect(first.usageBasis).toBe("per_run");
  expect(second.usageBasis).toBe("per_run");
  expect(second.usage).toEqual(first.usage);
});
it("switches to subscription without a key, preserves settings and invalidates the key-mode session", async () => {
  ctx.runtime.sessionParams = (await adapter.execute(ctx)).sessionParams ?? null;
  const settings = path.join(agentRuntimeHome("company", "agent"), ".gemini/antigravity-cli/settings.json");
  await writeFile(settings, JSON.stringify({ modelProvider: "gemini", theme: "dark", permissions: { allow: [] } }));
  ctx.config.connectionMode = "subscription";
  ctx.config.env = {};
  ctx.agent.adapterConfig = {};
  const result = await adapter.execute(ctx);
  expect(result).toMatchObject({ exitCode: 0, billingType: "subscription" });
  expect(vi.mocked(runProcess).mock.lastCall?.[1]).not.toContain("--conversation");
  expect(vi.mocked(runProcess).mock.lastCall?.[2].env.GEMINI_API_KEY).toBeUndefined();
  expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ theme: "dark", permissions: { allow: [] } });
  for (const output of [{ stdout: "authentication required", stderr: "" }, { stdout: "", stderr: "not logged in" },
    { stdout: JSON.stringify({ event: "result", result: { status: "ERROR", error: "authentication required" } }), stderr: "" }]) {
    vi.mocked(runProcess).mockResolvedValueOnce({ ...output, failed: false, timedOut: false, cancelled: false, exitCode: 1, signal: null });
    const failure = await adapter.execute(ctx);
    expect(failure.errorCode).toBe("adapter_auth_missing");
    expect(failure.errorMessage).toContain(agentRuntimeHome("company", "agent"));
    expect(failure.errorMessage).not.toContain("retire");
  }
});
it("probes subscription in the persistent agent HOME, without inference or API credentials", async () => {
  vi.mocked(runProcess).mockImplementation(async (_cmd, args) => ({ stdout: args[0] === "--version" ? "agy 1.2.6" : args[0] === "--help" ? "--input-format --print-timeout" : "gemini-test  Gemini Test", stderr: "", failed: false, timedOut: false, cancelled: false, exitCode: 0, signal: null }));
  const config = { cwd: dir, connectionMode: "subscription", diagnosticAgentId: "agent", env: { GEMINI_API_KEY: secret } };
  const result = await adapter.testEnvironment({ companyId: "company", adapterType: adapter.type, config });
  expect(result.status).toBe("pass");
  expect(result.checks).toContainEqual(expect.objectContaining({ message: "Conta Google conectada; 1 modelos" }));
  expect(vi.mocked(runProcess).mock.calls.map((call) => call[1])).toEqual([["--version"], ["--help"], ["models"]]);
  const home = agentRuntimeHome("company", "agent");
  expect(vi.mocked(runProcess).mock.lastCall?.[2].env).toMatchObject({ HOME: home });
  expect(vi.mocked(runProcess).mock.lastCall?.[2].env.GEMINI_API_KEY).toBeUndefined();
  expect(JSON.parse(await readFile(path.join(home, ".gemini/antigravity-cli/settings.json"), "utf8"))).toEqual({});
  vi.mocked(runProcess).mockImplementation(async (_cmd, args) => ({ stdout: args[0] === "--version" ? "agy 1.2.6" : "--input-format --print-timeout", stderr: args[0] === "models" ? "not authenticated" : "", failed: false, timedOut: false, cancelled: false, exitCode: args[0] === "models" ? 1 : 0, signal: null }));
  const missing = await adapter.testEnvironment({ companyId: "company", adapterType: adapter.type, config });
  expect(missing.checks).toContainEqual(expect.objectContaining({ code: "adapter_auth_missing", hint: expect.stringContaining(home) }));
});
