# Default Project Folder + Configurable Host Projects-Root — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When creating a project, pre-fill the repo path from a configurable per-host "projects root" (default `~/cogni`) so the common case is "type a name → click create" and a real folder is created + git-init-ed; expose the root as an editable per-host setting.

**Architecture:** Host resolves its projects-root (env → host.json → `~/cogni`), reports it on the `register` frame, and serves a `set-projects-root` RPC. The cloud stores it on the `hosts` row, returns it via `GET /hosts`, and exposes a `PUT /api/hosts/:id/projects-root` route. The UI pre-fills `NewProject`'s path field from the selected host's root and adds an editable field in Settings → Runner Hosts.

**Tech Stack:** TypeScript, zod (`@cogni/contract`), drizzle/Neon (cloud), `ws` (host↔cloud WS), React 19 (`@cogni/ui`), vitest.

**Prerequisite (already in working tree):** the tilde fix — `packages/runner-host/src/paths.ts` exports `expandTilde(p)` and `resolveUserPath(p)`, and all git-ops/fs-browse handlers route paths through them. Tasks below build on `expandTilde`.

**Conventions:** Run a single test file with `pnpm vitest run <path>`. After editing any `packages/*` source that another package imports at runtime, the change is picked up by vitest via source aliases (no build needed for tests). Commit after each task.

---

### Task 1: contract — `set-projects-root` RPC + register fields

**Files:**
- Modify: `packages/contract/src/host-protocol.ts`
- Modify: `packages/contract/src/protocol.ts:21-31` (register variant)
- Test: `packages/contract/src/project.test.ts`, `packages/contract/src/protocol.test.ts`

- [ ] **Step 1: Write failing tests**

In `packages/contract/src/project.test.ts`, add inside the existing `describe` that imports `hostRpcRequestSchema`:

```ts
it("parses set-projects-root req+resp", () => {
  expect(
    hostRpcRequestSchema.safeParse({
      method: "set-projects-root",
      params: { projectsRoot: "~/cogni" },
    }).success,
  ).toBe(true);
});
```

In `packages/contract/src/protocol.test.ts`, add:

```ts
it("accepts register with projectsRoot + projectsRootLocked", () => {
  expect(
    hostToCloudSchema.safeParse({
      t: "register", hostId: "h1", capabilities: ["streaming"], adapters: ["claude-code"],
      version: "0.0.0", projectsRoot: "/Users/x/cogni", projectsRootLocked: false,
    }).success,
  ).toBe(true);
});
it("accepts register without projectsRoot (back-compat)", () => {
  expect(
    hostToCloudSchema.safeParse({
      t: "register", hostId: "h1", capabilities: ["streaming"], adapters: ["claude-code"], version: "0.0.0",
    }).success,
  ).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/contract/src/project.test.ts packages/contract/src/protocol.test.ts`
Expected: FAIL — `set-projects-root` not in the union; `projectsRoot` not a known key (strict parse may still pass but the discriminated method literal fails).

- [ ] **Step 3: Add the request/response schemas**

In `packages/contract/src/host-protocol.ts`, after the `read-file` schema block (before the "File upload" section), add:

```ts
// set-projects-root — configurable per-host root for auto-created project folders
export const setProjectsRootRequestSchema = z.object({
  /** New root; may contain a leading ~ (host expands it). */
  projectsRoot: z.string().min(1),
});
export type SetProjectsRootRequest = z.infer<typeof setProjectsRootRequestSchema>;

export const setProjectsRootResponseSchema = z.object({
  /** Absolute, ~-expanded path the host will use. */
  projectsRoot: z.string(),
  /** true ⇢ pinned by COGNI_PROJECTS_ROOT env; the write was a no-op. */
  locked: z.boolean(),
});
export type SetProjectsRootResponse = z.infer<typeof setProjectsRootResponseSchema>;
```

- [ ] **Step 4: Register the method in all four catalogs**

In `host-protocol.ts`:

1. In `hostRpcRequestSchema` union (after the `upload-abort` entry):
```ts
  z.object({ method: z.literal("set-projects-root"), params: setProjectsRootRequestSchema }),
```
2. In `hostRpcMethodSchema` enum array, add `"set-projects-root",`.
3. In `hostRpcResponseSchema` union (after the `upload-abort` success branch, before the `ok:false` branch):
```ts
  z.object({ ok: z.literal(true), method: z.literal("set-projects-root"), result: setProjectsRootResponseSchema }),
```
4. In `HOST_RPC_METHODS` array, add `"set-projects-root",`.

- [ ] **Step 5: Add register fields**

In `packages/contract/src/protocol.ts`, the `t: "register"` object — add after `version: z.string(),`:

```ts
    /** SP-4: host's configured projects-root (absolute, ~-expanded). Optional for old hosts. */
    projectsRoot: z.string().optional(),
    /** true ⇢ root pinned by COGNI_PROJECTS_ROOT env (UI shows read-only). */
    projectsRootLocked: z.boolean().optional(),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/contract/src/project.test.ts packages/contract/src/protocol.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contract/src/host-protocol.ts packages/contract/src/protocol.ts packages/contract/src/project.test.ts packages/contract/src/protocol.test.ts
git commit -m "feat(contract): set-projects-root RPC + register projectsRoot fields"
```

---

### Task 2: runner-host — projects-root resolution helper

**Files:**
- Modify: `packages/runner-host/src/config.ts`
- Test: `packages/runner-host/src/config.test.ts` (create if missing)

- [ ] **Step 1: Write the failing test**

Create/append `packages/runner-host/src/config.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolveProjectsRoot } from "./config.js";

const ORIG = process.env.COGNI_PROJECTS_ROOT;
afterEach(() => {
  if (ORIG === undefined) delete process.env.COGNI_PROJECTS_ROOT;
  else process.env.COGNI_PROJECTS_ROOT = ORIG;
});

describe("resolveProjectsRoot", () => {
  it("defaults to ~/cogni expanded, unlocked", () => {
    delete process.env.COGNI_PROJECTS_ROOT;
    expect(resolveProjectsRoot(undefined)).toEqual({ root: `${homedir()}/cogni`, locked: false });
  });
  it("uses the config value when no env", () => {
    delete process.env.COGNI_PROJECTS_ROOT;
    expect(resolveProjectsRoot("~/work")).toEqual({ root: `${homedir()}/work`, locked: false });
  });
  it("env wins and locks", () => {
    process.env.COGNI_PROJECTS_ROOT = "~/envroot";
    expect(resolveProjectsRoot("~/work")).toEqual({ root: `${homedir()}/envroot`, locked: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runner-host/src/config.test.ts`
Expected: FAIL — `resolveProjectsRoot` not exported.

- [ ] **Step 3: Implement**

In `packages/runner-host/src/config.ts`: add `projectsRoot?: string;` to the `HostConfig` interface (after `cloudUrl`). In `readHostConfig`, preserve it — change the success `return parsed as HostConfig;` to first capture the optional field (no validation change needed since it's optional and `parsed` already carries it). Add the import and helper:

```ts
import { expandTilde } from "./paths.js";

/** Resolve the host's projects-root: COGNI_PROJECTS_ROOT env (locked) →
 *  host.json `projectsRoot` → default `~/cogni`. Always ~-expanded. */
export function resolveProjectsRoot(configValue: string | undefined): { root: string; locked: boolean } {
  const env = process.env.COGNI_PROJECTS_ROOT;
  if (env && env.trim().length > 0) return { root: expandTilde(env.trim()), locked: true };
  return { root: expandTilde(configValue && configValue.trim().length > 0 ? configValue.trim() : "~/cogni"), locked: false };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/runner-host/src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runner-host/src/config.ts packages/runner-host/src/config.test.ts
git commit -m "feat(runner-host): resolveProjectsRoot (env > config > ~/cogni)"
```

---

### Task 3: runner-host — `gitInitIfMissing` creates missing parents

**Files:**
- Modify: `packages/runner-host/src/git-ops.ts:111-120`
- Test: `packages/runner-host/src/git-ops.test.ts`

- [ ] **Step 1: Write the failing test**

In `git-ops.test.ts`, inside `describe("gitInitIfMissing", ...)`:

```ts
it.skipIf(!hasGit)("creates missing parent directories", async () => {
  const nested = join(tmp, "a", "b", "c");
  const res = await gitInitIfMissing({ repoPath: nested });
  expect(res.initialized).toBe(true);
  // .git exists ⇒ parents were created
  const { pathExists } = (await import("./git-ops.js")).__internals;
  expect(await pathExists(join(nested, ".git"))).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runner-host/src/git-ops.test.ts -t "creates missing parent"`
Expected: FAIL — `git init` errors because `tmp/a/b` doesn't exist.

- [ ] **Step 3: Implement**

In `git-ops.ts`, add `mkdir` to the `node:fs/promises` import line (it currently imports `access, stat`):
```ts
import { access, mkdir, stat } from "node:fs/promises";
```
In `gitInitIfMissing`, after `const repoPath = resolveUserPath(req.repoPath);` and the existing `.git` no-op check, before `await execa("git", ["init", ...])`, add:
```ts
  // Auto-created default folders may sit under a not-yet-existing root
  // (e.g. ~/cogni/<name> when ~/cogni is new). git init creates the leaf but
  // not deep parents reliably across versions — mkdir -p first.
  await mkdir(repoPath, { recursive: true });
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/runner-host/src/git-ops.test.ts`
Expected: PASS (all git-ops tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runner-host/src/git-ops.ts packages/runner-host/src/git-ops.test.ts
git commit -m "feat(runner-host): gitInitIfMissing creates missing parent dirs"
```

---

### Task 4: runner-host — `setProjectsRoot` handler + dispatcher wiring

**Files:**
- Modify: `packages/runner-host/src/config.ts` (add `setProjectsRoot`)
- Modify: `packages/runner-host/src/rpc-dispatcher.ts`
- Modify: `packages/runner-host/src/main.ts` (wire dep)
- Test: `packages/runner-host/src/config.test.ts`, `packages/runner-host/src/rpc-dispatcher.test.ts`

- [ ] **Step 1: Write failing tests**

In `config.test.ts`:

```ts
import { mkdtemp, readFile as rf, writeFile as wf } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProjectsRoot, configPath } from "./config.js";

describe("setProjectsRoot", () => {
  it("writes projectsRoot into host.json and returns expanded path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cogni-cfg-"));
    process.env.COGNI_HOME = dir;
    delete process.env.COGNI_PROJECTS_ROOT;
    await wf(configPath(), JSON.stringify({ hostId: "h", registrationToken: "t", cloudUrl: "ws://x" }), "utf8");
    const res = await setProjectsRoot("~/work");
    expect(res.locked).toBe(false);
    expect(res.projectsRoot).toBe(`${homedir()}/work`);
    const saved = JSON.parse(await rf(configPath(), "utf8"));
    expect(saved.projectsRoot).toBe("~/work"); // stored raw; expanded on read
    delete process.env.COGNI_HOME;
  });
  it("refuses to write when env-locked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cogni-cfg-"));
    process.env.COGNI_HOME = dir;
    process.env.COGNI_PROJECTS_ROOT = "~/envroot";
    await wf(configPath(), JSON.stringify({ hostId: "h", registrationToken: "t", cloudUrl: "ws://x" }), "utf8");
    const res = await setProjectsRoot("~/work");
    expect(res).toEqual({ projectsRoot: `${homedir()}/envroot`, locked: true });
    const saved = JSON.parse(await rf(configPath(), "utf8"));
    expect(saved.projectsRoot).toBeUndefined();
    delete process.env.COGNI_HOME; delete process.env.COGNI_PROJECTS_ROOT;
  });
});
```

In `rpc-dispatcher.test.ts`, add a case mirroring existing ones:

```ts
it("routes set-projects-root", async () => {
  const deps = makeDeps({ setProjectsRoot: async () => ({ projectsRoot: "/Users/x/cogni", locked: false }) });
  const resp = await dispatchHostRpc({ method: "set-projects-root", params: { projectsRoot: "~/cogni" } }, deps);
  expect(resp).toEqual({ ok: true, method: "set-projects-root", result: { projectsRoot: "/Users/x/cogni", locked: false } });
});
```
(Use the file's existing helper for building `deps`; if it builds a literal object, add `setProjectsRoot` to it.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/runner-host/src/config.test.ts packages/runner-host/src/rpc-dispatcher.test.ts`
Expected: FAIL — `setProjectsRoot` not exported; dispatcher has no `set-projects-root` case.

- [ ] **Step 3: Implement the handler**

In `config.ts` add:

```ts
import type { SetProjectsRootResponse } from "@cogni/contract";

/** Persist a new projects-root into host.json (no-op + locked when env pins it). */
export async function setProjectsRoot(projectsRoot: string): Promise<SetProjectsRootResponse> {
  const cfg = await readHostConfig();
  const resolved = resolveProjectsRoot(projectsRoot);
  if (resolved.locked) return { projectsRoot: resolved.root, locked: true };
  if (cfg) await writeHostConfig({ ...cfg, projectsRoot });
  return { projectsRoot: resolved.root, locked: false };
}
```

- [ ] **Step 4: Wire the dispatcher**

In `rpc-dispatcher.ts`:
1. Add to imports: `type SetProjectsRootRequest, type SetProjectsRootResponse,`.
2. Add to `RpcDeps`: `setProjectsRoot: (req: SetProjectsRootRequest) => Promise<SetProjectsRootResponse>;`
3. Add a `routeRpc` case (before the closing brace of the switch):
```ts
    case "set-projects-root":
      return { ok: true, method: frame.method, result: await deps.setProjectsRoot(frame.params) };
```

- [ ] **Step 5: Wire main.ts**

In `packages/runner-host/src/main.ts`, find where `RpcDeps` is constructed (the object passed to the dispatcher) and add:
```ts
    setProjectsRoot: (req) => setProjectsRoot(req.projectsRoot),
```
Add `setProjectsRoot` to the `./config.js` import.

- [ ] **Step 6: Run to verify they pass**

Run: `pnpm vitest run packages/runner-host/src/config.test.ts packages/runner-host/src/rpc-dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm --filter @cogni/runner-host exec tsc --noEmit` → expect clean.
```bash
git add packages/runner-host/src/config.ts packages/runner-host/src/rpc-dispatcher.ts packages/runner-host/src/main.ts packages/runner-host/src/config.test.ts packages/runner-host/src/rpc-dispatcher.test.ts
git commit -m "feat(runner-host): set-projects-root RPC handler"
```

---

### Task 5: runner-host — report projectsRoot on register

**Files:**
- Modify: `packages/runner-host/src/registry.ts:62-74` (the `send({ t: "register", ... })`)

- [ ] **Step 1: Implement**

In `registry.ts`, import at top: `import { readHostConfig, resolveProjectsRoot } from "./config.js";` (if `readHostConfig` isn't already imported). Inside `ws.on("open", ...)`, before the `send({ t: "register", ... })`, compute the root and include it:

```ts
      const cfg = await readHostConfig();
      const pr = resolveProjectsRoot(cfg?.projectsRoot);
      send({
        t: "register",
        hostId: config.hostId,
        capabilities: caps.capabilities as RunnerCapability[],
        adapters: caps.adapters,
        version: VERSION,
        projectsRoot: pr.root,
        projectsRootLocked: pr.locked,
      });
```
Note: the `ws.on("open", ...)` callback must be `async` for the `await`. Change `ws.on("open", () => {` to `ws.on("open", async () => {`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @cogni/runner-host exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/runner-host/src/registry.ts
git commit -m "feat(runner-host): report projectsRoot on register frame"
```

---

### Task 6: cloud — schema columns + migration

**Files:**
- Modify: `packages/cloud/src/db/schema.ts` (hosts table)
- Modify: `packages/cloud/src/db/test-db.ts` (the inline `create table hosts` DDL)
- Create: `packages/cloud/src/scripts/migrate-2026-05-20-host-projects-root.ts`

- [ ] **Step 1: Add columns to schema**

In `schema.ts`, in the `hosts = pgTable("hosts", { ... })` block, after `capabilitiesJson`:
```ts
  projectsRoot: text("projects_root"),
  projectsRootLocked: boolean("projects_root_locked").notNull().default(false),
```
Ensure `boolean` is imported from `drizzle-orm/pg-core` at the top (add it to the existing import list if absent).

- [ ] **Step 2: Mirror in test-db DDL**

In `packages/cloud/src/db/test-db.ts`, find the `create table hosts (...)` string and add, after the capabilities column:
```sql
  projects_root text,
  projects_root_locked boolean not null default false,
```

- [ ] **Step 3: Write the migration script**

Create `packages/cloud/src/scripts/migrate-2026-05-20-host-projects-root.ts` (mirror the structure of `migrate-2026-05-18-sp2-deltas.ts`):

```ts
import { neon } from "@neondatabase/serverless";

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  await sql`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS projects_root text`;
  await sql`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS projects_root_locked boolean NOT NULL DEFAULT false`;
  console.log("migrate-2026-05-20-host-projects-root: done");
}
main().catch((e) => { console.error(e); process.exit(1); });
```
(If the existing migrations use `drizzle`/a pooled client instead of `neon`, copy that exact import + client setup from the newest migration in the folder.)

- [ ] **Step 4: Verify tests still build the schema**

Run: `pnpm vitest run packages/cloud/src/routes/hosts.test.ts`
Expected: PASS (existing tests; the new columns have defaults so nothing breaks).

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/db/schema.ts packages/cloud/src/db/test-db.ts packages/cloud/src/scripts/migrate-2026-05-20-host-projects-root.ts
git commit -m "feat(cloud): hosts.projects_root + projects_root_locked columns + migration"
```

---

### Task 7: cloud — persist projectsRoot on register + serve via GET /hosts

**Files:**
- Modify: `packages/cloud/src/db/hosts.ts` (new `setHostProjectsRoot`)
- Modify: `packages/cloud/src/routes/host-ws.ts:139-170` (register handler)
- Modify: `packages/cloud/src/routes/hosts.ts:46-60` (GET /hosts serialization)
- Test: `packages/cloud/src/routes/hosts.test.ts`

- [ ] **Step 1: Write the failing test**

In `hosts.test.ts`, in `describe("GET /api/hosts", ...)`, after creating + setting a host's projects-root via the new db helper, assert it's serialized:

```ts
it("returns projectsRoot + projectsRootLocked", async () => {
  const { hostId } = await createHost(db, { userId, tenantId, name: "Mac" });
  const { setHostProjectsRoot } = await import("../db/hosts.js");
  await setHostProjectsRoot(db, hostId, "/Users/x/cogni", false);
  const res = await req("/api/hosts");
  const body = (await res.json()) as Array<{ id: string; projectsRoot: string | null; projectsRootLocked: boolean }>;
  const row = body.find((h) => h.id === hostId)!;
  expect(row.projectsRoot).toBe("/Users/x/cogni");
  expect(row.projectsRootLocked).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/cloud/src/routes/hosts.test.ts -t "returns projectsRoot"`
Expected: FAIL — `setHostProjectsRoot` missing; response lacks the fields.

- [ ] **Step 3: Add the db helper**

In `db/hosts.ts`:
```ts
export async function setHostProjectsRoot(
  db: AnyDb, hostId: string, projectsRoot: string, locked: boolean,
): Promise<void> {
  await db.update(hosts).set({ projectsRoot, projectsRootLocked: locked }).where(eq(hosts.id, hostId));
}
```

- [ ] **Step 4: Persist on register**

In `host-ws.ts`, in the `if (msg.t === "register")` block, after `await setHostStatus(deps.db, host.id, "online", msg.capabilities);` add:
```ts
                if (msg.projectsRoot) {
                  const { setHostProjectsRoot } = await import("../db/hosts.js");
                  await setHostProjectsRoot(deps.db, host.id, msg.projectsRoot, msg.projectsRootLocked ?? false);
                }
```

- [ ] **Step 5: Serialize in GET /hosts**

In `routes/hosts.ts`, in the `rows.map((h) => ({ ... }))`, add after `lastSeen`:
```ts
        projectsRoot: h.projectsRoot ?? null,
        projectsRootLocked: h.projectsRootLocked ?? false,
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run packages/cloud/src/routes/hosts.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cloud/src/db/hosts.ts packages/cloud/src/routes/host-ws.ts packages/cloud/src/routes/hosts.ts packages/cloud/src/routes/hosts.test.ts
git commit -m "feat(cloud): persist + serve host projectsRoot"
```

---

### Task 8: cloud — `setProjectsRoot` RPC client + ProjectDomain method + route

**Files:**
- Modify: `packages/cloud/src/domains/project/host-rpc.ts` (add wrapper)
- Modify: `packages/cloud/src/domains/project/index.ts` (add `setProjectsRoot`)
- Modify: `packages/cloud/src/routes/projects.ts` (new route)
- Test: `packages/cloud/src/routes/projects.test.ts` (or hosts.test.ts)

- [ ] **Step 1: Write the failing test**

In `packages/cloud/src/routes/projects.test.ts`, add a test that calls `PUT /api/hosts/:id/projects-root` with a mocked host RPC returning `{ projectsRoot: "/Users/x/work", locked: false }`, and asserts the response is `{ projectsRoot, locked }` and the `hosts` row updated. (Follow the file's existing pattern for mocking `sendHostRpc` / building the app; if the project tests inject a fake `HostRpcClient`, configure its `setProjectsRoot` to resolve the fixture.)

```ts
it("PUT /api/hosts/:id/projects-root updates the host", async () => {
  const { hostId } = await createHost(db, { userId, tenantId, name: "Mac" });
  fakeHostRpc.setProjectsRoot = async () => ({ projectsRoot: "/Users/x/work", locked: false });
  const res = await req(`/api/hosts/${hostId}/projects-root`, {
    method: "PUT", body: JSON.stringify({ projectsRoot: "~/work" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ projectsRoot: "/Users/x/work", locked: false });
  const { getActiveHostsForUser } = await import("../db/hosts.js");
  const row = (await getActiveHostsForUser(db, userId)).find((h) => h.id === hostId)!;
  expect(row.projectsRoot).toBe("/Users/x/work");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/cloud/src/routes/projects.test.ts -t "projects-root updates"`
Expected: FAIL — route + method missing.

- [ ] **Step 3: Add HostRpcClient wrapper**

In `host-rpc.ts`, mirror the `fsBrowse` wrapper:
```ts
  async setProjectsRoot(hostId: string, params: SetProjectsRootRequest): Promise<SetProjectsRootResponse> {
    return this.call(hostId, "set-projects-root", params) as Promise<SetProjectsRootResponse>;
  }
```
(Match the exact return-cast style the file uses for other wrappers; add `SetProjectsRootRequest, SetProjectsRootResponse` to the `@cogni/contract` import.)

- [ ] **Step 4: Add ProjectDomain method**

In `domains/project/index.ts`, near `fsBrowse`:
```ts
/** Settings → Runner Hosts: change a host's projects-root. Passthrough to the
 *  host RPC; caller (route) persists the returned value + broadcasts. */
async setProjectsRoot(hostId: string, projectsRoot: string): Promise<{ projectsRoot: string; locked: boolean }> {
  return this.deps.hostRpc.setProjectsRoot(hostId, { projectsRoot });
}
```

- [ ] **Step 5: Add the route**

In `routes/projects.ts`, register (using the same ownership check helper the file/hosts uses; if projects.ts lacks an owned-host check, inline a query mirroring `ownedHost` in hosts.ts):
```ts
app.put("/api/hosts/:id/projects-root", async (c) => {
  const { userId } = c.get("claims");
  const id = c.req.param("id");
  // ownership: host must belong to caller and not be soft-removed
  const owned = await deps.db.select().from(hostsTable)
    .where(and(eq(hostsTable.id, id), eq(hostsTable.userId, userId), isNull(hostsTable.removedAt))).limit(1);
  if (!owned[0]) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ projectsRoot: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid projectsRoot" }, 400);
  let result: { projectsRoot: string; locked: boolean };
  try {
    result = await deps.projects.setProjectsRoot(id, parsed.data.projectsRoot);
  } catch (err) {
    logger.warn({ hostId: id, err: String(err) }, "set projects-root RPC failed");
    return c.json({ error: "host unavailable" }, 502);
  }
  const { setHostProjectsRoot } = await import("../db/hosts.js");
  await setHostProjectsRoot(deps.db, id, result.projectsRoot, result.locked);
  deps.clients.publishHostMeta(userId, {
    hostId: id, name: owned[0].name, status: owned[0].status as "online" | "offline",
    lastSeen: owned[0].lastSeen ? owned[0].lastSeen.toISOString() : null,
  });
  return c.json(result);
});
```
Add imports at the top of `routes/projects.ts` as needed: `eq, and, isNull` from `drizzle-orm`, `z` from `zod`, `hosts as hostsTable` from `../db/schema.js`, `logger` from `@cogni/shared`.

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run packages/cloud/src/routes/projects.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm --filter @cogni/cloud exec tsc --noEmit` → clean.
```bash
git add packages/cloud/src/domains/project/host-rpc.ts packages/cloud/src/domains/project/index.ts packages/cloud/src/routes/projects.ts packages/cloud/src/routes/projects.test.ts
git commit -m "feat(cloud): PUT /api/hosts/:id/projects-root"
```

---

### Task 9: ui — api client (`HostInfo` fields + `setProjectsRoot`)

**Files:**
- Modify: `packages/ui/src/transport/api.ts:73-78` (HostInfo) + Hosts section (~205)

- [ ] **Step 1: Implement**

Extend `HostInfo`:
```ts
export interface HostInfo {
  id: string;
  name: string;
  status: string;
  lastSeen?: string | null;
  projectsRoot?: string | null;
  projectsRootLocked?: boolean;
}
```
Add a client method in the Hosts section (after `removeHost`):
```ts
  setProjectsRoot = (id: string, projectsRoot: string): Promise<{ projectsRoot: string; locked: boolean }> =>
    this.request(`${this.cloudUrl}/api/hosts/${id}/projects-root`, {
      method: "PUT", headers: this.authHeaders(), body: JSON.stringify({ projectsRoot }),
    });
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web exec tsc --noEmit` (web consumes `@cogni/ui` source)
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/transport/api.ts
git commit -m "feat(ui): HostInfo.projectsRoot + api.setProjectsRoot"
```

---

### Task 10: ui — NewProject pre-fill

**Files:**
- Create: `packages/ui/src/components/project/new-project-path.ts` (pure helpers)
- Create: `packages/ui/src/components/project/new-project-path.test.ts`
- Modify: `packages/ui/src/components/project/NewProject.tsx`

- [ ] **Step 1: Write failing tests for the pure helpers**

`new-project-path.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { sanitizeFolderName, suggestRepoPath } from "./new-project-path.js";

describe("sanitizeFolderName", () => {
  it("keeps unicode, trims, collapses spaces", () => {
    expect(sanitizeFolderName("  本地工具显示器  ")).toBe("本地工具显示器");
    expect(sanitizeFolderName("My App")).toBe("My-App");
  });
  it("drops slashes/control chars, keeps space→dash for the rest", () => {
    expect(sanitizeFolderName("a/b c")).toBe("ab-c");
  });
  it("empty when blank", () => {
    expect(sanitizeFolderName("   ")).toBe("");
  });
});

describe("suggestRepoPath", () => {
  it("joins root + slug", () => {
    expect(suggestRepoPath("/Users/x/cogni", "本地工具显示器")).toBe("/Users/x/cogni/本地工具显示器");
  });
  it("trims a trailing slash on root", () => {
    expect(suggestRepoPath("/Users/x/cogni/", "App")).toBe("/Users/x/cogni/App");
  });
  it("empty when no root or no name", () => {
    expect(suggestRepoPath(null, "App")).toBe("");
    expect(suggestRepoPath("/Users/x/cogni", "")).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/components/project/new-project-path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

`new-project-path.ts`:
```ts
/** Folder name from a project name: trim, drop path separators ('/'),
 *  collapse internal whitespace to '-', keep unicode (Chinese ok). */
export function sanitizeFolderName(name: string): string {
  return name
    .trim()
    .replace(/[/]/g, "")
    .replace(/\s+/g, "-");
}

/** Suggested absolute repoPath = <root>/<slug>. Empty if either is missing. */
export function suggestRepoPath(root: string | null | undefined, name: string): string {
  const slug = sanitizeFolderName(name);
  if (!root || !slug) return "";
  return root.replace(/\/+$/, "") + "/" + slug;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/components/project/new-project-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire NewProject.tsx**

In `NewProject.tsx`: import the helper:
```ts
import { suggestRepoPath } from "./new-project-path.js";
```
Add a `pathDirty` state next to the others:
```ts
  const [pathDirty, setPathDirty] = useState(false);
```
After the existing `useState`s, add an effect that updates the suggestion while clean:
```ts
  const selectedHost = hosts.find((h) => h.id === defaultHostId);
  useEffect(() => {
    if (pathDirty) return;
    setRepoPath(suggestRepoPath(selectedHost?.projectsRoot, name));
  }, [name, selectedHost?.projectsRoot, pathDirty]);
```
On the path `<input>`'s `onChange`, also mark dirty:
```tsx
onChange={(e) => { setRepoPath(e.target.value); setPathDirty(true); }}
```
In `FsBrowseModal`'s `onPick` usage (the `setRepoPath(path)` call in the parent), also `setPathDirty(true)`.
Add `useEffect` to the React import if not present.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/components/project/new-project-path.ts packages/ui/src/components/project/new-project-path.test.ts packages/ui/src/components/project/NewProject.tsx
git commit -m "feat(ui): NewProject pre-fills repo path from host projects-root"
```

---

### Task 11: ui — Settings → Runner Hosts editable projects-root

**Files:**
- Modify: `packages/ui/src/components/SettingsPage.tsx` (Hosts page)
- Modify: `packages/ui/src/components/settings.css` (optional styling)

- [ ] **Step 1: Implement**

In `SettingsPage.tsx`, locate the Hosts page render (the `page === "hosts"` branch, backed by `useHosts(api)`). For each host card, add a projects-root row. Use local state per edit; reuse the `api` prop:

```tsx
function HostProjectsRootRow({ api, host }: { api: ApiClient; host: HostInfo }) {
  const [value, setValue] = useState(host.projectsRoot ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const locked = host.projectsRootLocked === true;
  return (
    <div className="settings__projroot">
      <label className="field__label">项目根目录</label>
      <div className="np__path">
        <input className="input" value={value} disabled={locked || saving}
          placeholder="~/cogni" onChange={(e) => { setValue(e.target.value); setSaved(false); }} />
        <button className="btn btn-sm" disabled={locked || saving || value.trim().length === 0}
          onClick={async () => {
            setSaving(true);
            try { const r = await api.setProjectsRoot(host.id, value.trim()); setValue(r.projectsRoot); setSaved(true); }
            finally { setSaving(false); }
          }}>保存</button>
      </div>
      <div className="field__hint">{locked ? "由环境变量 COGNI_PROJECTS_ROOT 锁定" : saved ? "已保存" : "新建项目时会用它预填仓库路径"}</div>
    </div>
  );
}
```
Render `<HostProjectsRootRow api={api} host={h} />` inside each host's card in the hosts list. Ensure `HostInfo` and `useState` are imported.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Manual smoke (optional, requires running stack)**

With cloud + a registered host running: Settings → Runner Hosts → set 项目根目录 → open New Project → confirm path pre-fills under the new root.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/SettingsPage.tsx packages/ui/src/components/settings.css
git commit -m "feat(ui): edit host projects-root in Settings"
```

---

### Task 12: Full build + test sweep

- [ ] **Step 1: Build everything**

Run: `pnpm build`
Expected: success (writes `dist/`).

- [ ] **Step 2: Typecheck + test**

Run: `pnpm typecheck && pnpm test`
Expected: all green.

- [ ] **Step 3: Deploy notes (not auto-run)**

- Cloud: run the migration once, then restart — see `docs/DEPLOYMENT.md`:
  `ssh prod-cognit 'sudo -u cogni bash -lc "cd /opt/cogni/packages/cloud && pnpm exec tsx --env-file=.env src/scripts/migrate-2026-05-20-host-projects-root.ts"'`
- Host changes ship inside the desktop app bundle — they take effect only after a desktop rebuild/reinstall (`/ship`), since the running daemon is the packaged `cogni-runner-host` binary.

---

## Notes for the implementer

- This plan assumes the tilde fix (`paths.ts`) is already present. If `expandTilde` is missing, stop and add it first (see spec "Relationship to the tilde fix").
- Old hosts that don't report `projectsRoot` leave the column null → `GET /hosts` returns `projectsRoot: null` → NewProject simply doesn't pre-fill (`suggestRepoPath` returns `""`). No errors; today's manual entry still works.
- `noUncheckedIndexedAccess` + `verbatimModuleSyntax` are on globally — use `import type` for type-only imports and treat array/record lookups as possibly-undefined.
