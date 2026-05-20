import { describe, it, expect } from "vitest";
import {
  hostRpcRequestSchema,
  hostRpcResponseSchema,
  HOST_RPC_METHODS,
  clientToCloudSchema,
  cloudToHostSchema,
  cloudToClientSchema,
  attachmentSchema,
} from "./index.js";

describe("upload protocol", () => {
  it("attachmentSchema accepts {name,size}", () => {
    expect(attachmentSchema.parse({ name: "a.pdf", size: 12 })).toEqual({ name: "a.pdf", size: 12 });
  });

  it("registers the 4 upload RPC methods", () => {
    for (const m of ["upload-begin", "upload-chunk", "upload-commit", "upload-abort"] as const) {
      expect(HOST_RPC_METHODS).toContain(m);
    }
  });

  it("validates an upload-begin request and response", () => {
    const req = hostRpcRequestSchema.parse({
      method: "upload-begin",
      params: { scope: { kind: "thread", threadId: "t1" }, fileName: "a.pdf", declaredSize: 10 },
    });
    expect(req.method).toBe("upload-begin");
    const ok = hostRpcResponseSchema.parse({
      ok: true, method: "upload-begin", result: { uploadId: "u1" },
    });
    expect(ok.ok).toBe(true);
  });

  it("validates upload-chunk and upload-commit", () => {
    expect(hostRpcRequestSchema.parse({
      method: "upload-chunk", params: { uploadId: "u1", seq: 0, dataBase64: "AA==" },
    }).method).toBe("upload-chunk");
    expect(hostRpcResponseSchema.parse({
      ok: true, method: "upload-commit", result: { relPath: ".cogni-uploads/a.pdf", name: "a.pdf", size: 10 },
    }).ok).toBe(true);
  });

  it("carries attachments on send / dispatch / message frames", () => {
    const att = [{ name: "a.pdf", size: 10 }];
    expect(clientToCloudSchema.parse({ t: "send", threadId: "t1", text: "hi", attachments: att })).toBeTruthy();
    expect(cloudToHostSchema.parse({
      t: "dispatch", sessionId: "s", threadId: "t1", adapter: "claude-code",
      runnerSessionId: null, message: "hi", attachments: att,
    })).toBeTruthy();
    expect(cloudToClientSchema.parse({
      t: "message", threadId: "t1", messageId: "m", role: "user",
      content: "hi", createdAt: "now", attachments: att,
    })).toBeTruthy();
  });

  it("send / dispatch / message still parse without attachments", () => {
    expect(clientToCloudSchema.parse({ t: "send", threadId: "t1", text: "hi" })).toBeTruthy();
  });
});
