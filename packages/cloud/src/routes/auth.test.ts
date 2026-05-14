import { describe, it, expect } from "vitest";
import { safeRedirect } from "./auth.js";

describe("safeRedirect", () => {
  it("allows the cogni:// deep-link scheme", () => {
    expect(safeRedirect("cogni://auth")).toBe("cogni://auth");
    expect(safeRedirect("cogni://auth/sub/path")).toBe("cogni://auth/sub/path");
  });
  it("rejects http(s) targets (open-redirect / token-exfil guard)", () => {
    expect(safeRedirect("https://evil.com")).toBe("cogni://auth");
    expect(safeRedirect("http://localhost/steal")).toBe("cogni://auth");
  });
  it("falls back to the default for missing or malformed input", () => {
    expect(safeRedirect(undefined)).toBe("cogni://auth");
    expect(safeRedirect("not a url")).toBe("cogni://auth");
    expect(safeRedirect("")).toBe("cogni://auth");
  });
});
