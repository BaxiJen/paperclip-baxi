import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createServerAdapter } from "../src/index.js";
import { runProcess } from "../src/process.js";
vi.mock("../src/process.js", () => ({ runProcess: vi.fn() }));
const adapter = createServerAdapter();
let directory: string, ctx: AdapterExecutionContext;
const success = { exitCode: 0, signal: null, timedOut: false, cancelled: false, failed: false, stdout: "", stderr: "" };
beforeEach(async () => {
  vi.clearAllMocks(); directory = await mkdtemp(path.join(os.tmpdir(), "dsh-unit-")); vi.stubEnv("PAPERCLIP_HOME", directory);
  ctx = { runId: "run", agent: { id: "agent", companyId: "company", name: "Test", adapterType: "dsh_local", adapterConfig: { env: { DEEPSEEK_API_KEY: { type: "user_secret_ref", key: "provider-key" } } } },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task" },
    config: { model: "deepseek-flash", cwd: directory, env: { DEEPSEEK_API_KEY: "test-private-key", GH_TOKEN: "filtered", TMPDIR: "ignored" }, paperclipRuntimeSkills: [] },
    context: { taskId: "task", paperclipScratch: { dir: directory } }, authToken: "private-agent-jwt", onLog: vi.fn(async () => {}) };
  vi.mocked(runProcess).mockImplementation(async (_cmd, args, options) => {
    if (args.includes("--version")) return { ...success, stdout: "0.2.1-alpha.1" };
    expect(options.input).toContain("agent"); expect(args.join(" ")).not.toContain("test-private-key");
    expect(options.env.DEEPSEEK_API_KEY).toBe("test-private-key"); expect(options.env.GH_TOKEN).toBeUndefined(); expect(options.env.TMPDIR).toBe(directory);
    const yaml = await readFile(args[args.indexOf("--patch") + 1], "utf8"); expect(yaml).not.toContain("test-private-key");
    for (const event of [{ type: "session", sessionId: "session-test" }, { type: "status", phase: "turn_end", reason: { kind: "completed" } }, { type: "final", text: "test-private-key result" }]) await options.onStdoutLine?.(JSON.stringify(event));
    return success;
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
it("exercita execução/redação/overlay reais com transporte mockado", async () => {
  const result = await adapter.execute(ctx); expect(result.exitCode, result.errorMessage ?? "").toBe(0); expect(result.summary).toBe("[REDACTED] result");
  expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain("test-private-key");
});
it("retoma e reinicia somente em recusa antes do trabalho", async () => {
  const first = await adapter.execute(ctx); ctx.runtime.sessionParams = first.sessionParams ?? null;
  const normal = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (cmd, args, options) => {
    if (!args.includes("--session-id")) return normal(cmd, args, options);
    await options.onStdoutLine?.(JSON.stringify({ type: "error", message: 'session "session-test" does not exist; omit --session-id' }));
    return { ...success, exitCode: 1 };
  });
  const result = await adapter.execute(ctx); expect(result.exitCode).toBe(0); expect(result.clearSession).toBe(true);
  expect(vi.mocked(runProcess).mock.calls.filter(([, args]) => args.includes("--json"))).toHaveLength(3);
});
it.each(["company", "agent", "task", "model", "cwd"])("não retoma após mudar %s", async (change) => {
  ctx.runtime.sessionParams = (await adapter.execute(ctx)).sessionParams ?? null;
  if (change === "company") ctx.agent.companyId = "other-company";
  if (change === "agent") ctx.agent.id = "other-agent";
  if (change === "task") ctx.runtime.taskKey = "other-task";
  if (change === "model") ctx.config.model = "other-model";
  if (change === "cwd") ctx.config.cwd = await mkdtemp(path.join(directory, "cwd-"));
  await adapter.execute(ctx);
  expect(vi.mocked(runProcess).mock.calls.at(-1)?.[1]).not.toContain("--session-id");
});
it.each(["cancelled", "timedOut", "failed", "exit", "empty-final"])("propaga resultado de transporte %s", async (mode) => {
  const normal = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (cmd, args, options) => {
    if (args.includes("--version")) return normal(cmd, args, options);
    if (mode === "empty-final") {
      for (const event of [{ type: "session", sessionId: "session-test" }, { type: "status", phase: "turn_end", reason: { kind: "error", error: { code: "AUTH", message: "test-private-key" } } }, { type: "final", text: "" }]) await options.onStdoutLine?.(JSON.stringify(event));
    }
    return { ...success, ...(mode === "exit" || mode === "empty-final" ? { exitCode: 1 } : { [mode]: true }) };
  });
  const result = await adapter.execute(ctx); expect(result.exitCode).not.toBe(0); expect(JSON.stringify(result)).not.toContain("test-private-key");
  if (mode === "timedOut") expect(result.timedOut).toBe(true);
});
