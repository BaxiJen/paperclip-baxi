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
import { AdapterError, localOnly, parseExecutionConfig, record, secretRedactor, text } from "./config.js";
import { runProcess } from "./process.js";
import { authRequired, keyringFailure, parseTerminal, validSessionId } from "./protocol.js";
import { agentRuntimeHome, environment, manualLoginHint, prepareAgentHome } from "./home.js";
import { createAdapterDefinition } from "./definition.js";

export const type = "antigravity_local";
export const label = "Antigravity";
export const models: AdapterModel[] = [];
export const agentConfigurationDoc = `# Antigravity — Google Antigravity CLI
Plugin externo local. O binário agy é dependência externa (não instalado pelo plugin).
connectionMode: api_key (segredo GEMINI_API_KEY obrigatório) ou subscription (login manual no HOME do agente). Endpoint opcional para chave: baseUrl.
HOME exclusivo por empresa/agente em adapter-homes/antigravity no diretório da instância.
settings.json seleciona modelProvider=gemini no modo chave e remove só essa chave no modo assinatura.
Permissões só são ignoradas quando dangerouslySkipPermissions=true (padrão false).
Modelo e esforço opcionais; timeoutSec padrão 3600 (máximo 86400), graceSec padrão 5.
Assinatura usa conta já conectada na VPS; painel de login fica para após qualificação real.
Custo monetário desconhecido; tokens são contabilizados quando o CLI informa usage válido.`;

export function failure(code: string, timedOut = false, message?: string): AdapterExecutionResult {
  const messages: Record<string, string> = {
    adapter_auth_missing: "Conecte a conta ou configure a chave. Neste host, selecione um segredo GEMINI_API_KEY; assinatura exige qualificação manual.",
    antigravity_keyring_unavailable: "Keyring indisponível. No Linux configure D-Bus de sessão e Secret Service (GNOME Keyring/KWallet) desbloqueado para o usuário do serviço, ou use uma chave de API.",
    antigravity_timeout: "Antigravity excedeu o timeout do run; o grupo de processos foi encerrado.",
    antigravity_cancelled: "Execução do Antigravity cancelada.",
    antigravity_missing_completion: "Saída incompleta: agy encerrou sem resultado terminal.",
    antigravity_invalid_output: "Saída NDJSON inválida ou truncada; confira a versão do agy.",
    antigravity_status_waiting: "Antigravity terminou aguardando entrada. Revise as permissões para execução headless.",
    antigravity_status_running: "Antigravity terminou sem concluir o trabalho (RUNNING).",
    antigravity_process_failed: "Falha ao executar agy; confira binário, configuração e limites de saída.",
  };
  return { exitCode: 1, signal: null, timedOut, errorCode: code,
    errorMessage: message || messages[code] || `Antigravity interrompido (${code}). Confira a configuração e teste a conexão.`,
    provider: "google", billingType: "api" };
}
export function buildArgs(config: ReturnType<typeof parseExecutionConfig>, resumeId?: string) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", `${config.timeoutSec}s`];
  if (config.model) args.push("--model", config.model);
  if (config.effort) args.push("--effort", config.effort);
  if (resumeId) args.push("--conversation", resumeId);
  if (config.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (config.sandbox) args.push("--sandbox");
  return args;
}
async function readBounded(file: string) {
  if (!path.isAbsolute(file) || (await stat(file)).size > 512 * 1024) throw new Error("Invalid instructions file.");
  return readFile(file, "utf8");
}
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  try {
    localOnly(ctx);
    const config = parseExecutionConfig(ctx.config, ctx.agent.adapterConfig);
    const workspace = record(ctx.context.paperclipWorkspace);
    const cwd = await realpath(text(workspace.cwd) || config.cwd);
    if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) return failure("antigravity_invalid_cwd");
    const home = agentRuntimeHome(ctx.agent.companyId, ctx.agent.id);
    if (config.connectionMode === "api_key" && !config.env.GEMINI_API_KEY?.trim()) return failure("adapter_auth_missing", false,
      "Conecte a conta ou configure a chave. Selecione um segredo GEMINI_API_KEY. " + manualLoginHint(ctx.agent.companyId, config.command, ctx.agent.id));
    await prepareAgentHome(ctx.agent.companyId, ctx.agent.id, config.connectionMode);
    const env = { ...environment(home, config.env, config.connectionMode), ...buildPaperclipEnv(ctx.agent), ...buildRuntimeToolsEnv(ctx.runtimeTools) };
    const scratch = text(record(ctx.context.paperclipScratch).dir);
    if (scratch && path.isAbsolute(scratch) && (await stat(scratch)).isDirectory()) {
      Object.assign(env, { TMPDIR: scratch, TMP: scratch, TEMP: scratch, PAPERCLIP_SCRATCH_DIR: scratch });
    }
    // Only a host-issued run-scoped JWT may identify this agent to Paperclip.
    if (!ctx.authToken) return failure("antigravity_missing_agent_jwt");
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
    const scope = createHash("sha256").update(JSON.stringify({
      company: ctx.agent.companyId, agent: ctx.agent.id, task: ctx.runtime.taskKey ?? taskId,
      cwd, connectionMode: config.connectionMode, command: config.command, model: config.model, effort: config.effort,
      sandbox: config.sandbox, permissions: config.dangerouslySkipPermissions, endpoint: config.env.GOOGLE_GEMINI_BASE_URL,
      credentialBinding: record(ctx.agent.adapterConfig).env,
      instructions: config.instructionsFilePath,
      profile: { home: env.HOME },
    })).digest("hex");
    const previous = record(ctx.runtime.sessionParams);
    const resumeId = previous.scope === scope && validSessionId(previous.sessionId) ? previous.sessionId : "";
    const args = buildArgs(config, resumeId);
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
    if (Buffer.byteLength(prompt) > 2 * 1024 * 1024) return failure("antigravity_prompt_too_large");
    await ctx.onLog("stdout", "Antigravity: execução headless iniciada.\n");
    const result = await runProcess(config.command, args, {
      cwd, env, input: JSON.stringify({ event: "user", message: { content: prompt } }) + "\n", timeoutSec: config.timeoutSec, graceSec: config.graceSec,
      onStdoutLine: async (line) => {
        const safeLine = redact(line);
        let event: Record<string, unknown>;
        try { event = record(JSON.parse(safeLine)); } catch { return; }
        if (["init", "step_update", "result"].includes(text(event.event))) await ctx.onLog("stdout", safeLine + "\n");
      },
      signal: ctx.signal, onSpawn: ctx.onSpawn, onCancellationReady: ctx.onCancellationReady, onDispatch: ctx.onDispatch,
    });
    if (result.cancelled) return failure("antigravity_cancelled");
    if (result.timedOut) return failure("antigravity_timeout", true);
    const authFailure = () => failure("adapter_auth_missing", false, config.connectionMode === "subscription"
      ? manualLoginHint(ctx.agent.companyId, config.command, ctx.agent.id) : undefined);
    if (authRequired(result.stderr)) return authFailure();
    if (keyringFailure(result.stderr)) return failure("antigravity_keyring_unavailable");
    const terminal = parseTerminal(result.stdout);
    if (terminal.code === "adapter_auth_missing" || (!terminal.ok && authRequired(result.stdout))) return authFailure();
    if (result.failed) return failure("antigravity_process_failed");
    // The documented result describes this execution, not proven conversation totals.
    const accounting = { usage: terminal.usage, usageBasis: "per_run" as const, model: config.model || null,
      resultJson: terminal.terminal ? {
        status: ["SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"].includes(terminal.status) ? terminal.status : "UNKNOWN",
        durationSeconds: typeof terminal.terminal.duration_seconds === "number" ? terminal.terminal.duration_seconds : undefined,
        numTurns: typeof terminal.terminal.num_turns === "number" ? terminal.terminal.num_turns : undefined,
        usage: terminal.usage ? Object.fromEntries(["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"].map((key) => [key, record(terminal.terminal?.usage)[key]])) : undefined,
        costReported: false,
      } : undefined };
    if (!terminal.ok) return { ...failure(terminal.code!, false,
      terminal.code === "antigravity_status_error" && terminal.errorText
        ? `Antigravity retornou ERROR: ${redact(terminal.errorText).slice(0, 1000)}` : undefined), ...accounting };
    if (result.failed || result.exitCode !== 0 || result.signal) return { ...failure("antigravity_process_failed"), ...accounting };
    if (redact(terminal.sessionId) !== terminal.sessionId) return failure("antigravity_invalid_output");
    if (resumeId && terminal.sessionId !== resumeId) return { ...failure("antigravity_session_mismatch"), ...accounting, clearSession: true };
    const summary = redact(terminal.response).slice(0, 16000);
    return {
      exitCode: 0, signal: null, timedOut: false, provider: "google", billingType: config.connectionMode === "subscription" ? "subscription" : "api", ...accounting,
      sessionId: terminal.sessionId, sessionDisplayId: terminal.sessionId,
      sessionParams: { sessionId: terminal.sessionId, scope }, summary,
    };
  } catch (error) {
    return error instanceof AdapterError ? failure(error.code, false, error.message) : failure("antigravity_configuration_or_launch_failed");
  }
}

export function createServerAdapter(): ServerAdapterModule {
  return createAdapterDefinition({ type, models, execute, agentConfigurationDoc });
}
