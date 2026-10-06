import { mkdtemp, copyFile, chmod, readFile, writeFile, rm, readdir, lstat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildArgs, createServerAdapter } from "../src/index.js";
import { parseConfig } from "../src/config.js";
import { agentRuntimeHome, prepareHome } from "../src/home.js";
import { parseModels, parseTerminal } from "../src/protocol.js";
import { createStdoutParser } from "../src/ui-parser.js";

let directory: string;
let ctx: AdapterExecutionContext;
const adapter = createServerAdapter();
const key = "fixture-provider-secret";
const source = new URL("./fixtures/", import.meta.url);
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "agy-adapter-test-"));
  for (const name of ["agy.mjs", "models.txt"]) await copyFile(new URL(name, source), path.join(directory, name));
  await chmod(path.join(directory, "agy.mjs"), 0o700);
  vi.stubEnv("PAPERCLIP_HOME", path.join(directory, "data"));
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
  ctx = {
    runId: "run-test", authToken: "fixture-run-jwt",
    agent: { id: "agent-test", companyId: "company-test", name: "Test", adapterType: "antigravity_local", adapterConfig: { env: { GEMINI_API_KEY: { type: "secret_ref", secretId: "secret-id", version: "latest" } } } },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-test" },
    config: { cwd: directory, command: path.join(directory, "agy.mjs"), env: { GEMINI_API_KEY: key }, paperclipRuntimeSkills: [] },
    context: { taskId: "task-test", paperclipWorkspace: { cwd: directory }, paperclipScratch: { dir: directory } },
    onLog: vi.fn(async () => {}), onSpawn: vi.fn(async () => {}), onCancellationReady: vi.fn(async () => {}), onDispatch: vi.fn(),
  };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const mode = (value: string) => writeFile(path.join(directory, "mode"), value);
const invocation = async () => JSON.parse(await readFile(path.join(directory, "invocation.json"), "utf8"));
const diagnostic = () => adapter.testEnvironment({ companyId: ctx.agent.companyId, adapterType: adapter.type, config: ctx.config });

describe("external Antigravity adapter", () => {
  it("builds stdin-only commands, explicit timeout, optional model/effort/permissions and scoped resume", () => {
    expect(buildArgs(parseConfig({}))).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "3600s"]);
    const args = buildArgs(parseConfig({ model: "gemini-test", effort: "high", timeoutSec: 7200, dangerouslySkipPermissions: true, sandbox: true }), "session-1");
    expect(args).toEqual(expect.arrayContaining(["--model", "gemini-test", "--effort", "high", "--print-timeout", "7200s", "--conversation", "session-1", "--dangerously-skip-permissions", "--sandbox"]));
    expect(args).not.toContain("--continue"); expect(args).not.toContain("-c");
  });
  it("executes >128 KiB prompts via stdin, maps tokens once, and redacts fragmented secrets", async () => {
    ctx.config.promptTemplate = "long-prompt-" + "á".repeat(140 * 1024);
    const result = await adapter.execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Olá 🟢 [REDACTED]");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 });
    expect(result.usageBasis).toBe("per_run");
    expect(result.costUsd).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(vi.mocked(ctx.onLog).mock.calls)).not.toContain(key);
    const call = await invocation();
    expect(call.correctKey).toBe(true); expect(call.hasJwt).toBe(true);
    expect(JSON.parse(call.input)).toMatchObject({ event: "user", message: { content: expect.stringContaining("long-prompt-") } });
    expect(call.args.join(" ")).not.toContain("long-prompt-");
    expect(call.args.join(" ")).not.toContain(key);
    expect(ctx.onSpawn).toHaveBeenCalledOnce(); expect(ctx.onCancellationReady).toHaveBeenCalledOnce(); expect(ctx.onDispatch).toHaveBeenCalledOnce();
    async function inspectFiles(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await inspectFiles(file);
        else if (entry.name !== "agy.mjs") expect(await readFile(file, "utf8")).not.toContain(key);
      }
    }
    await inspectFiles(directory);
  });
  it("merges settings, isolates HOME by agent/company, and does not inherit auth or D-Bus", async () => {
    vi.stubEnv("GEMINI_API_KEY", "ambient-not-allowed"); vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "ambient-bus");
    const home = agentRuntimeHome(ctx.agent.companyId, ctx.agent.id);
    await prepareHome(home);
    const file = path.join(home, ".gemini/antigravity-cli/settings.json");
    await writeFile(file, JSON.stringify({ modelProvider: "old", permissions: { allow: ["read_file(*)"] }, theme: "dark" }));
    expect((await adapter.execute(ctx)).exitCode).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ modelProvider: "gemini", permissions: { allow: ["read_file(*)"] }, theme: "dark" });
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await invocation()).home).toBe(home); expect((await invocation()).dbus).toBeUndefined();
    ctx.agent.id = "second-agent"; await adapter.execute(ctx);
    expect((await invocation()).home).not.toBe(home);
    expect(agentRuntimeHome("second-company", "agent-test")).not.toBe(home);
  });
  it("does not overwrite invalid settings or follow settings symlinks", async () => {
    const home = agentRuntimeHome(ctx.agent.companyId, ctx.agent.id); await prepareHome(home);
    const file = path.join(home, ".gemini/antigravity-cli/settings.json");
    await writeFile(file, "{broken");
    expect((await adapter.execute(ctx)).errorCode).toBe("antigravity_settings_invalid");
    expect(await readFile(file, "utf8")).toBe("{broken");
    await rm(file); await symlink(path.join(directory, "models.txt"), file);
    expect((await adapter.execute(ctx)).errorCode).toBe("antigravity_settings_invalid");
  });
  it("accepts host-enriched env, uses scratch, reserves identity, rejects operator injection and plaintext keys", async () => {
    ctx.config.env = { GEMINI_API_KEY: key, TMPDIR: "/wrong", GH_TOKEN: "host-only", NODE_OPTIONS: "--invalid", PAPERCLIP_API_KEY: "wrong" };
    expect((await adapter.execute(ctx)).exitCode).toBe(0);
    expect(await invocation()).toMatchObject({ temp: directory, agent: "agent-test", task: "task-test" });
    expect((await invocation()).githubToken).toBeUndefined(); expect((await invocation()).nodeOptions).toBeUndefined();
    ctx.agent.adapterConfig = { env: { HOME: "/wrong" } };
    expect((await adapter.execute(ctx)).errorCode).toBe("antigravity_config_invalid");
    ctx.agent.adapterConfig = { env: { GEMINI_API_KEY: key } };
    expect((await adapter.execute(ctx)).errorCode).toBe("antigravity_secret_binding_required");
  });
  it("resumes only in the same scope, and clears a mismatched result session", async () => {
    ctx.runtime.sessionParams = (await adapter.execute(ctx)).sessionParams ?? null;
    expect((await adapter.execute(ctx)).exitCode).toBe(0); expect((await invocation()).args).toContain("--conversation");
    await mode("mismatch"); expect(await adapter.execute(ctx)).toMatchObject({ errorCode: "antigravity_session_mismatch", clearSession: true });
    ctx.runtime.taskKey = "task-2"; await adapter.execute(ctx); expect((await invocation()).args).not.toContain("--conversation");
    ctx.runtime.taskKey = "task-test"; ctx.config.model = "another-model"; await adapter.execute(ctx); expect((await invocation()).args).not.toContain("--conversation");
  });
  it.each([["auth", "adapter_auth_missing"], ["keyring", "antigravity_keyring_unavailable"], ["error", "antigravity_status_error"], ["truncated", "antigravity_invalid_output"], ["exit", "antigravity_process_failed"], ["flood", "antigravity_process_failed"]])("fails safely for %s", async (value, code) => {
    await mode(value); const result = await adapter.execute(ctx); expect(result.errorCode).toBe(code); expect(result.exitCode).not.toBe(0); expect(JSON.stringify(result)).not.toContain(key);
  });
  it("times out and kills the whole process group", async () => {
    await mode("descendant"); ctx.config.timeoutSec = 0.4; ctx.config.graceSec = 0.05;
    expect((await adapter.execute(ctx)).timedOut).toBe(true);
    const pid = Number(await readFile(path.join(directory, "descendant.pid"), "utf8"));
    const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    expect(status === "" || /^\d+ \(.*\) Z /.test(status)).toBe(true);
  });
  it("cancels after spawn, and refuses remote runs or absent host JWT", async () => {
    const controller = new AbortController(); ctx.signal = controller.signal; ctx.onSpawn = async () => controller.abort();
    expect((await adapter.execute(ctx)).errorCode).toBe("antigravity_cancelled");
    ctx.signal = undefined; ctx.executionTransport = { remoteExecution: { kind: "ssh" } };
    expect((await adapter.execute(ctx)).errorCode).toBe("antigravity_local_only");
    ctx.executionTransport = undefined; ctx.authToken = undefined;
    expect((await adapter.execute(ctx)).errorCode).toBe("antigravity_missing_agent_jwt");
  });
  it("requires a key, supplies manual login instructions, and never exposes a broken login panel", async () => {
    ctx.config.env = {}; expect(adapter.loginCapability).toBeUndefined();
    expect(await adapter.execute(ctx)).toMatchObject({ errorCode: "adapter_auth_missing", errorMessage: expect.stringContaining(agentRuntimeHome(ctx.agent.companyId, ctx.agent.id)) });
    const result = await diagnostic(); expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "adapter_auth_missing", hint: expect.stringContaining("SSH_CONNECTION=") })]));
  });
  it("probes version, help and models only, cleans temporary HOME and does not claim paid auth proof", async () => {
    const result = await diagnostic(); expect(result.status).toBe("warn");
    expect(result.checks.map((c) => c.code)).toContain("antigravity_auth_unverified");
    const probes = (await readFile(path.join(directory, "probes.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(probes.map((p) => p.args)).toEqual([["--version"], ["--help"], ["models"]]);
    expect(await lstat(probes[0].home).catch(() => null)).toBeNull();
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it.each([["version", "antigravity_binary_invalid"], ["old", "antigravity_cli_incompatible"], ["auth", "adapter_auth_missing"], ["keyring", "antigravity_keyring_unavailable"], ["empty-models", "antigravity_models_invalid"]])("diagnoses %s without inference", async (value, code) => {
    await mode(value); expect((await diagnostic()).checks.map((c) => c.code)).toContain(code);
  });
  it("lists models via the host callback without borrowing server credentials; cannot infer an unmarked default", async () => {
    await symlink(path.join(directory, "agy.mjs"), path.join(directory, "agy"));
    vi.stubEnv("PATH", `${directory}:${process.env.PATH}`); vi.stubEnv("GEMINI_API_KEY", key);
    expect(await adapter.listModels?.()).toHaveLength(8); expect(await adapter.detectModel?.()).toBeNull();
    const probes = await readFile(path.join(directory, "probes.jsonl"), "utf8"); expect(probes).toContain('"correctKey":false');
  });
  it("uses external registration contract, Portuguese schema, and scoped codec", () => {
    expect(adapter).toMatchObject({ type: "antigravity_local", supportsLocalAgentJwt: true, runtimeToolDelivery: "environment" });
    expect(adapter.getConfigSchema?.().fields).toEqual(expect.arrayContaining([expect.objectContaining({ key: "connectionMode", group: "Conexão" })]));
    const state = { sessionId: "session-1", scope: "a".repeat(64) };
    expect(adapter.sessionCodec?.deserialize(adapter.sessionCodec.serialize(state))).toEqual(state);
    expect(adapter.sessionCodec?.deserialize({ sessionId: "--continue", scope: "bad" })).toBeNull();
    expect(() => parseConfig({ effort: "ultra" })).toThrow(); expect(() => parseConfig({ timeoutSec: 0 })).toThrow();
  });
});

describe("documented NDJSON/model fixtures and transcript", () => {
  it("parses documented nested result, counting terminal usage once", async () => {
    const parsed = parseTerminal(await readFile(new URL("success.ndjson", source), "utf8"));
    expect(parsed.ok).toBe(true); expect(parsed.usage).toEqual({ inputTokens: 10418, outputTokens: 589, cachedInputTokens: 8113 });
    const models = await readFile(new URL("models.txt", source), "utf8");
    expect(parseModels("Available models:\n\x1b[32m" + models + "\x1b[0m\nnoise")).toHaveLength(8);
  });
  it.each(["ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"])("never marks %s successful", (status) => {
    expect(parseTerminal(JSON.stringify({ event: "result", result: { status, error: "failed" } })).ok).toBe(false);
  });
  it("rejects corrupt/truncated/duplicate output and recognizes auth", () => {
    const terminal = JSON.stringify({ event: "result", result: { status: "SUCCESS", conversation_id: "session-1", response: "ok" } });
    for (const output of ["", '{"event":"init"}', "{broken\n" + terminal, terminal + "\n{", terminal + "\n" + terminal]) expect(parseTerminal(output).ok).toBe(false);
    expect(parseTerminal('{"event":"result","result":{"status":"ERROR","error":"authentication required"}}').code).toBe("adapter_auth_missing");
  });
  it("renders tools, text deltas and terminal status without repeating the response or fabricating cost", () => {
    const parser = createStdoutParser(); const ts = "now";
    const event = (step: object) => JSON.stringify({ event: "step_update", step_update: { conversation_id: "session", step_index: 1, step_type: "tool", tool_name: "run_command", ...step } });
    expect(parser.parseLine(event({ state: "ACTIVE" }), ts)[0].kind).toBe("tool_call");
    expect(parser.parseLine(event({ state: "DONE", tool_info: { output: "done" } }), ts).map((e) => e.kind)).toEqual(["tool_result"]);
    expect(parser.parseLine(event({ step_type: "agent_response", text_delta: "hello" }), ts)[0]).toMatchObject({ kind: "assistant", delta: true });
    expect(parser.parseLine('{"event":"result","result":{"status":"SUCCESS","response":"hello"}}', ts).map((e) => e.kind)).toEqual(["system"]);
    expect(parser.parseLine("{corrupt", ts)[0].kind).toBe("stdout"); parser.reset();
    expect(parser.parseLine('{"event":"result","result":{"status":"SUCCESS","response":"hello"}}', ts)[0].kind).toBe("assistant");
  });
});

it("streams complete redacted events before the CLI can finish", async () => {
  await mode("live");
  let completed = false;
  const events: string[] = [];
  ctx.onLog = async (_stream, line) => {
    if (!line.startsWith("{")) return;
    events.push(JSON.parse(line).event);
    expect(line).not.toContain(key);
    if (JSON.parse(line).event === "step_update") {
      expect(completed).toBe(false);
      expect(line).toContain("[REDACTED]");
      await writeFile(path.join(directory, "log-received"), "ok");
    }
  };
  const result = await adapter.execute(ctx);
  completed = true;
  expect(result.exitCode).toBe(0);
  expect(events).toEqual(["init", "step_update", "result"]);
});
