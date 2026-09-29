import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterModel, ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  buildPaperclipEnv, buildRuntimeToolsEnv, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  readPaperclipRuntimeSkillEntries, renderPaperclipWakePrompt, renderTemplate,
  selectPaperclipTaskMarkdown, refreshPaperclipWorkspaceEnvForExecution,
} from "@paperclipai/adapter-utils/server-utils";
import { parseConfig, parseExecutionConfig, record, secretRedactor, supportedVersion, text } from "./config.js";
import { runProcess } from "./process.js";
import { parseTerminal } from "./protocol.js";

export const type = "kiro_local";
export const label = "Kiro CLI (BaXiJen)";
export const models: AdapterModel[] = [];
export const agentConfigurationDoc = `# Kiro local
Requires Kiro CLI 2.24.x or newer within 2.x. Set kiroAgent to a reviewed custom agent.
Choose the model and tool boundary in that Kiro agent's configuration.
trustedTools adds explicit headless permissions; it is not an OS sandbox or a denial list.
Default trustedTools: read,grep. Never enables --trust-all-tools.
Set env.KIRO_API_KEY through a Paperclip secret_ref if needed. Login is operator-owned.
Only local execution is supported. Costs and token usage are unknown, not zero.
See the package README for setup, version evidence, and limitations.`;

function failure(code: string, timedOut = false): AdapterExecutionResult {
  return { exitCode: 1, signal: null, timedOut, errorCode: code,
    errorMessage: `Kiro adapter stopped (${code}). Check the named agent, CLI version, permissions, and authentication locally.`,
    provider: "kiro", billingType: "unknown" };
}
function localOnly(ctx: { executionTarget?: { kind: string } | null; executionTransport?: { remoteExecution?: unknown } }) {
  if (ctx.executionTarget?.kind === "remote" || ctx.executionTransport?.remoteExecution) {
    throw new Error("This adapter supports local execution only.");
  }
}
function environment(configEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z_]+|XDG_[A-Z_]+|KIRO_API_KEY|KIRO_HOME|AWS_PROFILE|AWS_REGION|AWS_DEFAULT_REGION|HTTPS?_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key)) {
      if (value !== undefined) env[key] = value;
    }
  }
  return { ...env, ...configEnv, CI: "1", NO_COLOR: "1", TERM: "dumb" };
}
async function readBounded(file: string) {
  if (!path.isAbsolute(file) || (await stat(file)).size > 512 * 1024) throw new Error("Invalid instructions file.");
  return readFile(file, "utf8");
}
async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  try {
    localOnly(ctx);
    const config = parseExecutionConfig(ctx.config, ctx.agent.adapterConfig);
    const workspace = record(ctx.context.paperclipWorkspace);
    const cwd = await realpath(text(workspace.cwd) || config.cwd);
    if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) return failure("kiro_invalid_cwd");
    const env = { ...environment(config.env), ...buildPaperclipEnv(ctx.agent), ...buildRuntimeToolsEnv(ctx.runtimeTools) };
    const scratch = text(record(ctx.context.paperclipScratch).dir);
    if (scratch && path.isAbsolute(scratch) && (await stat(scratch)).isDirectory()) {
      Object.assign(env, { TMPDIR: scratch, TMP: scratch, TEMP: scratch, PAPERCLIP_SCRATCH_DIR: scratch });
    }
    // Only a host-issued run-scoped JWT may identify this agent to Paperclip.
    if (!ctx.authToken) return failure("kiro_missing_agent_jwt");
    env.PAPERCLIP_API_KEY = ctx.authToken;
    env.PAPERCLIP_RUN_ID = ctx.runId;
    const taskId = text(ctx.context.taskId) || text(ctx.context.issueId);
    if (taskId) env.PAPERCLIP_TASK_ID = taskId;
    for (const [key, value] of Object.entries({
      PAPERCLIP_WAKE_REASON: ctx.context.wakeReason,
      PAPERCLIP_WAKE_COMMENT_ID: ctx.context.wakeCommentId,
    })) if (typeof value === "string") env[key] = value;
    refreshPaperclipWorkspaceEnvForExecution({
      env, workspaceCwd: cwd, executionCwd: cwd,
      workspaceSource: text(workspace.source), workspaceId: text(workspace.workspaceId),
      workspaceRepoUrl: text(workspace.repoUrl), workspaceRepoRef: text(workspace.repoRef),
      workspaceBranch: text(workspace.branch), workspaceWorktreePath: text(workspace.worktreePath),
      agentHome: text(workspace.agentHome),
    });
    const redact = secretRedactor(env);
    const probe = await runProcess(config.command, ["--version"], { cwd, env, timeoutSec: 10, graceSec: 1, signal: ctx.signal });
    if (probe.cancelled) return failure("kiro_cancelled");
    if (probe.failed || probe.exitCode !== 0 || !supportedVersion(probe.stdout)) return failure("kiro_unsupported_version");
    const scope = createHash("sha256").update(JSON.stringify({
      company: ctx.agent.companyId, agent: ctx.agent.id, task: ctx.runtime.taskKey ?? taskId,
      cwd, command: config.command, engine: config.engine, kiroAgent: config.agent,
      trustedTools: config.trustedTools, requireMcpStartup: config.requireMcpStartup,
      instructions: config.instructionsFilePath,
      profile: { home: env.HOME, kiroHome: env.KIRO_HOME, data: env.XDG_DATA_HOME, aws: env.AWS_PROFILE },
    })).digest("hex");
    const previous = record(ctx.runtime.sessionParams);
    const resumeId = previous.scope === scope ? text(previous.sessionId) : "";
    const args = ["chat", "--agent-engine", config.engine, "--no-interactive", "--output-format", "stream-json", "--agent", config.agent, `--trust-tools=${config.trustedTools}`];
    if (config.requireMcpStartup) args.push("--require-mcp-startup");
    if (resumeId) args.push("--resume-id", resumeId);
    const instructions = config.instructionsFilePath ? await readBounded(config.instructionsFilePath) : "";
    const entries = await readPaperclipRuntimeSkillEntries(ctx.config, path.dirname(fileURLToPath(import.meta.url)));
    const skills = await Promise.all(entries.map(async (entry) => {
      const file = path.join(entry.source, "SKILL.md");
      return `## Skill: ${entry.key}\nRelative references resolve from ${entry.source}.\n${await readBounded(file)}`;
    }));
    const task = selectPaperclipTaskMarkdown(ctx.context, { resumedSession: Boolean(resumeId) });
    const prompt = [
      instructions && `## Agent instructions\nRelative references resolve from ${path.dirname(config.instructionsFilePath)}.\n${instructions}`,
      ...skills,
      ctx.context.conversationMode === true ? "" : renderTemplate(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, { agent: ctx.agent, context: ctx.context }),
      renderPaperclipWakePrompt(ctx.context.paperclipWake, { resumedSession: Boolean(resumeId), suppressIssueDescription: Boolean(task), conversationMode: ctx.context.conversationMode === true }),
      task, text(ctx.context.paperclipSessionHandoffMarkdown), text(ctx.config.promptTemplate) && renderTemplate(text(ctx.config.promptTemplate), { agent: ctx.agent, context: ctx.context }),
      "Use PAPERCLIP_* environment variables for authenticated API calls. Never print credentials. API writes must include X-Paperclip-Run-Id from PAPERCLIP_RUN_ID.",
      ctx.runtimeTools?.guidance,
    ].filter(Boolean).join("\n\n");
    if (Buffer.byteLength(prompt) > 2 * 1024 * 1024) return failure("kiro_prompt_too_large");
    await ctx.onLog("stdout", "Kiro headless run started. Provider diagnostics are withheld to protect credentials.\n");
    const result = await runProcess(config.command, args, {
      cwd, env, input: prompt, timeoutSec: config.timeoutSec, graceSec: config.graceSec,
      signal: ctx.signal, onSpawn: ctx.onSpawn, onCancellationReady: ctx.onCancellationReady, onDispatch: ctx.onDispatch,
    });
    if (result.cancelled) return failure("kiro_cancelled");
    if (result.timedOut) return failure("kiro_timeout", true);
    if (result.failed || result.exitCode !== 0 || result.signal) return failure("kiro_process_failed");
    const terminal = parseTerminal(result.stdout);
    if (!terminal.ok) return failure(terminal.code);
    if (resumeId && terminal.sessionId !== resumeId) return { ...failure("kiro_session_mismatch"), clearSession: true };
    const summary = redact(terminal.finalText).slice(0, 16000);
    await ctx.onLog("stdout", "Kiro returned a valid completion record.\n");
    return {
      exitCode: 0, signal: null, timedOut: false, provider: "kiro", billingType: "unknown",
      sessionId: terminal.sessionId, sessionDisplayId: terminal.sessionId,
      sessionParams: { sessionId: terminal.sessionId, scope }, summary,
      resultJson: { summary, usageReported: false, costReported: false },
    };
  } catch { return failure("kiro_configuration_or_launch_failed"); }
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type, models, execute, supportsLocalAgentJwt: true, runtimeToolDelivery: "environment",
    supportsInstructionsBundle: true, requiresMaterializedRuntimeSkills: true,
    agentConfigurationDoc,
    sessionCodec: {
      deserialize(raw) {
        const value = record(raw);
        return /^[a-zA-Z0-9_-]{1,200}$/.test(text(value.sessionId)) && /^[a-f0-9]{64}$/.test(text(value.scope))
          ? { sessionId: value.sessionId, scope: value.scope } : null;
      },
      serialize(params) { return this.deserialize(params); },
      getDisplayId(params) { return text(params?.sessionId) || null; },
    },
    getConfigSchema: () => ({ fields: [
      { key: "command", label: "Kiro CLI command", type: "text", default: "kiro-cli" },
      { key: "kiroAgent", label: "Reviewed Kiro agent", type: "text", required: true, hint: "Set the model and available tools in this agent's Kiro configuration." },
      { key: "cwd", label: "Fallback working directory", type: "text", hint: "The assigned Paperclip workspace takes precedence." },
      { key: "engine", label: "Agent engine", type: "select", default: "v2", options: [{ value: "v2", label: "V2" }, { value: "v3", label: "V3" }] },
      { key: "trustedTools", label: "Trusted tool categories", type: "text", default: "read,grep", hint: "Explicit categories only. Review the named agent's permissions and MCP servers too." },
      { key: "timeoutSec", label: "Timeout (seconds)", type: "number", default: 1800 },
      { key: "requireMcpStartup", label: "Require configured MCP servers", type: "toggle", default: false },
    ] }),
    async testEnvironment(ctx) {
      const testedAt = new Date().toISOString();
      try {
        localOnly(ctx);
        const config = parseConfig(ctx.config);
        const cwd = await realpath(config.cwd || process.cwd());
        const result = await runProcess(config.command, ["--version"], { cwd, env: environment(config.env), timeoutSec: 10, graceSec: 1 });
        if (result.failed || result.exitCode !== 0 || !supportedVersion(result.stdout)) throw new Error("Unsupported version");
        return { adapterType: type, status: "warn", testedAt, checks: [
          { code: "kiro_version", level: "info", message: "Compatible Kiro 2.x executable found (2.24 or newer)." },
          { code: "kiro_auth_unverified", level: "warn", message: "Authentication, model access, agent permissions, and live execution still need an operator-run smoke test. This check does not start a login or use provider credits." },
        ] };
      } catch {
        return { adapterType: type, status: "fail", testedAt, checks: [{ code: "kiro_environment", level: "error", message: "Check local CLI 2.24+ within 2.x, cwd, and named agent configuration. No login was started." }] };
      }
    },
  };
}
