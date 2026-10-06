import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserUuid } from "./browser-uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe("browserUuid", () => {
  it("uses the native API when available", () => {
    const id = "a67a2fce-809c-498a-828a-41d9c510c325";
    const randomUUID = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis.crypto);
      return id;
    });
    vi.stubGlobal("crypto", { randomUUID });
    expect(browserUuid()).toBe(id);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("creates distinct schema-valid IDs using HTTP-compatible Web Crypto", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });
    const ids = Array.from({ length: 1000 }, () => browserUuid());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it("does not degrade to weak randomness without Web Crypto", () => {
    vi.stubGlobal("crypto", {});
    expect(() => browserUuid()).toThrow();
  });
});
