import { describe, it, expect } from "vitest";
import { makeTestDb } from "../../db/test-db.js";
import { findOrCreateUserByEmail } from "../../db/users.js";
import { createHost } from "../../db/hosts.js";
import { createProject, createTask, getTask } from "../../db/projects.js";
import {
  transitionTask,
  StateMismatch,
  IllegalTransition,
  LEGAL_TRANSITIONS,
} from "./lifecycle.js";

async function seed() {
  const { db, close } = await makeTestDb();
  const u = await findOrCreateUserByEmail(db, "lifecycle@x.com");
  const host = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "h" });
  const project = await createProject(db, {
    tenantId: u.tenantId,
    userId: u.id,
    name: "P",
    repoPath: "/r",
    defaultHostId: host.hostId,
  });
  const task = await createTask(db, { projectId: project.id, title: "T" });
  return { db, close, task };
}

describe("lifecycle.LEGAL_TRANSITIONS", () => {
  it("lists every state as a key", () => {
    const keys = Object.keys(LEGAL_TRANSITIONS).sort();
    expect(keys).toEqual([
      "cancelled",
      "done",
      "failed",
      "needs-input",
      "queued",
      "reviewing",
      "running",
    ]);
  });
});

describe("lifecycle.transitionTask happy paths", () => {
  it("queued → running stamps startedAt", async () => {
    const { db, close, task } = await seed();
    const t = await transitionTask(db, task.id, "queued", "running");
    expect(t.state).toBe("running");
    expect(t.startedAt).not.toBeNull();
    expect(t.completedAt).toBeNull();
    await close();
  });

  it("running → needs-input + patch sets needsInputWhat", async () => {
    const { db, close, task } = await seed();
    await transitionTask(db, task.id, "queued", "running");
    const t = await transitionTask(db, task.id, "running", "needs-input", {
      needsInputWhat: "Context or Redux?",
    });
    expect(t.state).toBe("needs-input");
    expect(t.needsInputWhat).toBe("Context or Redux?");
    expect(t.completedAt).toBeNull(); // not terminal
    await close();
  });

  it("needs-input → running clears needsInputWhat", async () => {
    const { db, close, task } = await seed();
    await transitionTask(db, task.id, "queued", "running");
    await transitionTask(db, task.id, "running", "needs-input", { needsInputWhat: "?" });
    const t = await transitionTask(db, task.id, "needs-input", "running", { needsInputWhat: null });
    expect(t.state).toBe("running");
    expect(t.needsInputWhat).toBeNull();
    await close();
  });

  it("running → reviewing", async () => {
    const { db, close, task } = await seed();
    await transitionTask(db, task.id, "queued", "running");
    const t = await transitionTask(db, task.id, "running", "reviewing");
    expect(t.state).toBe("reviewing");
    expect(t.completedAt).toBeNull();
    await close();
  });

  it("reviewing → done stamps completedAt", async () => {
    const { db, close, task } = await seed();
    await transitionTask(db, task.id, "queued", "running");
    await transitionTask(db, task.id, "running", "reviewing");
    const t = await transitionTask(db, task.id, "reviewing", "done");
    expect(t.state).toBe("done");
    expect(t.completedAt).not.toBeNull();
    await close();
  });

  it("running → failed stamps completedAt", async () => {
    const { db, close, task } = await seed();
    await transitionTask(db, task.id, "queued", "running");
    const t = await transitionTask(db, task.id, "running", "failed");
    expect(t.state).toBe("failed");
    expect(t.completedAt).not.toBeNull();
    await close();
  });

  it("queued → cancelled stamps completedAt (terminal)", async () => {
    const { db, close, task } = await seed();
    const t = await transitionTask(db, task.id, "queued", "cancelled");
    expect(t.state).toBe("cancelled");
    expect(t.completedAt).not.toBeNull();
    expect(t.startedAt).toBeNull(); // never started
    await close();
  });

  it("done → queued is legal as the retry path", async () => {
    const { db, close, task } = await seed();
    await transitionTask(db, task.id, "queued", "running");
    await transitionTask(db, task.id, "running", "done");
    const t = await transitionTask(db, task.id, "done", "queued", { startedAt: null, completedAt: null });
    expect(t.state).toBe("queued");
    expect(t.startedAt).toBeNull();
    expect(t.completedAt).toBeNull();
    await close();
  });
});

describe("lifecycle.transitionTask error paths", () => {
  it("StateMismatch when expectedFrom does not match actual", async () => {
    const { db, close, task } = await seed();
    // task is queued, not running — caller asks running→reviewing
    await expect(
      transitionTask(db, task.id, "running", "reviewing"),
    ).rejects.toBeInstanceOf(StateMismatch);
    // Row state did not change.
    const after = await getTask(db, task.id);
    expect(after?.state).toBe("queued");
    await close();
  });

  it("IllegalTransition for queued → reviewing (not in LEGAL_TRANSITIONS)", async () => {
    const { db, close, task } = await seed();
    await expect(
      transitionTask(db, task.id, "queued", "reviewing"),
    ).rejects.toBeInstanceOf(IllegalTransition);
    await close();
  });

  it("IllegalTransition for done → done (no self-loop)", async () => {
    const { db, close, task } = await seed();
    await transitionTask(db, task.id, "queued", "running");
    await transitionTask(db, task.id, "running", "done");
    await expect(
      transitionTask(db, task.id, "done", "done"),
    ).rejects.toBeInstanceOf(IllegalTransition);
    await close();
  });
});
