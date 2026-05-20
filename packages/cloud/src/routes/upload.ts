/**
 * Cloud → host streaming upload relay. Reads an HTTP request body chunk by
 * chunk and forwards it to the host as base64 upload-chunk RPCs, awaiting each
 * ack for backpressure. Never buffers the whole file. On any error or empty
 * host, sends upload-abort and rethrows so the route can map to a 4xx/5xx.
 */
import type { HostRpcRequest, HostRpcResponse } from "@cogni/contract";

export type SendRpc = (
  hostId: string,
  request: HostRpcRequest,
  opts?: { timeoutMs?: number },
) => Promise<HostRpcResponse>;

const RPC_TIMEOUT_MS = 60_000;

export async function relayUpload(args: {
  hostId: string;
  threadId: string;
  fileName: string;
  declaredSize: number;
  body: ReadableStream<Uint8Array>;
  sendRpc: SendRpc;
  /** Flush threshold; ~2MB in production. */
  chunkBytes: number;
}): Promise<{ name: string; size: number }> {
  const { hostId, threadId, fileName, declaredSize, body, sendRpc, chunkBytes } = args;

  const begin = await sendRpc(
    hostId,
    { method: "upload-begin", params: { scope: { kind: "thread", threadId }, fileName, declaredSize } },
    { timeoutMs: RPC_TIMEOUT_MS },
  );
  if (!begin.ok || begin.method !== "upload-begin") {
    throw new Error(`upload-begin failed: ${begin.ok ? "wrong method" : begin.error.code + " " + begin.error.message}`);
  }
  const uploadId = begin.result.uploadId;

  const abort = async () => {
    await sendRpc(hostId, { method: "upload-abort", params: { uploadId } }, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => undefined);
  };

  let seq = 0;
  let buffered: Uint8Array[] = [];
  let bufferedLen = 0;
  const reader = body.getReader();

  const flush = async () => {
    if (bufferedLen === 0) return;
    const merged = Buffer.concat(buffered.map((u) => Buffer.from(u)), bufferedLen);
    buffered = [];
    bufferedLen = 0;
    const resp = await sendRpc(
      hostId,
      { method: "upload-chunk", params: { uploadId, seq: seq++, dataBase64: merged.toString("base64") } },
      { timeoutMs: RPC_TIMEOUT_MS },
    );
    if (!resp.ok) {
      // ok:false is the single error branch of HostRpcResponse — `error` narrows here.
      throw new Error(`upload-chunk failed: ${resp.error.code}: ${resp.error.message}`);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        buffered.push(value);
        bufferedLen += value.length;
        if (bufferedLen >= chunkBytes) await flush();
      }
    }
    await flush();
    const commit = await sendRpc(
      hostId,
      { method: "upload-commit", params: { uploadId } },
      { timeoutMs: RPC_TIMEOUT_MS },
    );
    if (!commit.ok || commit.method !== "upload-commit") {
      throw new Error(`upload-commit failed`);
    }
    return { name: commit.result.name, size: commit.result.size };
  } catch (err) {
    await abort();
    throw err;
  }
}
