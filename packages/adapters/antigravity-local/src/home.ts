import { chmod, mkdir, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { AdapterError, record } from "./config.js";

export function agentRuntimeHome(companyId: string, agentId: string): string {
  if (![companyId, agentId].every((id) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id))) {
    throw new AdapterError("antigravity_identity_invalid", "Identidade de empresa/agente inválida.");
  }
  return path.join(resolvePaperclipInstanceRootForAdapter(), "adapter-homes", "antigravity", companyId, agentId);
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Unsafe runtime directory");
  await chmod(directory, 0o700);
}
export async function prepareAgentHome(companyId: string, agentId: string, connectionMode = "api_key"): Promise<string> {
  const home = agentRuntimeHome(companyId, agentId);
  let directory = resolvePaperclipInstanceRootForAdapter();
  for (const segment of ["adapter-homes", "antigravity", companyId, agentId]) {
    directory = path.join(directory, segment);
    await privateDirectory(directory);
  }
  await prepareHome(home, connectionMode);
  return home;
}
/** Store provider selection, never the API key. Atomic merge preserves other settings. */
export async function prepareHome(home: string, connectionMode = "api_key"): Promise<void> {
  await privateDirectory(home);
  await privateDirectory(path.join(home, ".gemini"));
  const directory = path.join(home, ".gemini", "antigravity-cli");
  await privateDirectory(directory);
  const file = path.join(directory, "settings.json");
  let previous: Record<string, unknown> = {};
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("Unsafe settings file");
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Invalid settings");
    previous = record(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AdapterError("antigravity_settings_invalid", "settings.json inválido ou inseguro no HOME isolado; corrija o arquivo sem remover suas outras configurações.");
    }
  }
  if (connectionMode === "subscription") delete previous.modelProvider;
  else previous.modelProvider = "gemini";
  const temporary = path.join(directory, `.settings-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(previous, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
export function environment(home: string, configEnv: Record<string, string>, connectionMode = "api_key"): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key) && value !== undefined) env[key] = value;
  }
  // Subscription credentials may require the service user's session bus.
  if (connectionMode === "subscription" && process.env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  return { ...env, ...configEnv, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_CACHE_HOME: path.join(home, ".cache"),
    CI: "1", NO_COLOR: "1", TERM: "dumb" };
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function manualLoginHint(companyId: string, command: string, agentId?: string): string {
  const home = agentRuntimeHome(companyId, agentId || "ID_DO_AGENTE");
  const invocation = `env -u GEMINI_API_KEY -u GOOGLE_GEMINI_BASE_URL HOME=${quote(home)} XDG_CONFIG_HOME=${quote(path.join(home, ".config"))} XDG_DATA_HOME=${quote(path.join(home, ".local", "share"))} XDG_CACHE_HOME=${quote(path.join(home, ".cache"))} SSH_CONNECTION='127.0.0.1 1 127.0.0.1 22' ${quote(command)}`;
  return `Execute UMA vez na VPS, com o usuário do serviço, após selecionar assinatura e preparar o HOME pelo teste de conexão ou execução. ${agentId ? "" : "Substitua ID_DO_AGENTE pelo ID real do agente salvo. "}Login:
${invocation}
Abra a URL em outro computador e cole o código no terminal. Depois confira:
${invocation} models
No Linux configure D-Bus de sessão e Secret Service (GNOME Keyring ou KWallet), ativo e desbloqueado para o usuário systemd. HOME não isola o keyring do SO; valide esse isolamento na VPS.`;
}
