import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUser } from "./users.js";
import { createHost, findHostByToken, setHostStatus, getUserHosts } from "./hosts.js";

describe("host repository", () => {
  it("creates a host with a registration token and looks it up", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    const reg = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: "MacBook" });
    expect(reg.registrationToken).toHaveLength(64);
    const found = await findHostByToken(db, reg.registrationToken);
    expect(found?.id).toBe(reg.hostId);
    await setHostStatus(db, reg.hostId, "online", ["streaming"]);
    const hosts = await getUserHosts(db, user.id);
    expect(hosts[0]?.status).toBe("online");
    await close();
  });
});
