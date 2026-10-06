import assert from "node:assert/strict";
import { copyFile, chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-bundle-smoke-"));
const previous = process.env.PAPERCLIP_HOME;
try {
  process.env.PAPERCLIP_HOME = path.join(dir, "data");
  await copyFile(new URL("../dist/index.js", import.meta.url), path.join(dir, "adapter.mjs"));
  await copyFile(new URL("../dist/ui-parser.js", import.meta.url), path.join(dir, "ui-parser.mjs"));
  const cli = path.join(dir, "dsh.mjs");
  await copyFile(new URL("./fixtures/dsh.mjs", import.meta.url), cli); await chmod(cli, 0o700);
  const module = await import(pathToFileURL(path.join(dir, "adapter.mjs")).href);
  const adapter = module.createServerAdapter();
  const key = "fixture-bundle-secret";
  const result = await adapter.execute({ runId: "bundle-run", authToken: "fixture-jwt",
    agent: { id: "bundle-agent", companyId: "bundle-company", name: "Fixture", adapterType: "dsh_local", adapterConfig: { env: { DEEPSEEK_API_KEY: { type: "secret_ref", secretId: "fixture" } } } },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "bundle-task" },
    config: { command: cli, model: "deepseek-flash", cwd: dir, env: { DEEPSEEK_API_KEY: key }, paperclipRuntimeSkills: [] },
    context: { taskId: "bundle-task", paperclipWorkspace: { cwd: dir } }, onLog: async (_stream, line) => assert.ok(!line.includes(key)),
  });
  assert.equal(result.exitCode, 0, result.errorMessage);
  assert.equal(result.summary, "Completo 🟢 [REDACTED]"); assert.equal(result.sessionId, "session-fixture");
  const parser = await import(pathToFileURL(path.join(dir, "ui-parser.mjs")).href);
  assert.equal(parser.parseStdoutLine('{"type":"thinking","text":"ok"}', "now")[0].kind, "thinking");
  assert.ok(!(await readFile(path.join(dir, "adapter.mjs"), "utf8")).includes(process.cwd()));
  console.log("Standalone bundle: factory, execution, session, redaction and UI parser passed.");
} finally {
  if (previous === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previous;
  await rm(dir, { recursive: true, force: true });
}
