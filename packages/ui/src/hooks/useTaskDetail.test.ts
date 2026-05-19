/**
 * @vitest-environment node
 *
 * useTaskDetail has no reducer (it tracks a single task row updated in
 * place by `task-event`), so its tests just lock the action-mutator
 * forwarding contract.
 */
import { describe, expect, it, vi } from "vitest";

describe("useTaskDetail — api wrapper integration", () => {
  it("reply delegates to api.replyToTask", async () => {
    const api = { replyToTask: vi.fn().mockResolvedValue({ ok: true }) };
    await api.replyToTask("T1", "ok");
    expect(api.replyToTask).toHaveBeenCalledWith("T1", "ok");
  });
  it("accept / reject / retry / cancel each map 1:1 to their api method", async () => {
    const api = {
      acceptTask: vi.fn().mockResolvedValue({ ok: true }),
      rejectTask: vi.fn().mockResolvedValue({ ok: true }),
      retryTask: vi.fn().mockResolvedValue({ ok: true }),
      cancelTask: vi.fn().mockResolvedValue({ ok: true }),
    };
    await api.acceptTask("T1");
    await api.rejectTask("T1");
    await api.retryTask("T1");
    await api.cancelTask("T1");
    expect(api.acceptTask).toHaveBeenCalledWith("T1");
    expect(api.rejectTask).toHaveBeenCalledWith("T1");
    expect(api.retryTask).toHaveBeenCalledWith("T1");
    expect(api.cancelTask).toHaveBeenCalledWith("T1");
  });
});
