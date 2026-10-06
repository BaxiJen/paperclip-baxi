import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { listProviderModels, testEnvironment } from "../src/definition.js";
import { runProcess } from "../src/process.js";
vi.mock("../src/process.js", () => ({ runProcess: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
describe("listagem sem inferência", () => {
  it.each(["deepseek", "anthropic", "openai", "moonshotai", "zai", "custom"])("consulta %s com chave somente no header", async (provider) => {
    const config = parseConfig({ provider, providerId: "my-api", baseURL: "https://example.test/v1", model: "m" });
    config.env[config.key] = "fixture-key";
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m" }, { id: "m" }, { id: "n" }] })));
    expect(await listProviderModels(config, fetcher)).toEqual(["m", "n"]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("fixture-key"); expect(init.method).toBe("GET"); expect(init.redirect).toBe("error");
    expect(init.headers).toEqual(provider === "anthropic" ? { "x-api-key": "fixture-key", "anthropic-version": "2023-06-01" } : { Authorization: "Bearer fixture-key" });
    expect(url).toBe(provider === "anthropic" ? "https://api.anthropic.com/v1/models?limit=1000" : config.baseURL + "/models");
  });
  it("normaliza v1 para Anthropic custom e aceita mapa de modelos", async () => {
    const config = parseConfig({ provider: "custom", providerId: "my-api", protocol: "anthropic-messages", baseURL: "https://example.test/v1", model: "m", env: { DSH_CUSTOM_API_KEY: "key" } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: { m: { id: "alias" }, ignored: false } })));
    expect(await listProviderModels(config, fetcher)).toEqual(["m"]);
    expect(fetcher.mock.calls[0][0]).toBe("https://example.test/v1/models?limit=1000");
  });
  it.each([401, 403, 500])("não expõe corpo de erro HTTP %s", async (status) => {
    const config = parseConfig({ model: "m", env: { DEEPSEEK_API_KEY: "secret" } });
    await expect(listProviderModels(config, async () => new Response("secret", { status }))).rejects.toMatchObject({ code: status === 500 ? "dsh_models_failed" : "adapter_auth_missing" });
  });
  it("retorna adapter_auth_missing sem consulta quando falta chave", async () => {
    const fetcher = vi.fn();
    await expect(listProviderModels(parseConfig({ model: "m" }), fetcher)).rejects.toMatchObject({ code: "adapter_auth_missing" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("testa Node, versão e GET, nunca envia um prompt", async () => {
    vi.mocked(runProcess).mockImplementation(async (command) => ({ stdout: command === "node" ? "v24.11.0" : "0.2.1-alpha.1", stderr: "", exitCode: 0, signal: null, timedOut: false, failed: false, cancelled: false }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m" }] })));
    vi.stubGlobal("fetch", fetcher);
    const result = await testEnvironment({ companyId: "c", adapterType: "dsh_local", config: { model: "m", env: { DEEPSEEK_API_KEY: "key" } } });
    expect(result.status).toBe("pass"); expect(result.checks.at(-1)?.message).toContain("Conectado a DeepSeek");
    expect(vi.mocked(runProcess).mock.calls.every(([, args, options]) => args.join() === "--version" && !options.input)).toBe(true);
    const missing = await testEnvironment({ companyId: "c", adapterType: "dsh_local", config: { model: "m" } });
    expect(missing.checks.some((c) => c.code === "adapter_auth_missing")).toBe(true);
  });
});
it("listagem indisponível vira aviso sem afirmar conexão; autenticação negada bloqueia", async () => {
  vi.mocked(runProcess).mockImplementation(async (command) => ({ stdout: command === "node" ? "v24.11.0" : "0.2.1-alpha.1", stderr: "", exitCode: 0, signal: null, timedOut: false, failed: false, cancelled: false }));
  const context = { companyId: "c", adapterType: "dsh_local", config: { model: "custom-model", env: { DEEPSEEK_API_KEY: "key" } } };
  vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
  const unavailable = await testEnvironment(context);
  expect(unavailable.status).toBe("warn"); expect(unavailable.checks.some((check) => check.code === "dsh_connected")).toBe(false);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("private-key", { status: 401 })));
  const denied = await testEnvironment(context);
  expect(denied.status).toBe("fail"); expect(denied.checks.at(-1)?.code).toBe("adapter_auth_missing"); expect(JSON.stringify(denied)).not.toContain("private-key");
});
it.each(["bad-node", "bad-cli", "remote"])("diagnostica %s sem inferência", async (mode) => {
  vi.mocked(runProcess).mockImplementation(async (command) => ({ stdout: command === "node" ? mode === "bad-node" ? "v22.18.0" : "v24.11.0" : "0.1.0", stderr: "", exitCode: 0, signal: null, timedOut: false, failed: false, cancelled: false }));
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const result = await testEnvironment({ companyId: "c", adapterType: "dsh_local", config: { model: "m", env: { DEEPSEEK_API_KEY: "key" } }, ...(mode === "remote" ? { executionTarget: { kind: "remote" } as never } : {}) });
  expect(result.status).toBe("fail"); expect(fetcher).not.toHaveBeenCalled();
  expect(result.checks.at(-1)?.code).toBe(mode === "remote" ? "dsh_local_only" : mode === "bad-node" ? "dsh_node_incompatible" : "dsh_binary_invalid");
});
it.each(["not-json", '{}', '{"data":"not-an-array"}'])("recusa resposta de listagem inválida %s", async (body) => {
  await expect(listProviderModels(parseConfig({ model: "m", env: { DEEPSEEK_API_KEY: "key" } }), async () => new Response(body))).rejects.toMatchObject({ code: "dsh_models_failed" });
});
