import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Import and execute the artifact outside the workspace and its dependency tree.
const dir = await mkdtemp(path.join(os.tmpdir(), "kiro-bundle-smoke-"));
try {
  await copyFile(new URL("../dist/index.js", import.meta.url), path.join(dir, "adapter.mjs"));
  const cli = path.join(dir, "kiro-fixture.mjs");
  await writeFile(cli, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('kiro-cli 2.25.0');
else {
  let input=''; for await (const chunk of process.stdin) input += chunk;
  if (!input.includes('bundle-agent') || !process.env.PAPERCLIP_API_KEY) process.exit(1);
  console.log(JSON.stringify({type:'runFinished',data:{sessionId:'bundle-session',finalText:'Bundle verified.'}}));
}
`, { mode: 0o700 });
  const module = await import(pathToFileURL(path.join(dir, "adapter.mjs")).href);
  const adapter = module.createServerAdapter();
  const result = await adapter.execute({
    runId: "bundle-run", authToken: "fixture-only-jwt",
    agent: { id: "bundle-agent", companyId: "bundle-company", name: "Fixture", adapterType: "kiro_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "bundle-task" },
    config: { command: cli, kiroAgent: "review", cwd: dir, paperclipRuntimeSkills: [] },
    context: { taskId: "bundle-task", paperclipWorkspace: { cwd: dir } },
    onLog: async () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, "Bundle verified.");
  assert.equal(result.sessionId, "bundle-session");
  // Ensure the bundle does not depend on absolute developer machine paths.
  assert.ok(!(await readFile(path.join(dir, "adapter.mjs"), "utf8")).includes(process.cwd()));
  console.log("Standalone bundle: factory, execution, context, and session passed.");
} finally { await rm(dir, { recursive: true, force: true }); }
