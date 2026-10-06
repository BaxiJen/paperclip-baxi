import { createHash } from "node:crypto";
import { readFile, realpath, stat, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterModel, ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  buildPaperclipEnv, buildRuntimeToolsEnv, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  readPaperclipRuntimeSkillEntries, renderPaperclipWakePrompt, renderTemplate,
  selectPaperclipTaskMarkdown, refreshPaperclipWorkspaceEnvForExecution,
} from "@paperclipai/adapter-utils/server-utils";
import { AdapterError, buildArgs, overlay, parseExecutionConfig, record, secretRedactor, supportedVersion, text } from "./config.js";
import { runProcess } from "./process.js";
import { createProtocol, resumeRefused, validSessionId } from "./protocol.js";
import { createAdapterDefinition } from "./definition.js";
import { prepareAgentHome, writeOverlay, environment } from "./home.js";
import { localOnly } from "./config.js";

export const type = "dsh_local";
export const label = "DeepSeek Harness (dsh)";
export const models: AdapterModel[] = [];
export const agentConfigurationDoc = `# dsh_local
Use para executar o CLI dsh 0.2.1-alpha.1 no host local. Não use para OAuth ou execução remota.
Escolha provider (deepseek, anthropic, openai, moonshotai, zai, custom), model e reasoningEffort opcional.
custom exige providerId permanente, baseURL e protocol (openai-completions, openai-responses ou anthropic-messages).
Chaves somente por secret_ref/user_secret_ref em env: DEEPSEEK_API_KEY, ANTHROPIC_API_KEY,
OPENAI_API_KEY, MOONSHOT_API_KEY, ZAI_API_KEY ou DSH_CUSTOM_API_KEY. O host resolve os valores.
command padrão dsh; cwd é fallback do workspace; timeoutSec 1800, graceSec 5.
DSH_HOME isolado por empresa/agente; overlay por run sem chaves. Prompt por stdin.
Teste de ambiente usa apenas versão/Node e GET de modelos. Não faz inferência.
instructionsFilePath e promptTemplate são opcionais. Skills e contexto vêm do host.
Sessões são vinculadas ao escopo de empresa/agente/tarefa/cwd/config. Custos não reportados são desconhecidos.`;

function failure(code: string, message = "Confira configuração, permissões, binário e autenticação do dsh.", timedOut = false): AdapterExecutionResult {
  return { exitCode: 1, signal: null, timedOut, errorCode: code, errorMessage: message, billingType: "unknown" };
}
async function readBounded(file: string) {
  if (!path.isAbsolute(file) || (await stat(file)).size > 512 * 1024) throw new Error("Invalid instructions file.");
  return readFile(file, "utf8");
}
async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  let patch: string | undefined;
  let redact = secretRedactor(record(ctx.config.env) as NodeJS.ProcessEnv);
  try {
    localOnly(ctx);
    const config = parseExecutionConfig(ctx.config, ctx.agent.adapterConfig);
    const workspace = record(ctx.context.paperclipWorkspace);
    const cwd = await realpath(text(workspace.cwd) || config.cwd);
    if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) return failure("dsh_invalid_cwd");
    if (!config.env[config.key]?.trim()) return failure("adapter_auth_missing", `Selecione/crie um segredo para ${config.key}.`);
    const home = await prepareAgentHome(ctx.agent.companyId, ctx.agent.id);
    const env = { ...environment(home, config.env), ...buildPaperclipEnv(ctx.agent), ...buildRuntimeToolsEnv(ctx.runtimeTools) };
    const scratch = text(record(ctx.context.paperclipScratch).dir);
    if (scratch && path.isAbsolute(scratch) && (await stat(scratch)).isDirectory()) {
      Object.assign(env, { TMPDIR: scratch, TMP: scratch, TEMP: scratch, PAPERCLIP_SCRATCH_DIR: scratch });
    }
    // Only a host-issued run-scoped JWT may identify this agent to Paperclip.
    if (!ctx.authToken) return failure("dsh_missing_agent_jwt");
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
    redact = secretRedactor(env);
    const probe = await runProcess(config.command, ["--version"], { cwd, env, timeoutSec: 10, graceSec: 1, signal: ctx.signal });
    if (probe.cancelled) return failure("dsh_cancelled");
    if (probe.failed || probe.timedOut || probe.signal || probe.exitCode !== 0 || !supportedVersion(probe.stdout)) return failure("dsh_unsupported_version");
    const scope = createHash("sha256").update(JSON.stringify({
      company: ctx.agent.companyId, agent: ctx.agent.id, task: ctx.runtime.taskKey ?? taskId,
      cwd, home, command: config.command, profile: "headless", overlay: overlay(config),
      instructions: config.instructionsFilePath, prompt: text(ctx.config.promptTemplate),
      credentialBindings: record(ctx.agent.adapterConfig).env,
    })).digest("hex");
    const previous = record(ctx.runtime.sessionParams);
    const resumeId = previous.scope === scope && validSessionId(previous.sessionId) ? previous.sessionId : "";
    patch = await writeOverlay(home, config);
    const instructions = config.instructionsFilePath ? await readBounded(config.instructionsFilePath) : "";
    const entries = await readPaperclipRuntimeSkillEntries(ctx.config, path.dirname(fileURLToPath(import.meta.url)));
    const skills = await Promise.all(entries.map(async (entry) => {
      const file = path.join(entry.source, "SKILL.md");
      return `## Skill: ${entry.key}\nRelative references resolve from ${entry.source}.\n${await readBounded(file)}`;
    }));
    const makePrompt = (resumedSession: boolean) => {
    const task = selectPaperclipTaskMarkdown(ctx.context, { resumedSession });
    return [
      instructions && `## Agent instructions\nRelative references resolve from ${path.dirname(config.instructionsFilePath)}.\n${instructions}`,
      ...skills,
      ctx.context.conversationMode === true ? "" : renderTemplate(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, { agent: ctx.agent, context: ctx.context }),
      renderPaperclipWakePrompt(ctx.context.paperclipWake, { resumedSession, suppressIssueDescription: Boolean(task), conversationMode: ctx.context.conversationMode === true }),
      task, text(ctx.context.paperclipSessionHandoffMarkdown), text(ctx.config.promptTemplate) && renderTemplate(text(ctx.config.promptTemplate), { agent: ctx.agent, context: ctx.context }),
      "Use PAPERCLIP_* environment variables for authenticated API calls. Never print credentials. API writes must include X-Paperclip-Run-Id from PAPERCLIP_RUN_ID.",
      ctx.runtimeTools?.guidance,
    ].filter(Boolean).join("\n\n");
    };
    const prompt = makePrompt(Boolean(resumeId));
    if (Buffer.byteLength(prompt) > 2 * 1024 * 1024) return failure("dsh_prompt_too_large");
    const attempt = async (session: string) => {
      const parser = createProtocol();
      const input = makePrompt(Boolean(session));
      if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new AdapterError("dsh_prompt_too_large", "Prompt excedeu o limite de 2 MiB.");
      const result = await runProcess(config.command, buildArgs(patch!, session), {
        cwd, env, input, timeoutSec: config.timeoutSec, graceSec: config.graceSec,
        signal: ctx.signal, onSpawn: ctx.onSpawn, onCancellationReady: ctx.onCancellationReady, onDispatch: ctx.onDispatch,
        onStdoutLine: async (line) => { parser.consume(line); await ctx.onLog("stdout", redact(line) + "\n"); },
      });
      return { result, terminal: parser.result() };
    };
    let current = await attempt(resumeId);
    let clearSession = Boolean(previous.sessionId && !resumeId);
    if (resumeId && !current.result.cancelled && !current.result.timedOut && !current.result.failed
      && current.result.exitCode !== 0 && !current.terminal.workStarted && !current.terminal.sessionId
      && !current.terminal.invalid && resumeRefused(current.terminal.errorMessage || current.result.stderr)) {
      await ctx.onLog("stderr", "A sessão anterior foi recusada pelo dsh; iniciando uma nova sessão com o contexto completo.\n");
      clearSession = true;
      current = await attempt("");
    }
    const { result, terminal } = current;
    if (result.cancelled) return { ...failure("dsh_cancelled", "Execução cancelada; processo e filhos foram encerrados."), clearSession };
    if (result.timedOut) return { ...failure("dsh_timeout", "Tempo limite excedido; processo e filhos foram encerrados.", true), clearSession };
    if (result.failed || result.exitCode !== 0 || result.signal || !terminal.ok) {
      const detail = terminal.errorMessage || result.stderr.split(/\r?\n/).find((line) => line.startsWith("dsh:")) || (terminal.invalid ? "NDJSON inválido." : `Turno não concluído (${terminal.reason || "sem final"}).`);
      return { ...failure("dsh_run_failed", `Falha no dsh: ${redact(detail).slice(0, 2000)}`), signal: result.signal, clearSession };
    }
    if (resumeId && !clearSession && terminal.sessionId !== resumeId) return { ...failure("dsh_session_mismatch", "dsh retornou uma sessão diferente da solicitada."), clearSession: true };
    const summary = redact(terminal.finalText);
    return { exitCode: 0, signal: null, timedOut: false, provider: config.providerId, model: config.model, billingType: "unknown",
      sessionId: terminal.sessionId, sessionDisplayId: terminal.sessionId,
      sessionParams: { sessionId: terminal.sessionId, scope }, clearSession,
      summary, resultJson: { summary, usageReported: Boolean(terminal.usage), costReported: false },
      ...(terminal.usage ? { usage: terminal.usage, usageBasis: "per_run" as const } : {}),
    };
  } catch (error) {
    return failure(error instanceof AdapterError ? error.code : "dsh_configuration_or_launch_failed",
      error instanceof AdapterError ? redact(error.message) : "Falha de configuração ou inicialização. Confira diretório de trabalho, permissões, segredos e binário dsh.");
  } finally { if (patch) await rm(patch, { force: true }); }
}
export function createServerAdapter(): ServerAdapterModule {
  return createAdapterDefinition({ type, models, execute, agentConfigurationDoc });
}
