import { describe, it, expect } from "vitest";
import { deriveDeviceName } from "./device-name.js";

describe("deriveDeviceName", () => {
  it("desktop origin always reads as Desktop App", () => {
    expect(deriveDeviceName(undefined, "desktop")).toBe("Desktop App");
    expect(deriveDeviceName("Tauri/2.0", "desktop")).toBe("Desktop App");
  });
  it("web Chrome on Mac", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
    expect(deriveDeviceName(ua, "web")).toBe("Chrome on macOS");
  });
  it("web Safari on iPhone", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    expect(deriveDeviceName(ua, "web")).toBe("Safari on iPhone");
  });
  it("unknown UA falls back to Browser on Unknown", () => {
    expect(deriveDeviceName("Curl/8.0", "web")).toBe("Browser on Unknown");
  });
});
