import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";
import {
  createHost,
  findHostByToken,
  setHostStatus,
  getUserHosts,
  renameHost,
  softRemoveHost,
  getActiveHostsForUser,
  isHostRemoved,
} from "./hosts.js";

async function seedHostForUser(email = "a@x.com", hostName = "MacBook") {
  const { db, close } = await makeTestDb();
  const user = await findOrCreateUserByEmail(db, email);
  const reg = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: hostName });
  const host = { id: reg.hostId, registrationToken: reg.registrationToken, name: hostName };
  return { db, close, user, host };
}

describe("host repository", () => {
  it("creates a host with a registration token and looks it up", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "a@x.com");
    const reg = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: "MacBook" });
    expect(reg.registrationToken).toHaveLength(64);
    const found = await findHostByToken(db, reg.registrationToken);
    expect(found?.id).toBe(reg.hostId);
    await setHostStatus(db, reg.hostId, "online", ["streaming"]);
    const hosts = await getUserHosts(db, user.id);
    expect(hosts[0]?.status).toBe("online");
    await close();
  });

  it("renameHost updates name + leaves other fields alone", async () => {
    const { db, close, user, host } = await seedHostForUser();
    await renameHost(db, host.id, "Home MacBook Pro");
    const list = await getActiveHostsForUser(db, user.id);
    expect(list[0]?.name).toBe("Home MacBook Pro");
    await close();
  });

  it("softRemoveHost sets removed_at; isHostRemoved reports true", async () => {
    const { db, close, host } = await seedHostForUser();
    expect(await isHostRemoved(db, host.id)).toBe(false);
    await softRemoveHost(db, host.id);
    expect(await isHostRemoved(db, host.id)).toBe(true);
    await close();
  });

  it("getActiveHostsForUser excludes removed hosts", async () => {
    const { db, close, user, host } = await seedHostForUser();
    const second = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: "Other" });
    // softRemove first one
    await softRemoveHost(db, host.id);
    const list = await getActiveHostsForUser(db, user.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(second.hostId);
    await close();
  });
});
