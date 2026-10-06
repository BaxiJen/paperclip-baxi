import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createServerAdapter } from "../src/index.js";
import { agentAdapterTypeSchema } from "../../../shared/src/adapter-type.js";
import { findServerAdapter, registerServerAdapter, requireServerAdapter, unregisterServerAdapter } from "../../../../server/src/adapters/index.js";

vi.mock("@paperclipai/paperclip-runner/live", () => ({ probeAcpxClaudeInstallation: vi.fn(async () => undefined) }));

it("is accepted by shared input validation and registered only through the external server seam", () => {
  expect(agentAdapterTypeSchema.parse("antigravity_local")).toBe("antigravity_local");
  expect(findServerAdapter("antigravity_local")).toBeNull();
  const adapter = createServerAdapter();
  try {
    registerServerAdapter(adapter);
    expect(requireServerAdapter("antigravity_local")).toBe(adapter);
  } finally { unregisterServerAdapter("antigravity_local"); }
  expect(findServerAdapter("antigravity_local")).toBeNull();
});

it("declares the external factory bundle and browser parser contract", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.name).toBe("@baxijen/paperclip-adapter-antigravity");
  expect(pkg.exports["."].import).toBe("./dist/index.js");
  expect(pkg.exports["./ui-parser"]).toBe("./dist/ui-parser.js");
  expect(pkg.paperclip.adapterUiParser).toBe("1.0.0");
  expect(pkg.dependencies).toBeUndefined();
});
