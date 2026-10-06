import { describe, expect, it } from "vitest";
import { SETUP_CREDENTIAL_KEYS, SETUP_LOGIN_HINTS } from "./agent-setup-fields";

describe("Antigravity external adapter setup", () => {
  it("uses the existing Google secret picker without claiming automatic subscription login", () => {
    expect(SETUP_CREDENTIAL_KEYS.antigravity_local).toBe("GEMINI_API_KEY");
    expect(SETUP_LOGIN_HINTS.antigravity_local).toContain("segredo");
    expect(SETUP_LOGIN_HINTS.antigravity_local).toContain("ainda não está disponível");
  });
});
