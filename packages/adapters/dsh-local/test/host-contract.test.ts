import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createServerAdapter, label } from "../src/index.js";
import { schema } from "../src/definition.js";
const source = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
describe("contrato do plugin externo", () => {
  it("exporta factory, codec com escopo, schema e capacidades do host", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("dsh_local"); expect(label).toBe("DeepSeek Harness (dsh)");
    expect(adapter.supportsLocalAgentJwt).toBe(true); expect(adapter.runtimeToolDelivery).toBe("environment");
    expect(adapter.getConfigSchema?.()).toBe(schema);
    expect(adapter.sessionCodec?.deserialize({ sessionId: "session-123" })).toBeNull();
    const scoped = { sessionId: "session-123", scope: "a".repeat(64) };
    expect(adapter.sessionCodec?.serialize(scoped)).toEqual(scoped);
    expect(adapter.sessionCodec?.getDisplayId?.(scoped)).toBe("session-123");
  });
  it("empacota parser externo e não registra o motor como built-in", async () => {
    const manifest = JSON.parse(await source("../package.json"));
    expect(manifest.name).toBe("@baxijen/paperclip-adapter-dsh");
    expect(manifest.exports["./ui-parser"]).toBe("./dist/ui-parser.js");
    expect(manifest.paperclip.adapterUiParser).toBe("1.0.0");
    expect(manifest.dependencies).toBeUndefined();
    for (const file of ["../../../../server/src/adapters/registry.ts", "../../../../packages/shared/src/constants.ts"]) expect(await source(file)).not.toContain('"dsh_local"');
  });
});
