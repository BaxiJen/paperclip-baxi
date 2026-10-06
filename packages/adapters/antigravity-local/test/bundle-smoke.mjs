import assert from "node:assert/strict";
import { copyFile, mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(path.join(os.tmpdir(), "antigravity-bundle-smoke-"));
const previousRoot = process.env.PAPERCLIP_HOME;
try {
  process.env.PAPERCLIP_HOME = path.join(dir, "data");
  for (const [source, target] of [["../dist/index.js", "adapter.mjs"], ["../dist/ui-parser.js", "ui-parser.mjs"], ["./fixtures/agy.mjs", "agy.mjs"], ["./fixtures/models.txt", "models.txt"]]) {
    await copyFile(new URL(source, import.meta.url), path.join(dir, target));
  }
  await chmod(path.join(dir, "agy.mjs"), 0o700);
  const module = await import(pathToFileURL(path.join(dir, "adapter.mjs")).href);
  const adapter = module.createServerAdapter();
  assert.equal(adapter.type, "antigravity_local");
  assert.equal(adapter.loginCapability, undefined);
  const parser = await import(pathToFileURL(path.join(dir, "ui-parser.mjs")).href);
  assert.equal(parser.parseStdoutLine("not json", "now")[0].kind, "stdout");
  const result = await adapter.execute({
    runId: "bundle-run", authToken: "fixture-only-jwt",
    agent: { id: "bundle-agent", companyId: "bundle-company", name: "Fixture", adapterType: adapter.type,
      adapterConfig: { env: { GEMINI_API_KEY: { type: "secret_ref", secretId: "fixture", version: "latest" } } } },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "bundle-task" },
    config: { command: path.join(dir, "agy.mjs"), cwd: dir, env: { GEMINI_API_KEY: "fixture-provider-secret" }, paperclipRuntimeSkills: [] },
    context: { taskId: "bundle-task", paperclipWorkspace: { cwd: dir } }, onLog: async () => {},
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.summary, "Olá 🟢 [REDACTED]");
  assert.equal(result.sessionId, "session-123");
  assert.ok(!(await readFile(path.join(dir, "adapter.mjs"), "utf8")).includes(process.cwd()));
  assert.doesNotMatch(await readFile(path.join(dir, "ui-parser.mjs"), "utf8"), /\b(?:import|require)\s*\(/);
  console.log("Standalone bundle: factory, execution, isolated HOME, session and browser parser passed.");
} finally {
  if (previousRoot === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousRoot;
  await rm(dir, { recursive: true, force: true });
}
