import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AntigravityLogoIcon } from "./AntigravityLogoIcon";
import { AdapterMark } from "./new-agent/AgentBasicsDialog";

it("uses the supplied Antigravity mark in registry and agent creation", () => {
  for (const element of [<AntigravityLogoIcon className="size-6" />, <AdapterMark type="antigravity_local" />]) {
    expect(renderToStaticMarkup(element)).toContain('src="/brands/adapters/antigravity-color.svg"');
  }
  const svg = readFileSync(new URL("../../public/brands/adapters/antigravity-color.svg", import.meta.url));
  expect(createHash("sha256").update(svg).digest("hex")).toBe("652128cf55a28bb958563ee372d0bd00208d9e6fd446f523f77aafd811eef8ca");
});
