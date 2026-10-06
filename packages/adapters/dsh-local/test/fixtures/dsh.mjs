#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const mode = (() => { try { return readFileSync('mode', 'utf8'); } catch { return 'success'; } })();
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
if (process.argv.includes('--version')) {
  console.log(mode === 'old' ? '0.1.0' : '0.2.1-alpha.1');
} else {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const args = process.argv.slice(2);
  const patch = readFileSync(args[args.indexOf('--patch') + 1], 'utf8');
  const key = process.env.DEEPSEEK_API_KEY;
  // Record only presence, never persist credentials (even in fixtures).
  writeFileSync('invocation.json', JSON.stringify({ args, input, patch,
    home: process.env.DSH_HOME, keyPresent: Boolean(key), jwtPresent: Boolean(process.env.PAPERCLIP_API_KEY),
    agent: process.env.PAPERCLIP_AGENT_ID, task: process.env.PAPERCLIP_TASK_ID,
    temp: process.env.TMPDIR, unrelated: process.env.GH_TOKEN, nodeOptions: process.env.NODE_OPTIONS,
  }));
  appendFileSync('attempts', JSON.stringify(args) + '\n');
  if (mode === 'resume-refused' && args.includes('--session-id')) {
    emit({ type: 'error', message: 'session "session-fixture" does not exist; omit --session-id to start a new Session' }); process.exitCode = 1;
  } else if (mode === 'error') {
    emit({ type: 'error', message: 'MISSING_CREDENTIAL: ' + key }); process.exitCode = 1;
  } else if (mode === 'stderr') {
    console.error('dsh: QUOTA: ' + key); process.exitCode = 1;
  } else if (mode === 'flood') {
    process.stdout.write('x'.repeat(5 * 1024 * 1024));
  } else if (mode === 'hang') {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync('child-pid', String(child.pid));
    process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
  } else {
    emit({ type: 'session', sessionId: 'session-fixture', cwd: process.cwd() });
    emit({ type: 'status', phase: 'turn_start', turn: 1 });
    const fragment = Buffer.from(JSON.stringify({ type: 'text', text: 'Olá 🟢 ' + key }) + '\n');
    for (const byte of fragment) process.stdout.write(Buffer.from([byte]));
    emit({ type: 'tool_call', callId: 'call-1', tool: 'shell', input: { command: 'pwd' } });
    emit({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'fixture' });
    emit({ type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 } });
    if (mode === 'malformed') process.stdout.write('{broken\n');
    emit({ type: 'status', phase: 'turn_end', reason: { kind: mode === 'empty-fail' ? 'error' : 'completed', error: { code: 'AUTH', message: 'recusado' } } });
    emit({ type: 'final', text: mode === 'empty-fail' ? '' : 'Completo 🟢 ' + key });
    if (mode === 'empty-fail') process.exitCode = 1;
  }
}
