import { describe, it, expect, vi } from "vitest";
import { relayUpload } from "./upload.js";
import type { HostRpcResponse } from "@cogni/contract";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]!); else c.close(); },
  });
}

describe("relayUpload", () => {
  it("begins, chunks, and commits, returning the host's final name/size", async () => {
    const calls: string[] = [];
    const sendRpc = vi.fn(async (_hostId, req): Promise<HostRpcResponse> => {
      calls.push(req.method);
      if (req.method === "upload-begin") return { ok: true, method: "upload-begin", result: { uploadId: "u1" } };
      if (req.method === "upload-chunk") return { ok: true, method: "upload-chunk", result: { received: 1 } };
      if (req.method === "upload-commit") return { ok: true, method: "upload-commit", result: { relPath: ".cogni-uploads/a.txt", name: "a.txt", size: 5 } };
      return { ok: true, method: "upload-abort", result: { ok: true } };
    });
    const res = await relayUpload({
      hostId: "h1", threadId: "t1", fileName: "a.txt", declaredSize: 5,
      body: streamOf(new Uint8Array([104, 101, 108, 108, 111])),
      sendRpc, chunkBytes: 1024 * 1024,
    });
    expect(res).toEqual({ name: "a.txt", size: 5 });
    expect(calls[0]).toBe("upload-begin");
    expect(calls.at(-1)).toBe("upload-commit");
  });

  it("aborts on a host error mid-stream and throws", async () => {
    const sendRpc = vi.fn(async (_hostId, req): Promise<HostRpcResponse> => {
      if (req.method === "upload-begin") return { ok: true, method: "upload-begin", result: { uploadId: "u1" } };
      if (req.method === "upload-chunk") return { ok: false, method: "upload-chunk", error: { code: "upload-too-large", message: "x" } };
      return { ok: true, method: "upload-abort", result: { ok: true } };
    });
    await expect(relayUpload({
      hostId: "h1", threadId: "t1", fileName: "a.txt", declaredSize: 5,
      body: streamOf(new Uint8Array([1, 2, 3])), sendRpc, chunkBytes: 1,
    })).rejects.toThrow(/upload-too-large/);
    expect(sendRpc).toHaveBeenCalledWith("h1", { method: "upload-abort", params: { uploadId: "u1" } }, expect.anything());
  });
});
