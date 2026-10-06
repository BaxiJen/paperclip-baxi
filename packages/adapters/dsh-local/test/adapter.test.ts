import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFile, chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createServerAdapter } from "../src/index.js";
import { agentRuntimeHome } from "../src/home.js";
import { runProcess } from "../src/process.js";
const adapter = createServerAdapter();
let directory: string, ctx: AdapterExecutionContext;
const secret = "fixture-key-never-persisted";
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "dsh-test-"));
  vi.stubEnv("PAPERCLIP_HOME", path.join(directory, "data"));
  const command = path.join(directory, "dsh.mjs");
  await copyFile(new URL("./fixtures/dsh.mjs", import.meta.url), command); await chmod(command, 0o700);
  ctx = { runId: "run-test", authToken: "jwt-fixture", agent: { id: "agent-test", companyId: "company-test", name: "Test", adapterType: "dsh_local", adapterConfig: { env: { DEEPSEEK_API_KEY: { type: "secret_ref", secretId: "secret-id" } } } },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-test" },
    config: { command, model: "deepseek-flash", cwd: directory, env: { DEEPSEEK_API_KEY: secret, NODE_OPTIONS: "ignored", GH_TOKEN: "ignored" }, paperclipRuntimeSkills: [] },
    context: { taskId: "task-test", paperclipWorkspace: { cwd: directory }, paperclipScratch: { dir: directory } },
    onLog: vi.fn(async () => {}), onSpawn: vi.fn(async () => {}), onCancellationReady: vi.fn(async () => {}), onDispatch: vi.fn() };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const mode = (value: string) => writeFile(path.join(directory, "mode"), value);
const invocation = async () => JSON.parse(await readFile(path.join(directory, "invocation.json"), "utf8"));
describe("CLI falso dsh", () => {
  it("usa stdin, isola DSH_HOME, publica linhas redigidas e limpa overlay", async () => {
    ctx.config.promptTemplate = "x".repeat(200000);
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0); expect(result.summary).toBe("Completo 🟢 [REDACTED]");
    expect(result.usageBasis).toBe("per_run"); expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 });
    expect(result.costUsd).toBeUndefined();
    const call = await invocation();
    expect(call.input.length).toBeGreaterThan(200000); expect(call.args.join(" ")).not.toContain("xxxx");
    expect(call.keyPresent).toBe(true); expect(call.jwtPresent).toBe(true);
    expect(call.temp).toBe(directory); expect(call.unrelated).toBeUndefined(); expect(call.nodeOptions).toBeUndefined();
    expect(call.home).toBe(agentRuntimeHome("company-test", "agent-test"));
    expect((await stat(call.home)).mode & 0o777).toBe(0o700);
    expect((await readdir(call.home)).filter((file) => file.endsWith(".yml"))).toEqual([]);
    expect(JSON.stringify(call)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain(secret);
    expect(vi.mocked(ctx.onLog).mock.calls.some(([, line]) => line.includes('"tool_call"'))).toBe(true);
    expect(ctx.onSpawn).toHaveBeenCalledOnce(); expect(ctx.onCancellationReady).toHaveBeenCalledOnce(); expect(ctx.onDispatch).toHaveBeenCalledOnce();
  });
  it("retoma no mesmo escopo e recusa reaproveitar em outra tarefa", async () => {
    ctx.runtime.sessionParams = (await adapter.execute(ctx)).sessionParams ?? null;
    expect((await adapter.execute(ctx)).exitCode).toBe(0); expect((await invocation()).args).toContain("--session-id");
    ctx.runtime.taskKey = "other-task";
    expect((await adapter.execute(ctx)).exitCode).toBe(0); expect((await invocation()).args).not.toContain("--session-id");
  });
  it("recusa de sessão inicia uma nova tentativa com aviso", async () => {
    ctx.runtime.sessionParams = (await adapter.execute(ctx)).sessionParams ?? null;
    await mode("resume-refused");
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0); expect(result.clearSession).toBe(true);
    expect((await invocation()).args).not.toContain("--session-id");
    expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).toContain("iniciando uma nova sessão");
    expect((await readFile(path.join(directory, "attempts"), "utf8")).trim().split("\n")).toHaveLength(3);
  });
  it.each(["error", "empty-fail", "malformed", "stderr", "flood", "old"])("falha seguramente em %s", async (value) => {
    await mode(value); const result = await adapter.execute(ctx);
    expect(result.exitCode).not.toBe(0); expect(result.errorCode).toBe(value === "old" ? "dsh_unsupported_version" : "dsh_run_failed"); expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain(secret);
  });
  it("cancela grupo e publica hooks antes de enviar prompt", async () => {
    await mode("hang"); const controller = new AbortController(); ctx.signal = controller.signal;
    ctx.onCancellationReady = async () => { controller.abort(); };
    const result = await adapter.execute(ctx); expect(result.errorCode).toBe("dsh_cancelled");
  });
  it("aplica timeout ao grupo", async () => {
    await mode("hang"); ctx.config.timeoutSec = 1; ctx.config.graceSec = 1;
    const result = await adapter.execute(ctx); expect(result.timedOut).toBe(true);
    const pid = Number(await readFile(path.join(directory, "child-pid"), "utf8"));
    // Linux may retain a reparented zombie briefly; it must not remain running.
    try { const status = await readFile(`/proc/${pid}/stat`, "utf8"); expect(status.split(") ")[1].startsWith("Z")).toBe(true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }, 10000);
  it("não cria home para execução remota ou chave ausente", async () => {
    const remote = await adapter.execute({ ...ctx, executionTransport: { remoteExecution: {} } } as AdapterExecutionContext);
    expect(remote.errorCode).toBe("dsh_local_only");
    ctx.config.env = {};
    expect((await adapter.execute(ctx)).errorCode).toBe("adapter_auth_missing");
  });
  it("aborto antecipado não cria subprocesso", async () => {
    const controller = new AbortController(); controller.abort(); const onSpawn = vi.fn();
    expect((await runProcess("missing", [], { cwd: directory, env: {}, timeoutSec: 1, graceSec: 1, signal: controller.signal, onSpawn })).cancelled).toBe(true);
    expect(onSpawn).not.toHaveBeenCalled();
  });
});
