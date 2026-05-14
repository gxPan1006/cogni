import { mkdir } from "node:fs/promises";
import type { RunnerAdapter, RunnerEvent, RunnerSessionHandle } from "@cogni/contract";
import { threadScratchDir } from "./config.js";

export interface DispatchInput {
  sessionId: string;
  threadId: string;
  adapter: string;
  runnerSessionId: string | null;
  message: string;
}

/** Holds registered adapters + live session handles, runs one turn per dispatch. */
export class RunnerManager {
  private adapters = new Map<string, RunnerAdapter>();
  private sessions = new Map<string, RunnerSessionHandle>(); // cloud sessionId → handle

  register(adapter: RunnerAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  capabilities(): { adapters: string[]; capabilities: string[] } {
    const caps = new Set<string>();
    for (const a of this.adapters.values()) for (const c of a.capabilities) caps.add(c);
    return { adapters: [...this.adapters.keys()], capabilities: [...caps] };
  }

  /**
   * Run one turn for `input.sessionId`, forwarding every RunnerEvent to `onEvent`.
   *
   * Callers MUST serialize dispatch per `sessionId`: the get-or-create handle
   * cache is check-then-act and not concurrency-safe. In SP-1 the cloud
   * serializes per-session dispatch upstream, so this holds.
   *
   * SP-2 follow-ups: (a) cache the handle *promise* so concurrent same-session
   * callers share one creation; (b) add a `closeSession(sessionId)` eviction
   * path — the `sessions` Map currently grows unbounded and each handle may
   * wrap a live child process.
   */
  async dispatch(input: DispatchInput, onEvent: (e: RunnerEvent) => void): Promise<void> {
    const adapter = this.adapters.get(input.adapter);
    if (!adapter) {
      onEvent({ type: "error", code: "unknown_adapter", message: `no adapter registered for '${input.adapter}'` });
      return;
    }
    const cwd = threadScratchDir(input.threadId);
    await mkdir(cwd, { recursive: true });

    let handle = this.sessions.get(input.sessionId);
    if (!handle) {
      handle = input.runnerSessionId
        ? await adapter.resumeSession(input.runnerSessionId, { cwd })
        : await adapter.startSession({ cwd });
      this.sessions.set(input.sessionId, handle);
    }
    try {
      for await (const event of handle.send(input.message)) onEvent(event);
    } catch (err) {
      // Adapter-agnostic safety net: a well-behaved adapter yields an `error`
      // event, but a misbehaving one could throw. Don't let that reject
      // dispatch — that would strand the cloud-side session in `running`.
      onEvent({ type: "error", code: "adapter_threw", message: String(err) });
    }
  }
}
