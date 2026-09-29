import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createServerAdapter } from "../src/index.js";
import { parseConfig, supportedVersion } from "../src/config.js";
import { parseTerminal } from "../src/protocol.js";
import { runProcess } from "../src/process.js";

// Fixture protocol is based on CLI output in kirodotdev/Kiro#11069.
// This subprocess makes no provider calls and performs no authentication.
const fixture = `#!/usr/bin/env node
import fs from 'node:fs';
const mode = fs.readFileSync('mode', 'utf8');
if (process.argv.includes('--version')) {
  console.log(mode === 'old' ? 'kiro-cli 2.19.2' : 'kiro-cli 2.25.0');
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  fs.writeFileSync('invocation.json', JSON.stringify({
    args: process.argv.slice(2), input,
    agent: process.env.PAPERCLIP_AGENT_ID, task: process.env.PAPERCLIP_TASK_ID,
    jwt: process.env.PAPERCLIP_API_KEY, cwd: process.env.PAPERCLIP_WORKSPACE_CWD,
    unrelated: process.env.UNRELATED_TEST_SECRET,
  }));
  if (mode === 'hang') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  } else if (mode === 'error') {
    console.log(JSON.stringify({type:'runError',data:{sessionId:null,stage:'engine',message:process.env.KIRO_API_KEY}}));
  } else if (mode === 'empty') {
    console.log('not a completion');
  } else if (mode === 'exit') {
    console.error(process.env.KIRO_API_KEY); process.exitCode = 5;
  } else if (mode === 'flood') {
    process.stdout.write('x'.repeat(5 * 1024 * 1024));
  } else {
    const id = mode === 'mismatch' ? 'another-session' : 'session-123';
    const data = Buffer.from(JSON.stringify({type:'runFinished',data:{sessionId:id,finalText:'Olá 🟢 ' + process.env.KIRO_API_KEY}})+'\\n');
    // Deliberately split UTF-8 and secret text across writes.
    for (const byte of data) process.stdout.write(Buffer.from([byte]));
  }
}
`;
let directory: string;
let ctx: AdapterExecutionContext;
const adapter = createServerAdapter();
const testSecret = "fixture-value-for-redaction";
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "kiro-adapter-test-"));
  await writeFile(path.join(directory, "kiro-fixture.mjs"), fixture, { mode: 0o700 });
  await writeFile(path.join(directory, "mode"), "success");
  ctx = {
    runId: "run-test", agent: { id: "agent-test", companyId: "company-test", name: "Test", adapterType: "kiro_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-test" },
    config: { command: path.join(directory, "kiro-fixture.mjs"), cwd: directory, kiroAgent: "review", env: { KIRO_API_KEY: testSecret }, paperclipRuntimeSkills: [] },
    context: { taskId: "task-test", paperclipWorkspace: { cwd: directory } },
    authToken: "fixture-agent-jwt", onLog: vi.fn(async () => {}), onSpawn: vi.fn(async () => {}),
  };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
async function mode(value: string) { await writeFile(path.join(directory, "mode"), value); }

describe("Kiro external adapter", () => {
  it("passes context via stdin, reserves agent identity, and redacts fragmented output", async () => {
    vi.stubEnv("PAPERCLIP_API_KEY", "unrelated-board-credential");
    vi.stubEnv("UNRELATED_TEST_SECRET", "not-for-child");
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Olá 🟢 [REDACTED]");
    expect(result.costUsd).toBeUndefined();
    expect(result.usage).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(testSecret);
    expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain(testSecret);
    const invocation = JSON.parse(await readFile(path.join(directory, "invocation.json"), "utf8"));
    expect(invocation.args).toContain("--no-interactive");
    expect(invocation.args).toContain("--trust-tools=read,grep");
    expect(invocation.args).not.toContain("--trust-all-tools");
    expect(invocation.args.join(" ")).not.toContain("You are agent");
    expect(invocation.input).toContain("agent-test");
    expect(invocation.jwt).toBe("fixture-agent-jwt");
    expect(invocation.agent).toBe("agent-test");
    expect(invocation.cwd).toBe(await realpath(directory));
    expect(invocation.unrelated).toBeUndefined();
    expect(ctx.onSpawn).toHaveBeenCalledOnce();
  });
  it("resumes only within the same task and validates the returned session", async () => {
    const first = await adapter.execute(ctx);
    ctx.runtime.sessionParams = first.sessionParams ?? null;
    const resumed = await adapter.execute(ctx);
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(await readFile(path.join(directory, "invocation.json"), "utf8")).args).toContain("--resume-id");
    await mode("mismatch");
    const mismatch = await adapter.execute(ctx);
    expect(mismatch.errorCode).toBe("kiro_session_mismatch");
    expect(mismatch.clearSession).toBe(true);
    ctx.runtime.taskKey = "another-task";
    expect((await adapter.execute(ctx)).exitCode).toBe(0);
    expect(JSON.parse(await readFile(path.join(directory, "invocation.json"), "utf8")).args).not.toContain("--resume-id");
  });
  it.each([ ["old", "kiro_unsupported_version"], ["error", "kiro_run_error"], ["empty", "kiro_missing_completion"], ["exit", "kiro_process_failed"], ["flood", "kiro_process_failed"] ])("fails safely for %s", async (value, code) => {
    await mode(value);
    const result = await adapter.execute(ctx);
    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe(code);
    expect(JSON.stringify(result)).not.toContain(testSecret);
  });
  it("kills an unresponsive subprocess after a finite timeout", async () => {
    await mode("hang");
    ctx.config.timeoutSec = 0.15;
    ctx.config.graceSec = 0.05;
    expect((await adapter.execute(ctx)).timedOut).toBe(true);
  });
  it("cancels after spawn and never reports success", async () => {
    await mode("hang");
    const controller = new AbortController();
    ctx.signal = controller.signal;
    ctx.onSpawn = async () => { controller.abort(); };
    expect((await adapter.execute(ctx)).errorCode).toBe("kiro_cancelled");
  });
  it("does not launch without a host agent JWT or for a remote target", async () => {
    ctx.authToken = undefined;
    expect((await adapter.execute(ctx)).errorCode).toBe("kiro_missing_agent_jwt");
    ctx.executionTransport = { remoteExecution: { kind: "ssh" } };
    expect((await adapter.execute(ctx)).errorCode).toBe("kiro_configuration_or_launch_failed");
    expect(ctx.onSpawn).not.toHaveBeenCalled();
  });
  it("uses workspace cwd before fallback and prepends instruction content", async () => {
    const instructions = path.join(directory, "AGENTS.md");
    await writeFile(instructions, "Review carefully.");
    ctx.config.instructionsFilePath = instructions;
    ctx.config.cwd = "/nonexistent-fallback";
    expect((await adapter.execute(ctx)).exitCode).toBe(0);
    const invocation = JSON.parse(await readFile(path.join(directory, "invocation.json"), "utf8"));
    expect(invocation.input).toContain("Review carefully.");
  });
  it("diagnostics do not claim authenticated readiness", async () => {
    const result = await adapter.testEnvironment({ companyId: "test", adapterType: "kiro_local", config: ctx.config });
    expect(result.status).toBe("warn");
    expect(result.checks.map((c) => c.code)).toContain("kiro_auth_unverified");
  });
  it("rejects unsupported config, command injection via tool names, and malformed session state", () => {
    for (const update of [{ trustedTools: "*" }, { trustedTools: "read;echo bad" }, { env: { PAPERCLIP_API_KEY: "bad" } }, { timeoutSec: 0 }, { engine: "v1" }, { model: "unproven-model-flag" }]) {
      expect(() => parseConfig({ ...ctx.config, ...update })).toThrow();
    }
    expect(adapter.sessionCodec?.deserialize({ sessionId: "--bad", scope: "invalid" })).toBeNull();
    expect(supportedVersion("kiro-cli 3.0.0")).toBe(false);
  });
  it("reports an absent executable without exposing process errors", async () => {
    const result = await runProcess(path.join(directory, "missing"), [], { cwd: directory, env: {}, timeoutSec: 1, graceSec: 0.1 });
    expect(result.failed).toBe(true);
  });
});

describe("terminal event parser", () => {
  const finished = JSON.stringify({ type: "runFinished", data: { sessionId: "session-1", finalText: "done" } });
  it("accepts V3 diagnostics around the terminal record", () => {
    expect(parseTerminal(`[INFO] starting\n${finished}\n[INFO] stopped`).ok).toBe(true);
  });
  it.each(["", "{truncated", '{"type":"runInterrupted"}', '{"type":"runFinished","data":{}}']) ("rejects missing or malformed completion %s", (output) => {
    expect(parseTerminal(output).ok).toBe(false);
  });
  it("rejects duplicate completions and errors after completion", () => {
    expect(parseTerminal(`${finished}\n${finished}`).ok).toBe(false);
    expect(parseTerminal(`${finished}\n{"type":"runError","data":{}}`).ok).toBe(false);
  });
});
