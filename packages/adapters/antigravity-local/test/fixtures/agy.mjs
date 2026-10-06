#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const directory = path.dirname(fileURLToPath(import.meta.url));
const mode = fs.existsSync(path.join(directory, "mode")) ? fs.readFileSync(path.join(directory, "mode"), "utf8") : "success";
const args = process.argv.slice(2);
const record = { args, home: process.env.HOME, data: process.env.XDG_DATA_HOME,
  temp: process.env.TMPDIR, agent: process.env.PAPERCLIP_AGENT_ID, task: process.env.PAPERCLIP_TASK_ID,
  correctKey: process.env.GEMINI_API_KEY === "fixture-provider-secret", hasJwt: Boolean(process.env.PAPERCLIP_API_KEY),
  unrelated: process.env.UNRELATED_TEST_SECRET, nodeOptions: process.env.NODE_OPTIONS,
  githubToken: process.env.GH_TOKEN, dbus: process.env.DBUS_SESSION_BUS_ADDRESS };
fs.appendFileSync(path.join(directory, "probes.jsonl"), JSON.stringify(record) + "\n");
if (args.includes("--version")) console.log(mode === "version" ? "unknown" : "agy version 1.2.6");
else if (args.includes("--help")) {
  // Real agy 1.2.x prints its usage to stderr (Go flag) and exits 0.
  const usage = mode === "old" ? "--print" : "--input-format --output-format --print-timeout";
  (mode === "help-stdout" ? console.log : console.error)(usage);
}
else if (args.includes("models")) {
  if (mode === "auth") { console.error("authentication required"); process.exitCode = 1; }
  else if (mode === "keyring") { console.error("secret-service keyring is locked"); process.exitCode = 1; }
  else if (mode === "empty-models") console.log("unrecognized response");
  else console.log(fs.readFileSync(path.join(directory, "models.txt"), "utf8"));
} else {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  // Never persist actual provider/JWT values in test artifacts either.
  fs.writeFileSync(path.join(directory, "invocation.json"), JSON.stringify({ ...record, input }));
  if (mode === "hang" || mode === "descendant") {
    process.on("SIGTERM", () => {});
    if (mode === "descendant") {
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
      fs.writeFileSync(path.join(directory, "descendant.pid"), String(child.pid));
    }
    setInterval(() => {}, 1000);
  } else if (mode === "auth") { console.error("authentication required " + process.env.GEMINI_API_KEY); process.exitCode = 1; }
  else if (mode === "keyring") { console.error("keyring locked"); process.exitCode = 1; }
  else if (mode === "flood") process.stdout.write("x".repeat(5 * 1024 * 1024));
  else if (mode === "truncated") console.log('{"event":"result"');
  else {
    const sessionId = mode === "mismatch" ? "another-session" : "session-123";
    console.log(JSON.stringify({ event: "init", conversation_id: sessionId, init: { model: "fixture-model" } }));
    if (mode === "live") {
      const line = JSON.stringify({ event: "step_update", step_update: { text_delta: process.env.GEMINI_API_KEY } }) + "\n";
      const split = line.indexOf(process.env.GEMINI_API_KEY) + 8;
      process.stdout.write(line.slice(0, split));
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.stdout.write(line.slice(split));
      // The test must receive the redacted step before allowing completion.
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(path.join(directory, "log-received")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      if (!fs.existsSync(path.join(directory, "log-received"))) process.exitCode = 7;
    }
    const status = mode === "error" ? "ERROR" : "SUCCESS";
    const result = { event: "result", result: { conversation_id: sessionId, status,
      response: "Olá 🟢 " + (process.env.GEMINI_API_KEY || ""), error: status === "ERROR" ? "failure " + process.env.GEMINI_API_KEY : undefined,
      duration_seconds: 1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 50, total_tokens: 120 } } };
    const bytes = Buffer.from(JSON.stringify(result) + "\n");
    for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
    if (mode === "exit") process.exitCode = 2;
  }
}
