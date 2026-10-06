import { chmod, mkdir, lstat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { AdapterError, overlay, type DshConfig } from "./config.js";

export function agentRuntimeHome(companyId: string, agentId: string) {
  if (![companyId, agentId].every((id) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id))) throw new AdapterError("dsh_identity_invalid", "Identidade de empresa/agente inválida.");
  return path.join(resolvePaperclipInstanceRootForAdapter(), "adapter-homes", "dsh", companyId, agentId);
}
export async function prepareAgentHome(companyId: string, agentId: string) {
  const home = agentRuntimeHome(companyId, agentId);
  let directory = resolvePaperclipInstanceRootForAdapter();
  for (const segment of ["adapter-homes", "dsh", companyId, agentId]) {
    directory = path.join(directory, segment);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new AdapterError("dsh_home_invalid", "Diretório de runtime inseguro.");
    await chmod(directory, 0o700);
  }
  return home;
}
export async function writeOverlay(home: string, config: DshConfig) {
  const file = path.join(home, `paperclip-${randomUUID()}.yml`);
  await writeFile(file, overlay(config), { mode: 0o600, flag: "wx" });
  return file;
}
export function environment(home: string, configEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key) && value !== undefined) env[key] = value;
  }
  return { ...env, ...configEnv, DSH_HOME: home, CI: "1", NO_COLOR: "1", TERM: "dumb" };
}
