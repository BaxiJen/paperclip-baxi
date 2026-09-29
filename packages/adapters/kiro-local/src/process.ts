import { spawn } from "node:child_process";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  timedOut: boolean;
  cancelled: boolean;
  failed: boolean;
}

/** Bounded capture; provider stdout/stderr never go directly to host logs. */
export async function runProcess(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutSec: number; graceSec: number;
  signal?: AbortSignal; onSpawn?: AdapterExecutionContext["onSpawn"];
  onCancellationReady?: AdapterExecutionContext["onCancellationReady"];
  onDispatch?: AdapterExecutionContext["onDispatch"];
}): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return { exitCode: null, signal: null, stdout: "", timedOut: false, cancelled: true, failed: false };
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let bytes = 0;
    let timedOut = false;
    let cancelled = false;
    let failed = false;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (closed || child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { /* Process can exit before a cancellation reaches it. */ }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), options.graceSec * 1000);
    };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutSec * 1000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) { failed = true; stop(); return; }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { failed = true; stop(); }
    });
    child.stdin.on("error", () => { failed = true; stop(); });
    child.on("error", () => { failed = true; });
    child.once("spawn", () => {
      void (async () => {
        if (child.pid !== undefined) await options.onSpawn?.({
          pid: child.pid, processGroupId: process.platform === "win32" ? null : child.pid,
          startedAt: new Date().toISOString(),
        });
        await options.onCancellationReady?.();
        if (closed || cancelled || timedOut) { child.stdin.end(); return; }
        options.onDispatch?.();
        child.stdin.end(options.input ?? "");
      })().catch(() => { failed = true; stop(); });
    });
    child.once("close", (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode, signal, stdout, timedOut, cancelled, failed });
    });
  });
}
