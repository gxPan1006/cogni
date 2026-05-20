import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../../db/test-db.js";
import { findOrCreateUserByEmail } from "../../db/users.js";
import { createHost } from "../../db/hosts.js";
import { createProject, createTask, getTask, getProject } from "../../db/projects.js";
import { HostRouter } from "../../host-router.js";
import { ClientHub } from "../../client-hub.js";
import { ChatDomain } from "../chat.js";
import { HostRpcClient } from "./host-rpc.js";
import { ProjectDomain } from "./index.js";
import type { HostRpcRequest, HostRpcResponse } from "@cogni/contract";

/**
 * Test scope: SP-4 hard-delete verbs on ProjectDomain.
 *
 * UI effect guarded: deleting a task makes its kanban card vanish (task-event
 * kind="deleted"); deleting a project removes it from the list page
 * (project-event kind="deleted"). Both cascade-clean the DB.
 */
async function makeProjectDomain() {
  const { db, close } = await makeTestDb();
  const u = await findOrCreateUserByEmail(db, "delete@x.com");
  const host = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });

  const send = vi.fn(async (_h: string, _req: HostRpcRequest): Promise<HostRpcResponse> => {
    throw new Error("no host rpc expected in delete tests");
  });
  const hostRpc = new HostRpcClient({ sendHostRpc: send });
  const hosts = new HostRouter();
  const clients = new ClientHub();
  const chat = new ChatDomain(db, hosts, clients);
  const domain = new ProjectDomain({ db, hostRpc, hostRouter: hosts, clients, chat });

  // Spy on the broadcast surface so we can assert deletes fan out.
  vi.spyOn(clients, "broadcastProject");
  vi.spyOn(clients, "broadcastProjects");
  vi.spyOn(clients, "broadcastTask");

  return { db, close, user: u, host, clients, domain };
}

describe("ProjectDomain.deleteTask / deleteProject", () => {
  it("deleteTask removes the row then broadcasts task-event deleted", async () => {
    const { domain, clients, db, user, host } = await makeProjectDomain();
    const project = await createProject(db, {
      userId: user.id,
      tenantId: user.tenantId,
      name: "P",
      repoPath: "/tmp/p",
      defaultHostId: host.hostId,
    });
    const task = await createTask(db, { projectId: project.id, title: "t" });
    await domain.deleteTask(task.id);
    expect(await getTask(db, task.id)).toBeNull();
    expect(clients.broadcastProject).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ t: "task-event", kind: "deleted" }),
    );
  });

  it("deleteTask is idempotent for an unknown task id", async () => {
    const { domain } = await makeProjectDomain();
    await expect(
      domain.deleteTask("00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();
  });

  it("deleteProject removes tasks + project and broadcasts project-event deleted", async () => {
    const { domain, clients, db, user, host } = await makeProjectDomain();
    const project = await createProject(db, {
      userId: user.id,
      tenantId: user.tenantId,
      name: "P",
      repoPath: "/tmp/p",
      defaultHostId: host.hostId,
    });
    const task = await createTask(db, { projectId: project.id, title: "t" });
    await domain.deleteProject(project.id);
    expect(await getProject(db, project.id)).toBeNull();
    expect(await getTask(db, task.id)).toBeNull();
    expect(clients.broadcastProjects).toHaveBeenCalledWith(
      project.userId,
      expect.objectContaining({ t: "project-event", kind: "deleted" }),
    );
  });
});
