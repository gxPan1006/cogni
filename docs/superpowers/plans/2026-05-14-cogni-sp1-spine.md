# Cogni SP-1「脊梁」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一个穿透「账户 / 数据 / runner 抽象 / 云↔桌面拓扑」四根支柱的最小端到端闭环:桌面登录 → 在 chat 里发消息 → 云端路由到本地 Runner Host → Claude Code 跑起来 → 流式回桌面 → 全程持久化在 Neon。

**Architecture:** Node + TS pnpm monorepo,4 个包:`contract`(唯一耦合面,zod schema + 推导类型)、`cloud`(Hono 控制面 + Neon/drizzle + host-router + chat 域)、`runner-host`(独立 daemon + Claude Code adapter)、`apps/desktop`(Tauri 2 + React UI 壳)。云端是唯一真相源;Runner Host 主动拨 WebSocket 上云;桌面 app 与 daemon 是两个独立进程。

**Tech Stack:** TypeScript (strict), Node ≥20.10, pnpm workspaces, Hono + `@hono/node-ws`, drizzle-orm + Neon (`@neondatabase/serverless`), `@electric-sql/pglite` (测试用内存 Postgres), `arctic` (Google OAuth), `jose` (JWT), `execa` (子进程), `vitest`, Tauri 2 + React + Vite, `tauri-plugin-deep-link`。

---

## File Structure

```
cogni/
├── package.json                      # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts                  # root config, projects = packages/*
├── packages/
│   ├── contract/
│   │   └── src/
│   │       ├── runner.ts             # RunnerAdapter / RunnerEvent / capabilities
│   │       ├── protocol.ts           # host↔cloud + client↔cloud WS message schemas
│   │       ├── domain.ts             # API row/view shapes
│   │       └── index.ts              # re-exports
│   ├── cloud/
│   │   └── src/
│   │       ├── db/
│   │       │   ├── schema.ts         # drizzle table defs
│   │       │   ├── client.ts         # Neon connection factory
│   │       │   ├── test-db.ts        # pglite harness for tests
│   │       │   ├── users.ts          # user/tenant repository
│   │       │   ├── hosts.ts          # host repository
│   │       │   ├── threads.ts        # thread + message repository
│   │       │   └── sessions.ts       # runner_session + event repository (seq)
│   │       ├── host-router.ts        # in-memory connected-host registry
│   │       ├── domains/chat.ts       # chat orchestrator
│   │       ├── auth.ts               # JWT issue/verify + arctic Google client
│   │       ├── server.ts             # Hono app: routes + WS endpoints
│   │       └── main.ts               # boot
│   ├── runner-host/
│   │   └── src/
│   │       ├── config.ts             # ~/.cogni/host.json read/write
│   │       ├── adapters/claude-code.ts  # ClaudeCodeAdapter
│   │       ├── runner-manager.ts     # active session handles
│   │       ├── registry.ts           # WS client → cloud, dispatch loop, reconnect
│   │       └── main.ts               # boot
│   └── shared/
│       └── src/log.ts                # pino logger
└── apps/
    └── desktop/
        ├── src-tauri/                # Rust shell + deep-link plugin
        └── src/                      # React: App, Login, Sidebar, Conversation, hooks
```

---

## Phase 0 — Monorepo Foundation

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.npmrc`
- Create: `packages/contract/package.json`, `packages/contract/tsconfig.json`
- Create: `packages/cloud/package.json`, `packages/cloud/tsconfig.json`
- Create: `packages/runner-host/package.json`, `packages/runner-host/tsconfig.json`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/log.ts`

- [ ] **Step 1: Create workspace root files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`package.json`:
```json
{
  "name": "cogni",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.10.0" },
  "scripts": {
    "build": "pnpm -r --filter ./packages/* build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "devDependencies": {
    "typescript": "^5.7.3",
    "vitest": "^2.1.8",
    "tsx": "^4.19.2",
    "@types/node": "^22.10.5",
    "eslint": "^9.18.0",
    "@typescript-eslint/eslint-plugin": "^8.20.0",
    "@typescript-eslint/parser": "^8.20.0",
    "prettier": "^3.4.2"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["packages/*/src/**/*.test.ts"], environment: "node" },
});
```

`.npmrc`:
```
auto-install-peers=true
```

- [ ] **Step 2: Create each package's package.json + tsconfig.json**

For `packages/contract/package.json` (repeat the shape for `cloud`, `runner-host`, `shared`, swapping `name` and deps):
```json
{
  "name": "@cogni/contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "zod": "^3.24.1" }
}
```

`packages/contract/tsconfig.json` (same shape for each package; `cloud`/`runner-host`/`shared` add `"references"` to `../contract`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "composite": true },
  "include": ["src"]
}
```

`packages/cloud/package.json` deps: `@cogni/contract` (`workspace:*`), `@cogni/shared` (`workspace:*`), `hono`, `@hono/node-server`, `@hono/node-ws`, `drizzle-orm`, `@neondatabase/serverless`, `arctic`, `jose`, `zod`. devDeps: `@electric-sql/pglite`, `drizzle-kit`, `ws`, `@types/ws` (the e2e test drives the server with a `ws` client).
`packages/runner-host/package.json` deps: `@cogni/contract`, `@cogni/shared`, `execa`, `ws`, `zod`. devDeps: `@types/ws`.
`packages/shared/package.json` deps: `pino`.

- [ ] **Step 3: Create `packages/shared/src/log.ts`**

```ts
import pino from "pino";
export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
export type Logger = typeof logger;
```

- [ ] **Step 4: Install and verify**

Run: `pnpm install && pnpm -r exec tsc --version`
Expected: install completes, tsc prints a 5.x version per package.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo (contract/cloud/runner-host/shared)"
```

---

## Phase 1 — `contract` Package (the only coupling surface)

### Task 2: Runner abstraction types

**Files:**
- Create: `packages/contract/src/runner.ts`
- Test: `packages/contract/src/runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { runnerEventSchema, RUNNER_CAPABILITIES } from "./runner.js";

describe("runnerEventSchema", () => {
  it("accepts a text event", () => {
    const r = runnerEventSchema.safeParse({ type: "text", text: "hi" });
    expect(r.success).toBe(true);
  });
  it("accepts a session-id event", () => {
    expect(runnerEventSchema.safeParse({ type: "session-id", id: "abc" }).success).toBe(true);
  });
  it("rejects an unknown event type", () => {
    expect(runnerEventSchema.safeParse({ type: "nope" }).success).toBe(false);
  });
  it("rejects a text event missing text", () => {
    expect(runnerEventSchema.safeParse({ type: "text" }).success).toBe(false);
  });
  it("exposes the seven declared capabilities", () => {
    expect(RUNNER_CAPABILITIES).toContain("streaming");
    expect(RUNNER_CAPABILITIES).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/contract/src/runner.test.ts`
Expected: FAIL — cannot resolve `./runner.js`.

- [ ] **Step 3: Write `packages/contract/src/runner.ts`**

```ts
import { z } from "zod";

export const RUNNER_CAPABILITIES = [
  "streaming",
  "session-resume",
  "tool-events",
  "permission-prompt",
  "memory-injection",
  "active-injection",
  "attachments",
] as const;
export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

export const runnerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session-id"), id: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool-call"), toolId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool-result"), toolId: z.string(), output: z.unknown() }),
  z.object({ type: z.literal("permission-request"), toolId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("done"), usage: z.record(z.number()).optional() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

export interface StartSessionOpts {
  /** Working directory for the runner process. The Runner Host derives this per thread. */
  cwd: string;
}

export interface RunnerSessionHandle {
  /** The runner's own session id once known (Claude's `session_id`); null until first event. */
  readonly runnerSessionId: string | null;
  /** Send one user message; yields events until the turn ends with `done` or `error`. */
  send(message: string): AsyncIterable<RunnerEvent>;
  close(): Promise<void>;
}

export interface RunnerAdapter {
  readonly id: string;
  readonly capabilities: readonly RunnerCapability[];
  startSession(opts: StartSessionOpts): Promise<RunnerSessionHandle>;
  resumeSession(runnerSessionId: string, opts: StartSessionOpts): Promise<RunnerSessionHandle>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/contract/src/runner.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contract && git commit -m "feat(contract): runner abstraction types + RunnerEvent schema"
```

### Task 3: Protocol + domain types

**Files:**
- Create: `packages/contract/src/protocol.ts`
- Create: `packages/contract/src/domain.ts`
- Create: `packages/contract/src/index.ts`
- Test: `packages/contract/src/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { hostToCloudSchema, cloudToHostSchema, clientToCloudSchema, cloudToClientSchema } from "./protocol.js";

describe("protocol schemas", () => {
  it("parses a host register message", () => {
    const r = hostToCloudSchema.safeParse({
      t: "register", hostId: "h1", capabilities: ["streaming"], adapters: ["claude-code"], version: "0.0.0",
    });
    expect(r.success).toBe(true);
  });
  it("parses a cloud dispatch with null runnerSessionId", () => {
    const r = cloudToHostSchema.safeParse({
      t: "dispatch", sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "hi",
    });
    expect(r.success).toBe(true);
  });
  it("parses a client send message", () => {
    expect(clientToCloudSchema.safeParse({ t: "send", threadId: "t1", text: "hi" }).success).toBe(true);
  });
  it("parses a cloud→client event with seq", () => {
    const r = cloudToClientSchema.safeParse({
      t: "event", threadId: "t1", seq: 3, event: { type: "text", text: "hi" },
    });
    expect(r.success).toBe(true);
  });
  it("rejects an unknown host message tag", () => {
    expect(hostToCloudSchema.safeParse({ t: "bogus" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/contract/src/protocol.test.ts`
Expected: FAIL — cannot resolve `./protocol.js`.

- [ ] **Step 3: Write `protocol.ts`, `domain.ts`, `index.ts`**

`packages/contract/src/protocol.ts`:
```ts
import { z } from "zod";
import { runnerEventSchema, RUNNER_CAPABILITIES } from "./runner.js";

export const sessionStatusSchema = z.enum(["running", "completed", "failed"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

// ---- Runner Host → Cloud ----
export const hostToCloudSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("register"),
    hostId: z.string(),
    capabilities: z.array(z.enum(RUNNER_CAPABILITIES)),
    adapters: z.array(z.string()),
    version: z.string(),
  }),
  z.object({ t: z.literal("heartbeat") }),
  z.object({ t: z.literal("event"), sessionId: z.string(), event: runnerEventSchema }),
  z.object({ t: z.literal("session-update"), sessionId: z.string(), status: sessionStatusSchema }),
]);
export type HostToCloud = z.infer<typeof hostToCloudSchema>;

// ---- Cloud → Runner Host ----
export const cloudToHostSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("registered") }),
  z.object({
    t: z.literal("dispatch"),
    sessionId: z.string(),
    threadId: z.string(),
    adapter: z.string(),
    runnerSessionId: z.string().nullable(),
    message: z.string(),
  }),
]);
export type CloudToHost = z.infer<typeof cloudToHostSchema>;

// ---- Client → Cloud ----
export const clientToCloudSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("subscribe"), threadId: z.string() }),
  z.object({ t: z.literal("send"), threadId: z.string(), text: z.string() }),
]);
export type ClientToCloud = z.infer<typeof clientToCloudSchema>;

// ---- Cloud → Client ----
export const cloudToClientSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("event"), threadId: z.string(), seq: z.number(), event: runnerEventSchema }),
  z.object({
    t: z.literal("message"),
    threadId: z.string(),
    messageId: z.string(),
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    createdAt: z.string(),
  }),
  z.object({ t: z.literal("host-status"), online: z.boolean() }),
  z.object({ t: z.literal("error"), message: z.string() }),
]);
export type CloudToClient = z.infer<typeof cloudToClientSchema>;
```

`packages/contract/src/domain.ts`:
```ts
export type Role = "user" | "assistant" | "system";
export type RunnerSessionStatus = "idle" | "running" | "completed" | "failed";
export type HostConnState = "online" | "offline";

/** GET /api/threads */
export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
}
/** GET /api/threads/:id */
export interface ThreadDetail {
  id: string;
  title: string;
  messages: MessageView[];
}
export interface MessageView {
  id: string;
  threadId: string;
  role: Role;
  content: string;
  createdAt: string;
}
/** GET /api/threads/:id/events?since=N */
export interface EventView {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
}
/** POST /api/hosts response */
export interface HostRegistration {
  hostId: string;
  registrationToken: string;
}
```

`packages/contract/src/index.ts`:
```ts
export * from "./runner.js";
export * from "./protocol.js";
export * from "./domain.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/contract/src/protocol.test.ts && pnpm --filter @cogni/contract build`
Expected: PASS (5 tests); build emits `dist/`.

- [ ] **Step 5: Commit**

```bash
git add packages/contract && git commit -m "feat(contract): host/client WS protocol schemas + domain view types"
```

---

## Phase 2 — `cloud` Data Layer (Neon = single source of truth)

### Task 4: drizzle schema + DB clients + pglite test harness

**Files:**
- Create: `packages/cloud/src/db/schema.ts`
- Create: `packages/cloud/src/db/client.ts`
- Create: `packages/cloud/src/db/test-db.ts`
- Create: `packages/cloud/drizzle.config.ts`
- Test: `packages/cloud/src/db/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { tenants } from "./schema.js";

describe("schema + test-db", () => {
  it("creates all tables and round-trips a tenant", async () => {
    const { db, close } = await makeTestDb();
    const [row] = await db.insert(tenants).values({ name: "acme" }).returning();
    expect(row?.name).toBe("acme");
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    await close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/db/schema.test.ts`
Expected: FAIL — cannot resolve `./test-db.js`.

- [ ] **Step 3: Write the schema, clients, and config**

`packages/cloud/src/db/schema.ts`:
```ts
import { pgTable, uuid, text, timestamp, integer, jsonb, index, unique } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  email: text("email").notNull().unique(),
  oauthSub: text("oauth_sub").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const hosts = pgTable("hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("offline"),
  registrationToken: text("registration_token").notNull().unique(),
  capabilitiesJson: jsonb("capabilities_json").notNull().default([]),
  lastSeen: timestamp("last_seen"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  title: text("title").notNull().default("New chat"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const runnerSessions = pgTable("runner_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  hostId: uuid("host_id").references(() => hosts.id),
  adapter: text("adapter").notNull(),
  runnerSessionId: text("runner_session_id"),
  status: text("status").notNull().default("idle"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  sessionId: uuid("session_id").notNull().references(() => runnerSessions.id),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payloadJson: jsonb("payload_json").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  threadSeq: unique("events_thread_seq_uq").on(t.threadId, t.seq),
  threadSeqIdx: index("events_thread_seq_idx").on(t.threadId, t.seq),
}));
```

`packages/cloud/src/db/client.ts`:
```ts
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool } from "@neondatabase/serverless";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export function makeDb(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema });
}
export type AppDb = ReturnType<typeof makeDb>;

/**
 * The single DB type every repository and domain accepts. Both the Neon client
 * (`makeDb`) and the pglite test client (`makeTestDb`) produce a drizzle
 * instance assignable to this, so production and test paths share one signature.
 */
export type AnyDb = PgDatabase<any, typeof schema, any>;
```

`packages/cloud/src/db/test-db.ts` (pglite — real Postgres semantics, in-memory):
```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";

const DDL = `
CREATE TABLE tenants (id uuid primary key default gen_random_uuid(), name text not null, created_at timestamp not null default now());
CREATE TABLE users (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), email text not null unique, oauth_sub text not null unique, created_at timestamp not null default now());
CREATE TABLE hosts (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), name text not null, status text not null default 'offline', registration_token text not null unique, capabilities_json jsonb not null default '[]', last_seen timestamp, created_at timestamp not null default now());
CREATE TABLE threads (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), title text not null default 'New chat', created_at timestamp not null default now(), updated_at timestamp not null default now());
CREATE TABLE messages (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), role text not null, content text not null, created_at timestamp not null default now());
CREATE TABLE runner_sessions (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), host_id uuid references hosts(id), adapter text not null, runner_session_id text, status text not null default 'idle', created_at timestamp not null default now());
CREATE TABLE events (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), session_id uuid not null references runner_sessions(id), seq integer not null, type text not null, payload_json jsonb not null, created_at timestamp not null default now(), constraint events_thread_seq_uq unique (thread_id, seq));
`;

export async function makeTestDb() {
  const pg = new PGlite();
  await pg.exec(DDL);
  const db = drizzle(pg, { schema });
  return { db, close: () => pg.close() };
}
export type TestDb = Awaited<ReturnType<typeof makeTestDb>>["db"];
```

> Note: `test-db.ts` keeps DDL in sync with `schema.ts` by hand for SP-1. When `drizzle-kit` migrations land in SP-2, replace `DDL` with the generated migration SQL.

`packages/cloud/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/db/schema.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/cloud && git commit -m "feat(cloud): drizzle schema + Neon client + pglite test harness"
```

### Task 5: User/tenant + host repositories

**Files:**
- Create: `packages/cloud/src/db/users.ts`
- Create: `packages/cloud/src/db/hosts.ts`
- Test: `packages/cloud/src/db/users.test.ts`, `packages/cloud/src/db/hosts.test.ts`

- [ ] **Step 1: Write the failing tests**

`users.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUser } from "./users.js";

describe("findOrCreateUser", () => {
  it("creates a tenant+user on first sight, returns same user on second", async () => {
    const { db, close } = await makeTestDb();
    const a = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    const b = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    expect(a.id).toBe(b.id);
    expect(a.tenantId).toBe(b.tenantId);
    await close();
  });
});
```

`hosts.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cloud/src/db/users.test.ts packages/cloud/src/db/hosts.test.ts`
Expected: FAIL — cannot resolve `./users.js` / `./hosts.js`.

- [ ] **Step 3: Write `users.ts` and `hosts.ts`**

`packages/cloud/src/db/users.ts`:
```ts
import { eq } from "drizzle-orm";
import { tenants, users } from "./schema.js";
import type { AnyDb } from "./client.js";

export type { AnyDb };
export interface AppUser { id: string; tenantId: string; email: string; }

export async function findOrCreateUser(
  db: AnyDb,
  input: { oauthSub: string; email: string },
): Promise<AppUser> {
  const existing = await db.select().from(users).where(eq(users.oauthSub, input.oauthSub)).limit(1);
  if (existing[0]) {
    return { id: existing[0].id, tenantId: existing[0].tenantId, email: existing[0].email };
  }
  // SP-1: one tenant per user. SP-2 will introduce real org/tenant membership.
  const [tenant] = await db.insert(tenants).values({ name: input.email }).returning();
  const [created] = await db
    .insert(users)
    .values({ tenantId: tenant!.id, email: input.email, oauthSub: input.oauthSub })
    .returning();
  return { id: created!.id, tenantId: created!.tenantId, email: created!.email };
}
```

`packages/cloud/src/db/hosts.ts`:
```ts
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { hosts } from "./schema.js";
import type { AnyDb } from "./users.js";
import type { HostRegistration } from "@cogni/contract";

export async function createHost(
  db: AnyDb,
  input: { userId: string; tenantId: string; name: string },
): Promise<HostRegistration> {
  const registrationToken = randomBytes(32).toString("hex");
  const [row] = await db
    .insert(hosts)
    .values({ userId: input.userId, tenantId: input.tenantId, name: input.name, registrationToken })
    .returning();
  return { hostId: row!.id, registrationToken };
}

export async function findHostByToken(db: AnyDb, token: string) {
  const rows = await db.select().from(hosts).where(eq(hosts.registrationToken, token)).limit(1);
  return rows[0] ?? null;
}

export async function setHostStatus(
  db: AnyDb,
  hostId: string,
  status: "online" | "offline",
  capabilities: string[] = [],
): Promise<void> {
  await db
    .update(hosts)
    .set({ status, capabilitiesJson: capabilities, lastSeen: new Date() })
    .where(eq(hosts.id, hostId));
}

export async function getUserHosts(db: AnyDb, userId: string) {
  return db.select().from(hosts).where(eq(hosts.userId, userId));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/cloud/src/db/users.test.ts packages/cloud/src/db/hosts.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cloud && git commit -m "feat(cloud): user/tenant + host repositories"
```

### Task 6: Thread + message repository

**Files:**
- Create: `packages/cloud/src/db/threads.ts`
- Test: `packages/cloud/src/db/threads.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUser } from "./users.js";
import { createThread, listThreads, getThreadDetail, appendMessage, touchThread } from "./threads.js";

describe("thread repository", () => {
  it("creates, lists, appends messages, and reads back detail", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    expect(thread.title).toBe("New chat");

    await appendMessage(db, { threadId: thread.id, role: "user", content: "hello" });
    await appendMessage(db, { threadId: thread.id, role: "assistant", content: "hi there" });

    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages.map((m) => m.content)).toEqual(["hello", "hi there"]);

    const list = await listThreads(db, user.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(thread.id);
    await close();
  });

  it("touchThread bumps updatedAt for ordering", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUser(db, { oauthSub: "g|2", email: "b@x.com" });
    const t1 = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    const t2 = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    await touchThread(db, t1.id);
    const list = await listThreads(db, user.id);
    expect(list[0]?.id).toBe(t1.id); // most-recently-touched first
    await close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/db/threads.test.ts`
Expected: FAIL — cannot resolve `./threads.js`.

- [ ] **Step 3: Write `threads.ts`**

```ts
import { eq, desc, asc } from "drizzle-orm";
import { threads, messages } from "./schema.js";
import type { AnyDb } from "./users.js";
import type { ThreadSummary, ThreadDetail, MessageView, Role } from "@cogni/contract";

export async function createThread(
  db: AnyDb,
  input: { userId: string; tenantId: string; title?: string },
): Promise<ThreadSummary> {
  const [row] = await db
    .insert(threads)
    .values({ userId: input.userId, tenantId: input.tenantId, title: input.title ?? "New chat" })
    .returning();
  return { id: row!.id, title: row!.title, updatedAt: row!.updatedAt.toISOString() };
}

export async function listThreads(db: AnyDb, userId: string): Promise<ThreadSummary[]> {
  const rows = await db
    .select()
    .from(threads)
    .where(eq(threads.userId, userId))
    .orderBy(desc(threads.updatedAt));
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}

export async function getThreadDetail(db: AnyDb, threadId: string): Promise<ThreadDetail | null> {
  const t = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
  if (!t[0]) return null;
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt));
  return {
    id: t[0].id,
    title: t[0].title,
    messages: msgs.map(toMessageView),
  };
}

export async function appendMessage(
  db: AnyDb,
  input: { threadId: string; role: Role; content: string },
): Promise<MessageView> {
  const [row] = await db
    .insert(messages)
    .values({ threadId: input.threadId, role: input.role, content: input.content })
    .returning();
  return toMessageView(row!);
}

export async function touchThread(db: AnyDb, threadId: string): Promise<void> {
  await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
}

function toMessageView(r: typeof messages.$inferSelect): MessageView {
  return {
    id: r.id,
    threadId: r.threadId,
    role: r.role as Role,
    content: r.content,
    createdAt: r.createdAt.toISOString(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/db/threads.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cloud && git commit -m "feat(cloud): thread + message repository"
```

### Task 7: Runner-session + event repository (per-thread seq)

**Files:**
- Create: `packages/cloud/src/db/sessions.ts`
- Test: `packages/cloud/src/db/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUser } from "./users.js";
import { createThread } from "./threads.js";
import {
  getOrCreateRunnerSession, getRunnerSessionById, setRunnerSessionId, setRunnerSessionStatus,
  appendEvent, listEventsSince,
} from "./sessions.js";

describe("session + event repository", () => {
  it("reuses one runner_session per thread", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const s1 = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    const s2 = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    expect(s1.id).toBe(s2.id);
    await close();
  });

  it("assigns monotonic per-thread seq and lists events since N", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const s = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    const e1 = await appendEvent(db, { threadId: thread.id, sessionId: s.id, event: { type: "text", text: "a" } });
    const e2 = await appendEvent(db, { threadId: thread.id, sessionId: s.id, event: { type: "text", text: "b" } });
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    const since = await listEventsSince(db, thread.id, 1);
    expect(since.map((e) => e.seq)).toEqual([2]);
    await close();
  });

  it("tracks runnerSessionId and status", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const s = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    await setRunnerSessionId(db, s.id, "claude-xyz");
    await setRunnerSessionStatus(db, s.id, "running");
    const again = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    expect(again.runnerSessionId).toBe("claude-xyz");
    expect(again.status).toBe("running");
    const byId = await getRunnerSessionById(db, s.id);
    expect(byId?.threadId).toBe(thread.id);
    await close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/db/sessions.test.ts`
Expected: FAIL — cannot resolve `./sessions.js`.

- [ ] **Step 3: Write `sessions.ts`**

```ts
import { eq, and, gt, asc, sql } from "drizzle-orm";
import { runnerSessions, events } from "./schema.js";
import type { AnyDb } from "./users.js";
import type { RunnerEvent, EventView, RunnerSessionStatus } from "@cogni/contract";

export interface RunnerSessionRow {
  id: string;
  threadId: string;
  adapter: string;
  runnerSessionId: string | null;
  status: RunnerSessionStatus;
}

export async function getOrCreateRunnerSession(
  db: AnyDb,
  threadId: string,
  adapter: string,
): Promise<RunnerSessionRow> {
  const existing = await db
    .select()
    .from(runnerSessions)
    .where(eq(runnerSessions.threadId, threadId))
    .limit(1);
  if (existing[0]) return toRow(existing[0]);
  const [row] = await db
    .insert(runnerSessions)
    .values({ threadId, adapter })
    .returning();
  return toRow(row!);
}

export async function getRunnerSessionById(db: AnyDb, sessionId: string): Promise<RunnerSessionRow | null> {
  const rows = await db.select().from(runnerSessions).where(eq(runnerSessions.id, sessionId)).limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function setRunnerSessionId(db: AnyDb, sessionId: string, runnerSessionId: string) {
  await db.update(runnerSessions).set({ runnerSessionId }).where(eq(runnerSessions.id, sessionId));
}

export async function setRunnerSessionStatus(db: AnyDb, sessionId: string, status: RunnerSessionStatus) {
  await db.update(runnerSessions).set({ status }).where(eq(runnerSessions.id, sessionId));
}

/**
 * Append one event to a thread's stream. seq is the next per-thread integer.
 * SP-1 runs one Runner Host per user so events for a thread arrive serially;
 * the `events_thread_seq_uq` constraint is the backstop if that ever breaks.
 */
export async function appendEvent(
  db: AnyDb,
  input: { threadId: string; sessionId: string; event: RunnerEvent },
): Promise<EventView> {
  const nextSeq = sql<number>`(SELECT COALESCE(MAX(${events.seq}), 0) + 1 FROM ${events} WHERE ${events.threadId} = ${input.threadId})`;
  const [row] = await db
    .insert(events)
    .values({
      threadId: input.threadId,
      sessionId: input.sessionId,
      seq: nextSeq,
      type: input.event.type,
      payloadJson: input.event,
    })
    .returning();
  return { seq: row!.seq, type: row!.type, payload: row!.payloadJson, createdAt: row!.createdAt.toISOString() };
}

export async function listEventsSince(db: AnyDb, threadId: string, sinceSeq: number): Promise<EventView[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.threadId, threadId), gt(events.seq, sinceSeq)))
    .orderBy(asc(events.seq));
  return rows.map((r) => ({
    seq: r.seq,
    type: r.type,
    payload: r.payloadJson,
    createdAt: r.createdAt.toISOString(),
  }));
}

function toRow(r: typeof runnerSessions.$inferSelect): RunnerSessionRow {
  return {
    id: r.id,
    threadId: r.threadId,
    adapter: r.adapter,
    runnerSessionId: r.runnerSessionId,
    status: r.status as RunnerSessionStatus,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/db/sessions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cloud && git commit -m "feat(cloud): runner-session + event repository with per-thread seq"
```

---

## Phase 3 — `cloud` Domain Logic (transport-free, fully unit-tested)

These two units hold all the routing/orchestration logic. They take `send` callbacks instead of real sockets, so they are tested without any network.

### Task 8: Host router + client hub

**Files:**
- Create: `packages/cloud/src/host-router.ts`
- Create: `packages/cloud/src/client-hub.ts`
- Test: `packages/cloud/src/host-router.test.ts`, `packages/cloud/src/client-hub.test.ts`

- [ ] **Step 1: Write the failing tests**

`host-router.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { HostRouter } from "./host-router.js";

describe("HostRouter", () => {
  it("routes a dispatch to the user's connected host", () => {
    const router = new HostRouter();
    const send = vi.fn();
    router.register({ hostId: "h1", userId: "u1", send });
    const ok = router.dispatch("u1", { t: "dispatch", sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "hi" });
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });
  it("returns false when the user has no online host", () => {
    const router = new HostRouter();
    expect(router.dispatch("u1", { t: "registered" })).toBe(false);
  });
  it("forgets a host after unregister", () => {
    const router = new HostRouter();
    router.register({ hostId: "h1", userId: "u1", send: vi.fn() });
    router.unregister("h1");
    expect(router.getHostForUser("u1")).toBeNull();
  });
});
```

`client-hub.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { ClientHub } from "./client-hub.js";

describe("ClientHub", () => {
  it("broadcasts only to clients subscribed to the thread", () => {
    const hub = new ClientHub();
    const a = vi.fn(); const b = vi.fn();
    hub.register({ clientId: "a", userId: "u1", send: a });
    hub.register({ clientId: "b", userId: "u1", send: b });
    hub.subscribe("a", "t1");
    hub.broadcast("t1", { t: "host-status", online: true });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });
  it("stops delivering after unregister", () => {
    const hub = new ClientHub();
    const a = vi.fn();
    hub.register({ clientId: "a", userId: "u1", send: a });
    hub.subscribe("a", "t1");
    hub.unregister("a");
    hub.broadcast("t1", { t: "host-status", online: true });
    expect(a).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/cloud/src/host-router.test.ts packages/cloud/src/client-hub.test.ts`
Expected: FAIL — cannot resolve `./host-router.js` / `./client-hub.js`.

- [ ] **Step 3: Write `host-router.ts` and `client-hub.ts`**

`packages/cloud/src/host-router.ts`:
```ts
import type { CloudToHost } from "@cogni/contract";

export interface ConnectedHost {
  hostId: string;
  userId: string;
  send: (msg: CloudToHost) => void;
}

/** In-memory registry of Runner Hosts that currently hold a live WS to this cloud node. */
export class HostRouter {
  private byHost = new Map<string, ConnectedHost>();
  private byUser = new Map<string, string>(); // userId -> hostId (SP-1: one host per user)

  register(host: ConnectedHost): void {
    this.byHost.set(host.hostId, host);
    this.byUser.set(host.userId, host.hostId);
  }

  unregister(hostId: string): void {
    const host = this.byHost.get(hostId);
    if (!host) return;
    this.byHost.delete(hostId);
    if (this.byUser.get(host.userId) === hostId) this.byUser.delete(host.userId);
  }

  getHostForUser(userId: string): ConnectedHost | null {
    const hostId = this.byUser.get(userId);
    return hostId ? this.byHost.get(hostId) ?? null : null;
  }

  dispatch(userId: string, msg: CloudToHost): boolean {
    const host = this.getHostForUser(userId);
    if (!host) return false;
    host.send(msg);
    return true;
  }
}
```

`packages/cloud/src/client-hub.ts`:
```ts
import type { CloudToClient } from "@cogni/contract";

export interface ConnectedClient {
  clientId: string;
  userId: string;
  send: (msg: CloudToClient) => void;
}

/** In-memory registry of UI clients + their thread subscriptions, for fan-out. */
export class ClientHub {
  private clients = new Map<string, ConnectedClient>();
  private subs = new Map<string, Set<string>>(); // threadId -> clientIds

  register(client: ConnectedClient): void {
    this.clients.set(client.clientId, client);
  }

  unregister(clientId: string): void {
    this.clients.delete(clientId);
    for (const set of this.subs.values()) set.delete(clientId);
  }

  subscribe(clientId: string, threadId: string): void {
    let set = this.subs.get(threadId);
    if (!set) { set = new Set(); this.subs.set(threadId, set); }
    set.add(clientId);
  }

  broadcast(threadId: string, msg: CloudToClient): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    for (const clientId of set) this.clients.get(clientId)?.send(msg);
  }

  sendToUser(userId: string, msg: CloudToClient): void {
    for (const c of this.clients.values()) if (c.userId === userId) c.send(msg);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/cloud/src/host-router.test.ts packages/cloud/src/client-hub.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cloud && git commit -m "feat(cloud): in-memory host router + client hub"
```

### Task 9: Chat domain orchestrator

**Files:**
- Create: `packages/cloud/src/domains/chat.ts`
- Test: `packages/cloud/src/domains/chat.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUser } from "../db/users.js";
import { createThread } from "../db/threads.js";
import { getThreadDetail } from "../db/threads.js";
import { HostRouter } from "../host-router.js";
import { ClientHub } from "../client-hub.js";
import { ChatDomain } from "./chat.js";

describe("ChatDomain", () => {
  it("notifies host-status:false when no host is online", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const hub = new ClientHub();
    const send = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send });
    hub.subscribe("c1", thread.id);
    const chat = new ChatDomain(db, new HostRouter(), hub);

    await chat.handleClientSend(u.id, thread.id, "hello");

    // user message persisted + broadcast, then host-status:false
    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages.map((m) => m.content)).toEqual(["hello"]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ t: "host-status", online: false }));
    await close();
  });

  it("dispatches to the host and walks a full turn back to a persisted assistant message", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const hub = new ClientHub();
    const clientSend = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send: clientSend });
    hub.subscribe("c1", thread.id);
    const router = new HostRouter();
    const hostSend = vi.fn();
    router.register({ hostId: "h1", userId: u.id, send: hostSend });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend(u.id, thread.id, "hi");
    const dispatch = hostSend.mock.calls[0]![0];
    expect(dispatch).toMatchObject({ t: "dispatch", threadId: thread.id, runnerSessionId: null, message: "hi" });
    const sessionId = dispatch.sessionId;

    await chat.handleHostEvent(sessionId, { type: "session-id", id: "claude-1" });
    await chat.handleHostEvent(sessionId, { type: "text", text: "hello back" });
    await chat.handleHostEvent(sessionId, { type: "done" });

    // assistant message persisted from accumulated text
    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:hi",
      "assistant:hello back",
    ]);
    // events fanned out to the client with monotonic seq
    const eventMsgs = clientSend.mock.calls.map((c) => c[0]).filter((m) => m.t === "event");
    expect(eventMsgs.map((m) => m.seq)).toEqual([1, 2, 3]);

    // second turn resumes with the stored runnerSessionId
    await chat.handleClientSend(u.id, thread.id, "again");
    expect(hostSend.mock.calls[1]![0]).toMatchObject({ runnerSessionId: "claude-1", message: "again" });
    await close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/domains/chat.test.ts`
Expected: FAIL — cannot resolve `./chat.js`.

- [ ] **Step 3: Write `domains/chat.ts`**

```ts
import type { RunnerEvent, SessionStatus } from "@cogni/contract";
import type { AnyDb } from "../db/users.js";
import { appendMessage, touchThread } from "../db/threads.js";
import {
  getOrCreateRunnerSession, getRunnerSessionById,
  setRunnerSessionId, setRunnerSessionStatus, appendEvent,
} from "../db/sessions.js";
import type { HostRouter } from "../host-router.js";
import type { ClientHub } from "../client-hub.js";

const ADAPTER = "claude-code"; // SP-1: chat domain always uses Claude Code

/**
 * Chat domain: one thread ↔ one long-lived runner session, interactive.
 * Owns the round trip: client message → persist → dispatch to host →
 * ingest streamed events → persist (events + assistant message) → fan-out.
 */
export class ChatDomain {
  /** sessionId → accumulated assistant text for the in-flight turn. */
  private accumulating = new Map<string, string>();

  constructor(
    private readonly db: AnyDb,
    private readonly hosts: HostRouter,
    private readonly clients: ClientHub,
  ) {}

  async handleClientSend(userId: string, threadId: string, text: string): Promise<void> {
    const userMsg = await appendMessage(this.db, { threadId, role: "user", content: text });
    await touchThread(this.db, threadId);
    this.clients.broadcast(threadId, {
      t: "message", threadId, messageId: userMsg.id, role: "user",
      content: userMsg.content, createdAt: userMsg.createdAt,
    });

    const session = await getOrCreateRunnerSession(this.db, threadId, ADAPTER);
    const host = this.hosts.getHostForUser(userId);
    if (!host) {
      this.clients.broadcast(threadId, { t: "host-status", online: false });
      return; // SP-1: message is persisted; user re-sends once a host is online
    }

    await setRunnerSessionStatus(this.db, session.id, "running");
    host.send({
      t: "dispatch",
      sessionId: session.id,
      threadId,
      adapter: ADAPTER,
      runnerSessionId: session.runnerSessionId,
      message: text,
    });
  }

  async handleHostEvent(sessionId: string, event: RunnerEvent): Promise<void> {
    const session = await getRunnerSessionById(this.db, sessionId);
    if (!session) return;
    const threadId = session.threadId;

    const stored = await appendEvent(this.db, { threadId, sessionId, event });

    if (event.type === "session-id") {
      await setRunnerSessionId(this.db, sessionId, event.id);
    } else if (event.type === "text") {
      this.accumulating.set(sessionId, (this.accumulating.get(sessionId) ?? "") + event.text);
    } else if (event.type === "done") {
      const text = this.accumulating.get(sessionId) ?? "";
      this.accumulating.delete(sessionId);
      if (text.trim()) {
        const msg = await appendMessage(this.db, { threadId, role: "assistant", content: text });
        this.clients.broadcast(threadId, {
          t: "message", threadId, messageId: msg.id, role: "assistant",
          content: msg.content, createdAt: msg.createdAt,
        });
      }
      await setRunnerSessionStatus(this.db, sessionId, "completed");
    } else if (event.type === "error") {
      this.accumulating.delete(sessionId);
      await setRunnerSessionStatus(this.db, sessionId, "failed");
    }

    this.clients.broadcast(threadId, { t: "event", threadId, seq: stored.seq, event });
  }

  async handleSessionUpdate(sessionId: string, status: SessionStatus): Promise<void> {
    await setRunnerSessionStatus(this.db, sessionId, status);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/domains/chat.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cloud && git commit -m "feat(cloud): chat domain orchestrator"
```

---

## Phase 4 — `cloud` Server (Hono + WebSocket wiring)

`server.ts` builds the Hono app and the node-ws helper, then delegates to route modules so each task is self-contained. Route modules are added in Tasks 11–13.

### Task 10: Env loader + JWT auth + server skeleton

**Files:**
- Create: `packages/cloud/src/env.ts`
- Create: `packages/cloud/src/auth.ts`
- Create: `packages/cloud/src/server.ts`
- Create: `packages/cloud/.env.example`
- Test: `packages/cloud/src/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { makeAuth } from "./auth.js";

const auth = makeAuth({
  jwtSecret: "test-secret-test-secret-test-sec",
  google: { clientId: "x", clientSecret: "y", redirectUri: "http://localhost/cb" },
});

describe("makeAuth", () => {
  it("round-trips a session token", async () => {
    const token = await auth.issueToken({ userId: "u1", tenantId: "t1" });
    expect(await auth.verifyToken(token)).toEqual({ userId: "u1", tenantId: "t1" });
  });
  it("rejects a tampered token", async () => {
    const token = await auth.issueToken({ userId: "u1", tenantId: "t1" });
    expect(await auth.verifyToken(token + "x")).toBeNull();
  });
  it("rejects garbage", async () => {
    expect(await auth.verifyToken("not-a-jwt")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/auth.test.ts`
Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 3: Write `env.ts`, `auth.ts`, `server.ts`, `.env.example`**

`packages/cloud/src/env.ts`:
```ts
export interface Env {
  databaseUrl: string;
  jwtSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  publicUrl: string;
  port: number;
}
export function loadEnv(): Env {
  const get = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env var: ${k}`);
    return v;
  };
  return {
    databaseUrl: get("DATABASE_URL"),
    jwtSecret: get("JWT_SECRET"),
    googleClientId: get("GOOGLE_CLIENT_ID"),
    googleClientSecret: get("GOOGLE_CLIENT_SECRET"),
    publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8787",
    port: Number(process.env.PORT ?? 8787),
  };
}
```

`packages/cloud/src/auth.ts`:
```ts
import { SignJWT, jwtVerify } from "jose";
import { Google } from "arctic";

export interface SessionClaims { userId: string; tenantId: string; }

export function makeAuth(opts: {
  jwtSecret: string;
  google: { clientId: string; clientSecret: string; redirectUri: string };
}) {
  const secret = new TextEncoder().encode(opts.jwtSecret);
  const google = new Google(opts.google.clientId, opts.google.clientSecret, opts.google.redirectUri);
  return {
    google,
    async issueToken(claims: SessionClaims): Promise<string> {
      return new SignJWT({ userId: claims.userId, tenantId: claims.tenantId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(secret);
    },
    async verifyToken(token: string): Promise<SessionClaims | null> {
      try {
        const { payload } = await jwtVerify(token, secret);
        if (typeof payload.userId !== "string" || typeof payload.tenantId !== "string") return null;
        return { userId: payload.userId, tenantId: payload.tenantId };
      } catch {
        return null;
      }
    },
  };
}
export type Auth = ReturnType<typeof makeAuth>;
```

`packages/cloud/src/server.ts`:
```ts
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { AnyDb } from "./db/client.js";
import type { Auth } from "./auth.js";
import type { HostRouter } from "./host-router.js";
import type { ClientHub } from "./client-hub.js";
import type { ChatDomain } from "./domains/chat.js";

export interface ServerDeps {
  db: AnyDb;
  auth: Auth;
  hosts: HostRouter;
  clients: ClientHub;
  chat: ChatDomain;
  publicUrl: string;
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  app.get("/health", (c) => c.json({ ok: true }));

  // registerAuthRoutes(app, deps);            // Task 11
  // registerHostWs(app, upgradeWebSocket, deps);   // Task 12
  // registerClientRoutes(app, upgradeWebSocket, deps); // Task 13

  return { app, injectWebSocket };
}
```

`packages/cloud/.env.example`:
```
DATABASE_URL=postgres://...neon...
JWT_SECRET=change-me-32-bytes-minimum-secret
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
PUBLIC_URL=http://localhost:8787
PORT=8787
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cloud && git commit -m "feat(cloud): env loader + JWT auth + Hono server skeleton"
```

### Task 11: Google OAuth routes

**Files:**
- Create: `packages/cloud/src/routes/auth.ts`
- Modify: `packages/cloud/src/server.ts` (uncomment + import `registerAuthRoutes`)

- [ ] **Step 1: Write `routes/auth.ts`**

```ts
import type { Hono } from "hono";
import { generateState, generateCodeVerifier } from "arctic";
import { decodeIdToken } from "arctic";
import { findOrCreateUser } from "../db/users.js";
import type { ServerDeps } from "../server.js";

interface PendingLogin { codeVerifier: string; redirect: string; createdAt: number }

export function registerAuthRoutes(app: Hono, deps: ServerDeps): void {
  // SP-1: single-node in-memory state store. SP-2 moves this to a shared store.
  const pending = new Map<string, PendingLogin>();
  const TTL_MS = 10 * 60 * 1000;
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.createdAt > TTL_MS) pending.delete(k);
  };

  // Desktop app opens this in the system browser with ?redirect=cogni://auth
  app.get("/auth/google/start", (c) => {
    sweep();
    const redirect = c.req.query("redirect") ?? "cogni://auth";
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    pending.set(state, { codeVerifier, redirect, createdAt: Date.now() });
    const url = deps.auth.google.createAuthorizationURL(state, codeVerifier, ["openid", "email"]);
    return c.redirect(url.toString());
  });

  app.get("/auth/google/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.text("missing code/state", 400);
    const entry = pending.get(state);
    if (!entry) return c.text("unknown or expired state", 400);
    pending.delete(state);

    const tokens = await deps.auth.google.validateAuthorizationCode(code, entry.codeVerifier);
    const claims = decodeIdToken(tokens.idToken()) as { sub: string; email?: string };
    const email = claims.email ?? `${claims.sub}@google`;
    const user = await findOrCreateUser(deps.db, { oauthSub: `google|${claims.sub}`, email });

    const token = await deps.auth.issueToken({ userId: user.id, tenantId: user.tenantId });
    const target = new URL(entry.redirect);
    target.searchParams.set("token", token);
    return c.redirect(target.toString());
  });
}
```

- [ ] **Step 2: Wire it into `server.ts`**

In `server.ts`, add the import at top and replace the Task 11 comment line:
```ts
import { registerAuthRoutes } from "./routes/auth.js";
// ...
  registerAuthRoutes(app, deps);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @cogni/cloud typecheck`
Expected: PASS (no type errors).

> Verification of the live OAuth round trip happens in Task 24 (needs real Google credentials).

- [ ] **Step 4: Commit**

```bash
git add packages/cloud && git commit -m "feat(cloud): Google OAuth start + callback routes"
```

### Task 12: Host WebSocket endpoint

**Files:**
- Create: `packages/cloud/src/routes/host-ws.ts`
- Modify: `packages/cloud/src/server.ts`

- [ ] **Step 1: Write `routes/host-ws.ts`**

```ts
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { hostToCloudSchema } from "@cogni/contract";
import type { CloudToHost } from "@cogni/contract";
import { findHostByToken, setHostStatus } from "../db/hosts.js";
import { logger } from "@cogni/shared";
import type { ServerDeps } from "../server.js";

/**
 * Runner Host dials this with ?token=<registrationToken>. First app message
 * must be `register`; thereafter `event` / `session-update` / `heartbeat`.
 */
export function registerHostWs(app: Hono, upgradeWebSocket: UpgradeWebSocket, deps: ServerDeps): void {
  app.get(
    "/host/ws",
    upgradeWebSocket((c) => {
      const token = c.req.query("token") ?? "";
      let hostId: string | null = null;
      let userId: string | null = null;

      return {
        async onMessage(evt, ws) {
          const parsed = hostToCloudSchema.safeParse(JSON.parse(String(evt.data)));
          if (!parsed.success) return;
          const msg = parsed.data;

          if (msg.t === "register") {
            const host = await findHostByToken(deps.db, token);
            if (!host) { ws.close(4001, "bad token"); return; }
            hostId = host.id;
            userId = host.userId;
            await setHostStatus(deps.db, host.id, "online", msg.capabilities);
            deps.hosts.register({
              hostId: host.id,
              userId: host.userId,
              send: (m: CloudToHost) => ws.send(JSON.stringify(m)),
            });
            ws.send(JSON.stringify({ t: "registered" } satisfies CloudToHost));
            deps.clients.sendToUser(host.userId, { t: "host-status", online: true });
            logger.info({ hostId, userId }, "runner host registered");
            return;
          }
          if (!hostId) return; // ignore anything before register

          if (msg.t === "heartbeat") {
            await setHostStatus(deps.db, hostId, "online");
          } else if (msg.t === "event") {
            await deps.chat.handleHostEvent(msg.sessionId, msg.event);
          } else if (msg.t === "session-update") {
            await deps.chat.handleSessionUpdate(msg.sessionId, msg.status);
          }
        },
        async onClose() {
          if (hostId) {
            deps.hosts.unregister(hostId);
            await setHostStatus(deps.db, hostId, "offline");
            if (userId) deps.clients.sendToUser(userId, { t: "host-status", online: false });
            logger.info({ hostId }, "runner host disconnected");
          }
        },
      };
    }),
  );
}
```

- [ ] **Step 2: Wire it into `server.ts`**

Add import and replace the Task 12 comment:
```ts
import { registerHostWs } from "./routes/host-ws.js";
// ...
  registerHostWs(app, upgradeWebSocket, deps);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @cogni/cloud typecheck`
Expected: PASS.

> Note: re-export `logger` from `@cogni/shared` index — ensure `packages/shared/src/index.ts` exists with `export * from "./log.js";` and `package.json` `main` points at it. Add it now if missing.

- [ ] **Step 4: Commit**

```bash
git add packages/cloud packages/shared && git commit -m "feat(cloud): host WebSocket endpoint"
```

### Task 13: Client routes (HTTP + WebSocket)

**Files:**
- Create: `packages/cloud/src/routes/client.ts`
- Modify: `packages/cloud/src/server.ts`

- [ ] **Step 1: Write `routes/client.ts`**

```ts
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { clientToCloudSchema } from "@cogni/contract";
import type { CloudToClient } from "@cogni/contract";
import { randomUUID } from "node:crypto";
import { listThreads, createThread, getThreadDetail } from "../db/threads.js";
import { listEventsSince } from "../db/sessions.js";
import { createHost, getUserHosts } from "../db/hosts.js";
import type { ServerDeps } from "../server.js";

export function registerClientRoutes(app: Hono, upgradeWebSocket: UpgradeWebSocket, deps: ServerDeps): void {
  // --- HTTP: Bearer-auth middleware for /api/* ---
  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const claims = token ? await deps.auth.verifyToken(token) : null;
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    c.set("claims", claims);
    await next();
  });

  app.get("/api/threads", async (c) => {
    const { userId } = c.get("claims");
    return c.json(await listThreads(deps.db, userId));
  });
  app.post("/api/threads", async (c) => {
    const { userId, tenantId } = c.get("claims");
    return c.json(await createThread(deps.db, { userId, tenantId }));
  });
  app.get("/api/threads/:id", async (c) => {
    const detail = await getThreadDetail(deps.db, c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/threads/:id/events", async (c) => {
    const since = Number(c.req.query("since") ?? 0);
    return c.json(await listEventsSince(deps.db, c.req.param("id"), since));
  });
  app.post("/api/hosts", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const name = (await c.req.json().catch(() => ({}))).name ?? "My Computer";
    return c.json(await createHost(deps.db, { userId, tenantId, name }));
  });
  app.get("/api/hosts", async (c) => {
    const { userId } = c.get("claims");
    const hosts = await getUserHosts(deps.db, userId);
    return c.json(hosts.map((h) => ({ id: h.id, name: h.name, status: h.status })));
  });

  // --- WS: /api/ws?token=<jwt> ---
  app.get(
    "/api/ws",
    upgradeWebSocket(async (c) => {
      const claims = await deps.auth.verifyToken(c.req.query("token") ?? "");
      const clientId = randomUUID();
      return {
        onOpen(_e, ws) {
          if (!claims) { ws.close(4001, "unauthorized"); return; }
          deps.clients.register({
            clientId,
            userId: claims.userId,
            send: (m: CloudToClient) => ws.send(JSON.stringify(m)),
          });
        },
        async onMessage(evt) {
          if (!claims) return;
          const parsed = clientToCloudSchema.safeParse(JSON.parse(String(evt.data)));
          if (!parsed.success) return;
          const msg = parsed.data;
          if (msg.t === "subscribe") {
            deps.clients.subscribe(clientId, msg.threadId);
            const host = deps.hosts.getHostForUser(claims.userId);
            deps.clients.broadcast(msg.threadId, { t: "host-status", online: host !== null });
          } else if (msg.t === "send") {
            await deps.chat.handleClientSend(claims.userId, msg.threadId, msg.text);
          }
        },
        onClose() {
          deps.clients.unregister(clientId);
        },
      };
    }),
  );
}
```

- [ ] **Step 2: Add the `claims` type to Hono context + wire into `server.ts`**

At top of `server.ts`, declare the context variable type and add the import/call:
```ts
import { registerClientRoutes } from "./routes/client.js";
import type { SessionClaims } from "./auth.js";

declare module "hono" {
  interface ContextVariableMap { claims: SessionClaims }
}
// ... inside createServer, replace the Task 13 comment:
  registerClientRoutes(app, upgradeWebSocket, deps);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @cogni/cloud typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cloud && git commit -m "feat(cloud): client HTTP routes + WebSocket endpoint"
```

### Task 14: `main.ts` + headless end-to-end integration test

**Files:**
- Create: `packages/cloud/src/main.ts`
- Test: `packages/cloud/src/server.e2e.test.ts`

- [ ] **Step 1: Write the failing integration test**

This boots the real Hono app over a real socket, connects a fake host and a fake client with the `ws` library, and proves the whole spine: client send → dispatch to host → events back → fan-out + persistence.

```ts
import { describe, it, expect, afterEach } from "vitest";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { makeTestDb } from "./db/test-db.js";
import { findOrCreateUser } from "./db/users.js";
import { createThread } from "./db/threads.js";
import { createHost } from "./db/hosts.js";
import { getThreadDetail } from "./db/threads.js";
import { HostRouter } from "./host-router.js";
import { ClientHub } from "./client-hub.js";
import { ChatDomain } from "./domains/chat.js";
import { makeAuth } from "./auth.js";
import { createServer } from "./server.js";

const next = (ws: WebSocket) => new Promise<any>((res) => ws.once("message", (d) => res(JSON.parse(String(d)))));

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("cloud server e2e (headless spine)", () => {
  it("client send → host dispatch → events back → persisted assistant message", async () => {
    const { db } = await makeTestDb();
    const user = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    const hostReg = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: "Mac" });
    const auth = makeAuth({ jwtSecret: "test-secret-test-secret-test-sec", google: { clientId: "x", clientSecret: "y", redirectUri: "http://x/cb" } });
    const jwt = await auth.issueToken({ userId: user.id, tenantId: user.tenantId });

    const hosts = new HostRouter();
    const clients = new ClientHub();
    const chat = new ChatDomain(db, hosts, clients);
    const { app, injectWebSocket } = createServer({ db, auth, hosts, clients, chat, publicUrl: "http://localhost" });
    const server = serve({ fetch: app.fetch, port: 0 });
    injectWebSocket(server);
    stop = () => server.close();
    const port = (server.address() as { port: number }).port;

    // fake Runner Host connects + registers
    const hostWs = new WebSocket(`ws://localhost:${port}/host/ws?token=${hostReg.registrationToken}`);
    await new Promise((r) => hostWs.once("open", r));
    hostWs.send(JSON.stringify({ t: "register", hostId: hostReg.hostId, capabilities: ["streaming"], adapters: ["claude-code"], version: "0.0.0" }));
    expect((await next(hostWs)).t).toBe("registered");

    // fake UI client connects + subscribes
    const clientWs = new WebSocket(`ws://localhost:${port}/api/ws?token=${jwt}`);
    await new Promise((r) => clientWs.once("open", r));
    clientWs.send(JSON.stringify({ t: "subscribe", threadId: thread.id }));
    expect(await next(clientWs)).toMatchObject({ t: "host-status", online: true });

    // client sends a message → host receives a dispatch
    clientWs.send(JSON.stringify({ t: "send", threadId: thread.id, text: "hi" }));
    const dispatch = await next(hostWs);
    expect(dispatch).toMatchObject({ t: "dispatch", threadId: thread.id, message: "hi", runnerSessionId: null });

    // host streams a turn back
    const sid = dispatch.sessionId;
    hostWs.send(JSON.stringify({ t: "event", sessionId: sid, event: { type: "session-id", id: "claude-1" } }));
    hostWs.send(JSON.stringify({ t: "event", sessionId: sid, event: { type: "text", text: "hello" } }));
    hostWs.send(JSON.stringify({ t: "event", sessionId: sid, event: { type: "done" } }));

    // client receives the user message echo, the events, and the assistant message
    const received: any[] = [];
    for (let i = 0; i < 5; i++) received.push(await next(clientWs));
    const types = received.map((m) => `${m.t}:${m.event?.type ?? m.role ?? ""}`);
    expect(types).toContain("message:user");
    expect(types).toContain("event:session-id");
    expect(types).toContain("event:done");
    expect(types).toContain("message:assistant");

    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages.map((m) => `${m.role}:${m.content}`)).toEqual(["user:hi", "assistant:hello"]);

    hostWs.close();
    clientWs.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/server.e2e.test.ts`
Expected: FAIL — `createServer` does not yet register routes (Tasks 11–13 must be complete) OR `main.ts` missing. If Tasks 11–13 are done, the failure should pinpoint a wiring bug to fix.

- [ ] **Step 3: Write `main.ts` and fix any wiring surfaced by the test**

`packages/cloud/src/main.ts`:
```ts
import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { makeDb } from "./db/client.js";
import { makeAuth } from "./auth.js";
import { HostRouter } from "./host-router.js";
import { ClientHub } from "./client-hub.js";
import { ChatDomain } from "./domains/chat.js";
import { createServer } from "./server.js";
import { logger } from "@cogni/shared";

const env = loadEnv();
const db = makeDb(env.databaseUrl);
const auth = makeAuth({
  jwtSecret: env.jwtSecret,
  google: {
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: `${env.publicUrl}/auth/google/callback`,
  },
});
const hosts = new HostRouter();
const clients = new ClientHub();
const chat = new ChatDomain(db, hosts, clients);
const { app, injectWebSocket } = createServer({ db, auth, hosts, clients, chat, publicUrl: env.publicUrl });

const server = serve({ fetch: app.fetch, port: env.port }, (info) =>
  logger.info({ port: info.port }, "cloud control plane listening"),
);
injectWebSocket(server);
```

Add `"dev": "tsx watch src/main.ts"` and `"start": "node dist/main.js"` to `packages/cloud/package.json` scripts.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/server.e2e.test.ts`
Expected: PASS (1 test) — the headless spine works end-to-end.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud && git commit -m "feat(cloud): main entrypoint + headless end-to-end spine test"
```

---

## Phase 5 — `runner-host` (independent daemon)

### Task 15: Host config (`~/.cogni/host.json`)

**Files:**
- Create: `packages/runner-host/src/config.ts`
- Test: `packages/runner-host/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostConfig, writeHostConfig, threadScratchDir } from "./config.js";

beforeEach(() => {
  process.env.COGNI_HOME = mkdtempSync(join(tmpdir(), "cogni-"));
});

describe("host config", () => {
  it("returns null when no config file exists", async () => {
    expect(await readHostConfig()).toBeNull();
  });
  it("writes then reads back a config", async () => {
    const cfg = { hostId: "h1", registrationToken: "tok", cloudUrl: "ws://localhost:8787" };
    await writeHostConfig(cfg);
    expect(await readHostConfig()).toEqual(cfg);
  });
  it("derives a per-thread scratch dir under COGNI_HOME", () => {
    expect(threadScratchDir("t1")).toContain(join("threads", "t1"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/runner-host/src/config.test.ts`
Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 3: Write `config.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

export interface HostConfig {
  hostId: string;
  registrationToken: string;
  cloudUrl: string; // e.g. ws://localhost:8787
}

export function configDir(): string {
  return process.env.COGNI_HOME ?? join(homedir(), ".cogni");
}
export function configPath(): string {
  return join(configDir(), "host.json");
}

export async function readHostConfig(): Promise<HostConfig | null> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8"));
    if (
      typeof parsed.hostId === "string" &&
      typeof parsed.registrationToken === "string" &&
      typeof parsed.cloudUrl === "string"
    ) {
      return parsed as HostConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeHostConfig(cfg: HostConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(cfg, null, 2), "utf8");
}

/** Per-thread working directory the Claude Code adapter runs in. */
export function threadScratchDir(threadId: string): string {
  return join(configDir(), "threads", threadId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/runner-host/src/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runner-host && git commit -m "feat(runner-host): host config read/write"
```

### Task 16: Claude Code adapter

**Files:**
- Create: `packages/runner-host/src/adapters/claude-code.ts`
- Test: `packages/runner-host/src/adapters/claude-code.test.ts`

The adapter implements `RunnerAdapter`. It takes an injectable `ClaudeRunner` (yields raw stdout lines) so the stream-json translation is unit-tested without spawning `claude`. The default runner uses `execa` + `readline` — the same approach proven in `~/code/cognit-flow/src/coding-tool/claude-cli.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code.js";
import type { RunnerEvent } from "@cogni/contract";

// Fake runner: yields canned Claude stream-json lines.
function fakeRunner(lines: string[]) {
  return async function* () {
    for (const l of lines) yield l;
  };
}

async function collect(it: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("ClaudeCodeAdapter", () => {
  it("declares its id and capabilities", () => {
    const a = new ClaudeCodeAdapter(fakeRunner([]));
    expect(a.id).toBe("claude-code");
    expect(a.capabilities).toEqual(["streaming", "session-resume", "tool-events"]);
  });

  it("translates a full stream-json turn into RunnerEvents", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "ls" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "file.txt" }] } }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "claude-1", usage: { input_tokens: 10, output_tokens: 5 } }),
    ];
    const adapter = new ClaudeCodeAdapter(fakeRunner(lines));
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events.map((e) => e.type)).toEqual([
      "session-id", "text", "tool-call", "tool-result", "session-id", "done",
    ]);
    expect(session.runnerSessionId).toBe("claude-1");
  });

  it("maps a non-success result subtype to an error event", async () => {
    const lines = [JSON.stringify({ type: "result", subtype: "error_max_turns", result: "too many turns" })];
    const adapter = new ClaudeCodeAdapter(fakeRunner(lines));
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events).toEqual([{ type: "error", code: "error_max_turns", message: "too many turns" }]);
  });

  it("synthesizes a done event if the stream ends without a result line", async () => {
    const adapter = new ClaudeCodeAdapter(fakeRunner([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } })]));
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("resumeSession seeds runnerSessionId for --resume", async () => {
    const adapter = new ClaudeCodeAdapter(fakeRunner([]));
    const session = await adapter.resumeSession("claude-prev", { cwd: "/tmp/x" });
    expect(session.runnerSessionId).toBe("claude-prev");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/runner-host/src/adapters/claude-code.test.ts`
Expected: FAIL — cannot resolve `./claude-code.js`.

- [ ] **Step 3: Write `adapters/claude-code.ts`**

```ts
import * as readline from "node:readline";
import { execa } from "execa";
import type {
  RunnerAdapter, RunnerCapability, RunnerEvent, RunnerSessionHandle, StartSessionOpts,
} from "@cogni/contract";

/** Yields raw stdout lines from a `claude` turn. Injectable so translation is unit-tested. */
export type ClaudeRunner = (params: {
  cwd: string;
  message: string;
  resumeId: string | null;
}) => AsyncIterable<string>;

const CAPABILITIES: RunnerCapability[] = ["streaming", "session-resume", "tool-events"];

/**
 * Default runner: spawns `claude --print --output-format stream-json --verbose`,
 * pipes the message on stdin, yields stdout lines. Mirrors the working invocation
 * in cognit-flow/src/coding-tool/claude-cli.ts — adjust flags there if Claude Code
 * changes its CLI surface.
 */
export const defaultClaudeRunner: ClaudeRunner = async function* ({ cwd, message, resumeId }) {
  const args = ["--print", "--output-format", "stream-json", "--verbose"];
  if (resumeId) args.push("--resume", resumeId);
  const proc = execa("claude", args, { cwd, input: message, reject: false, buffer: false });
  if (!proc.stdout) throw new Error("claude stdout unavailable");
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() !== "") yield line;
  }
  const result = await proc;
  if (result.exitCode != null && result.exitCode !== 0) {
    yield JSON.stringify({
      type: "result",
      subtype: "process_error",
      result: result.stderr || `claude exited ${result.exitCode}`,
    });
  }
};

class ClaudeCodeSession implements RunnerSessionHandle {
  private _runnerSessionId: string | null;
  constructor(
    private readonly runner: ClaudeRunner,
    private readonly cwd: string,
    resumeId: string | null,
  ) {
    this._runnerSessionId = resumeId;
  }
  get runnerSessionId(): string | null {
    return this._runnerSessionId;
  }
  async *send(message: string): AsyncIterable<RunnerEvent> {
    let sawTerminal = false;
    try {
      for await (const line of this.runner({ cwd: this.cwd, message, resumeId: this._runnerSessionId })) {
        for (const event of translateLine(line)) {
          if (event.type === "session-id") this._runnerSessionId = event.id;
          if (event.type === "done" || event.type === "error") sawTerminal = true;
          yield event;
        }
      }
    } catch (e) {
      yield { type: "error", code: "claude_spawn_failed", message: String(e) };
      return;
    }
    if (!sawTerminal) yield { type: "done" };
  }
  async close(): Promise<void> {
    // No persistent process: each turn is a fresh `claude --print` invocation.
  }
}

export class ClaudeCodeAdapter implements RunnerAdapter {
  readonly id = "claude-code";
  readonly capabilities = CAPABILITIES;
  constructor(private readonly runner: ClaudeRunner = defaultClaudeRunner) {}

  async startSession(opts: StartSessionOpts): Promise<RunnerSessionHandle> {
    return new ClaudeCodeSession(this.runner, opts.cwd, null);
  }
  async resumeSession(runnerSessionId: string, opts: StartSessionOpts): Promise<RunnerSessionHandle> {
    return new ClaudeCodeSession(this.runner, opts.cwd, runnerSessionId);
  }
}

/** Translate one Claude stream-json line into zero or more RunnerEvents. */
function translateLine(line: string): RunnerEvent[] {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  switch (parsed.type) {
    case "system":
      return typeof parsed.session_id === "string" ? [{ type: "session-id", id: parsed.session_id }] : [];
    case "assistant": {
      const blocks = parsed.message?.content;
      if (!Array.isArray(blocks)) return [];
      const out: RunnerEvent[] = [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") {
          out.push({ type: "text", text: b.text });
        } else if (b?.type === "tool_use") {
          out.push({ type: "tool-call", toolId: String(b.id ?? ""), name: String(b.name ?? ""), input: b.input });
        }
      }
      return out;
    }
    case "user": {
      const blocks = parsed.message?.content;
      if (!Array.isArray(blocks)) return [];
      const out: RunnerEvent[] = [];
      for (const b of blocks) {
        if (b?.type === "tool_result") {
          out.push({ type: "tool-result", toolId: String(b.tool_use_id ?? ""), output: b.content });
        }
      }
      return out;
    }
    case "result": {
      const out: RunnerEvent[] = [];
      if (typeof parsed.session_id === "string") out.push({ type: "session-id", id: parsed.session_id });
      if (parsed.subtype && parsed.subtype !== "success") {
        out.push({ type: "error", code: String(parsed.subtype), message: String(parsed.result ?? parsed.subtype) });
      } else {
        out.push({ type: "done", usage: numericUsage(parsed.usage) });
      }
      return out;
    }
    default:
      return [];
  }
}

function numericUsage(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage)) if (typeof v === "number") out[k] = v;
  return Object.keys(out).length ? out : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/runner-host/src/adapters/claude-code.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runner-host && git commit -m "feat(runner-host): Claude Code adapter (stream-json → RunnerEvent)"
```

### Task 17: Runner manager

**Files:**
- Create: `packages/runner-host/src/runner-manager.ts`
- Test: `packages/runner-host/src/runner-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { RunnerManager } from "./runner-manager.js";
import type { RunnerAdapter, RunnerEvent } from "@cogni/contract";

function fakeAdapter(events: RunnerEvent[]): RunnerAdapter {
  const make = (resumeId: string | null) => ({
    runnerSessionId: resumeId,
    async *send() { for (const e of events) yield e; },
    async close() {},
  });
  return {
    id: "claude-code",
    capabilities: ["streaming"],
    startSession: vi.fn(async () => make(null)),
    resumeSession: vi.fn(async (id: string) => make(id)),
  };
}

describe("RunnerManager", () => {
  it("dispatches to the named adapter and forwards every event", async () => {
    const adapter = fakeAdapter([{ type: "text", text: "hi" }, { type: "done" }]);
    const mgr = new RunnerManager();
    mgr.register(adapter);
    const seen: RunnerEvent[] = [];
    await mgr.dispatch(
      { sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "go" },
      (e) => seen.push(e),
    );
    expect(seen.map((e) => e.type)).toEqual(["text", "done"]);
    expect(adapter.startSession).toHaveBeenCalledOnce();
  });

  it("uses resumeSession when a runnerSessionId is provided", async () => {
    const adapter = fakeAdapter([{ type: "done" }]);
    const mgr = new RunnerManager();
    mgr.register(adapter);
    await mgr.dispatch(
      { sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: "claude-prev", message: "go" },
      () => {},
    );
    expect(adapter.resumeSession).toHaveBeenCalledWith("claude-prev", expect.objectContaining({ cwd: expect.any(String) }));
  });

  it("emits an error event when the adapter is unknown", async () => {
    const mgr = new RunnerManager();
    const seen: RunnerEvent[] = [];
    await mgr.dispatch(
      { sessionId: "s1", threadId: "t1", adapter: "nope", runnerSessionId: null, message: "go" },
      (e) => seen.push(e),
    );
    expect(seen).toEqual([{ type: "error", code: "unknown_adapter", message: "no adapter registered for 'nope'" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/runner-host/src/runner-manager.test.ts`
Expected: FAIL — cannot resolve `./runner-manager.js`.

- [ ] **Step 3: Write `runner-manager.ts`**

```ts
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
    for await (const event of handle.send(input.message)) onEvent(event);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/runner-host/src/runner-manager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runner-host && git commit -m "feat(runner-host): runner manager"
```

### Task 18: Registry client (WS to cloud) + `main.ts`

**Files:**
- Create: `packages/runner-host/src/registry.ts`
- Create: `packages/runner-host/src/main.ts`
- Test: `packages/runner-host/src/registry.test.ts`

- [ ] **Step 1: Write the failing test (the dispatch handler is the pure, testable core)**

```ts
import { describe, it, expect, vi } from "vitest";
import { handleDispatch } from "./registry.js";
import { RunnerManager } from "./runner-manager.js";
import type { RunnerAdapter } from "@cogni/contract";

function fakeAdapter(): RunnerAdapter {
  return {
    id: "claude-code",
    capabilities: ["streaming"],
    async startSession() {
      return {
        runnerSessionId: null,
        async *send() {
          yield { type: "session-id", id: "claude-1" } as const;
          yield { type: "text", text: "hi" } as const;
          yield { type: "done" } as const;
        },
        async close() {},
      };
    },
    async resumeSession() { throw new Error("unused"); },
  };
}

describe("handleDispatch", () => {
  it("forwards each RunnerEvent as an `event` message then a `session-update` completed", async () => {
    const mgr = new RunnerManager();
    mgr.register(fakeAdapter());
    const sent: any[] = [];
    await handleDispatch(mgr, { t: "dispatch", sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "go" }, (m) => sent.push(m));
    expect(sent.map((m) => `${m.t}:${m.event?.type ?? m.status ?? ""}`)).toEqual([
      "event:session-id", "event:text", "event:done", "session-update:completed",
    ]);
  });

  it("reports session-update failed when an error event occurs", async () => {
    const mgr = new RunnerManager(); // no adapters → unknown_adapter error
    const sent: any[] = [];
    await handleDispatch(mgr, { t: "dispatch", sessionId: "s1", threadId: "t1", adapter: "x", runnerSessionId: null, message: "go" }, (m) => sent.push(m));
    expect(sent.at(-1)).toEqual({ t: "session-update", sessionId: "s1", status: "failed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/runner-host/src/registry.test.ts`
Expected: FAIL — cannot resolve `./registry.js`.

- [ ] **Step 3: Write `registry.ts` and `main.ts`**

`packages/runner-host/src/registry.ts`:
```ts
import { WebSocket } from "ws";
import type { CloudToHost, HostToCloud } from "@cogni/contract";
import { cloudToHostSchema } from "@cogni/contract";
import { logger } from "@cogni/shared";
import { RunnerManager } from "./runner-manager.js";
import type { HostConfig } from "./config.js";

const HEARTBEAT_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const VERSION = "0.0.0";

/** Pure core: run one dispatch through the manager, emitting host→cloud messages. */
export async function handleDispatch(
  manager: RunnerManager,
  dispatch: Extract<CloudToHost, { t: "dispatch" }>,
  send: (msg: HostToCloud) => void,
): Promise<void> {
  let failed = false;
  await manager.dispatch(dispatch, (event) => {
    if (event.type === "error") failed = true;
    send({ t: "event", sessionId: dispatch.sessionId, event });
  });
  send({ t: "session-update", sessionId: dispatch.sessionId, status: failed ? "failed" : "completed" });
}

/** Connects to the cloud, registers, runs dispatches, reconnects with backoff. */
export function connectToCloud(config: HostConfig, manager: RunnerManager): void {
  let attempt = 0;

  const open = () => {
    const url = `${config.cloudUrl}/host/ws?token=${encodeURIComponent(config.registrationToken)}`;
    const ws = new WebSocket(url);
    const send = (msg: HostToCloud) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    ws.on("open", () => {
      attempt = 0;
      const caps = manager.capabilities();
      send({ t: "register", hostId: config.hostId, capabilities: caps.capabilities as any, adapters: caps.adapters, version: VERSION });
      heartbeat = setInterval(() => send({ t: "heartbeat" }), HEARTBEAT_MS);
      logger.info({ hostId: config.hostId }, "connected to cloud");
    });

    ws.on("message", async (data) => {
      const parsed = cloudToHostSchema.safeParse(JSON.parse(String(data)));
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.t === "dispatch") {
        await handleDispatch(manager, msg, send);
      }
    });

    ws.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt += 1;
      logger.warn({ delay }, "cloud connection closed; reconnecting");
      setTimeout(open, delay);
    });

    ws.on("error", (err) => logger.error({ err: String(err) }, "cloud connection error"));
  };

  open();
}
```

`packages/runner-host/src/main.ts`:
```ts
import { readHostConfig } from "./config.js";
import { RunnerManager } from "./runner-manager.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { connectToCloud } from "./registry.js";
import { logger } from "@cogni/shared";

const config = await readHostConfig();
if (!config) {
  logger.error("no ~/.cogni/host.json — register this host from the desktop app first");
  process.exit(1);
}

const manager = new RunnerManager();
manager.register(new ClaudeCodeAdapter());
connectToCloud(config, manager);
logger.info({ hostId: config.hostId }, "runner host daemon started");
```

Add to `packages/runner-host/package.json` scripts: `"dev": "tsx src/main.ts"`, `"start": "node dist/main.js"`. Add a `bin` entry: `"bin": { "cogni-runner-host": "./dist/main.js" }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/runner-host/src/registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runner-host && git commit -m "feat(runner-host): cloud registry client + daemon entrypoint"
```

---

## Phase 6 — `apps/desktop` (Tauri 2 + React UI shell)

This phase is integration-heavy: steps are "build + verify by running", not TDD. Components are functional, not styled — visual polish is SP-4. The screenshot is the layout reference: left sidebar (chat/项目 toggle, New chat, Recents), main pane = conversation.

### Task 19: Tauri 2 + React + Vite scaffold

**Files:**
- Create: `apps/desktop/` (Tauri scaffold)
- Modify: `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/.env`

- [ ] **Step 1: Scaffold the app**

Run:
```bash
cd apps && pnpm create tauri-app@latest desktop --template react-ts --manager pnpm --yes && cd ..
pnpm install
```
This creates `apps/desktop` with Tauri 2 + React + TS + Vite.

- [ ] **Step 2: Add the deep-link plugin (for OAuth callback)**

Run:
```bash
cd apps/desktop && pnpm tauri add deep-link && cd ../..
```

In `apps/desktop/src-tauri/tauri.conf.json`, register the `cogni` scheme under `plugins`:
```json
{
  "plugins": {
    "deep-link": {
      "desktop": { "schemes": ["cogni"] }
    }
  }
}
```

Ensure `apps/desktop/src-tauri/src/lib.rs` registers the plugin in the builder:
```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Add workspace deps + env**

In `apps/desktop/package.json`, add dependencies: `@cogni/contract` (`workspace:*`), `@tauri-apps/plugin-deep-link`, `@tauri-apps/plugin-opener`. Run `pnpm install`.

`apps/desktop/.env`:
```
VITE_CLOUD_URL=http://localhost:8787
```

- [ ] **Step 4: Verify it builds and runs**

Run: `pnpm --filter desktop tauri dev`
Expected: the default Tauri window opens. Close it.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop && git commit -m "chore(desktop): scaffold Tauri 2 + React app with deep-link plugin"
```

### Task 20: Auth — deep-link OAuth flow + token storage

**Files:**
- Create: `apps/desktop/src/api.ts`
- Create: `apps/desktop/src/useAuth.ts`
- Create: `apps/desktop/src/Login.tsx`
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Write `api.ts` (typed cloud client)**

```ts
import type { ThreadSummary, ThreadDetail, HostRegistration } from "@cogni/contract";

const CLOUD_URL = import.meta.env.VITE_CLOUD_URL ?? "http://localhost:8787";
const WS_URL = CLOUD_URL.replace(/^http/, "ws");

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

export interface HostInfo { id: string; name: string; status: string }

export const api = {
  cloudUrl: CLOUD_URL,
  wsUrl: WS_URL,
  async listThreads(token: string): Promise<ThreadSummary[]> {
    return (await fetch(`${CLOUD_URL}/api/threads`, { headers: headers(token) })).json();
  },
  async createThread(token: string): Promise<ThreadSummary> {
    return (await fetch(`${CLOUD_URL}/api/threads`, { method: "POST", headers: headers(token) })).json();
  },
  async getThread(token: string, id: string): Promise<ThreadDetail> {
    return (await fetch(`${CLOUD_URL}/api/threads/${id}`, { headers: headers(token) })).json();
  },
  async listHosts(token: string): Promise<HostInfo[]> {
    return (await fetch(`${CLOUD_URL}/api/hosts`, { headers: headers(token) })).json();
  },
  async createHost(token: string, name: string): Promise<HostRegistration> {
    return (await fetch(`${CLOUD_URL}/api/hosts`, { method: "POST", headers: headers(token), body: JSON.stringify({ name }) })).json();
  },
};
```

- [ ] **Step 2: Write `useAuth.ts`**

```ts
import { useEffect, useState } from "react";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api.js";

const TOKEN_KEY = "cogni_token";

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));

  useEffect(() => {
    const unlisten = onOpenUrl((urls) => {
      for (const u of urls) {
        const t = new URL(u).searchParams.get("token");
        if (t) {
          localStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const login = () => openUrl(`${api.cloudUrl}/auth/google/start?redirect=${encodeURIComponent("cogni://auth")}`);
  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  };
  return { token, login, logout };
}
```

- [ ] **Step 3: Write `Login.tsx` and wire `App.tsx`**

`apps/desktop/src/Login.tsx`:
```tsx
export function Login({ onLogin }: { onLogin: () => void }) {
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
      <div style={{ textAlign: "center" }}>
        <h1>Cogni</h1>
        <p>有记忆、跨设备在场的 AI 助手</p>
        <button onClick={onLogin}>用 Google 登录</button>
      </div>
    </div>
  );
}
```

`apps/desktop/src/App.tsx`:
```tsx
import { useAuth } from "./useAuth.js";
import { Login } from "./Login.js";
import { Shell } from "./Shell.js"; // created in Task 21

export default function App() {
  const { token, login, logout } = useAuth();
  if (!token) return <Login onLogin={login} />;
  return <Shell token={token} onLogout={logout} />;
}
```

> `Shell` does not exist yet — Task 21 creates it. Until then, temporarily stub `Shell.tsx` with `export function Shell() { return <div>shell</div>; }` so the app compiles.

- [ ] **Step 4: Verify the OAuth round trip manually**

With the cloud server running (`pnpm --filter @cogni/cloud dev`, real Google creds in `.env`) and `pnpm --filter desktop tauri dev`:
- Click "用 Google 登录" → system browser opens Google consent.
- After consent, browser hits `cogni://auth?token=...` → the app window receives it and switches away from the Login screen.

Expected: app leaves the Login screen (shows the `Shell` stub).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop && git commit -m "feat(desktop): Google OAuth via deep-link + token storage"
```

### Task 21: API client wiring — sidebar (Recents + chat/项目 toggle)

**Files:**
- Create: `apps/desktop/src/Shell.tsx` (replaces the stub)
- Create: `apps/desktop/src/Sidebar.tsx`

- [ ] **Step 1: Write `Sidebar.tsx`**

```tsx
import type { ThreadSummary } from "@cogni/contract";

export function Sidebar(props: {
  mode: "chat" | "project";
  onMode: (m: "chat" | "project") => void;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}) {
  return (
    <div style={{ width: 240, borderRight: "1px solid #ddd", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", padding: 8, gap: 4 }}>
        <button disabled={props.mode === "chat"} onClick={() => props.onMode("chat")}>chat</button>
        {/* 项目 mode is disabled in SP-1 — it ships in SP-3 */}
        <button disabled title="SP-3">项目</button>
      </div>
      <button onClick={props.onNewChat} style={{ margin: 8 }}>+ New chat</button>
      <div style={{ overflowY: "auto", flex: 1 }}>
        <div style={{ padding: "4px 8px", color: "#888", fontSize: 12 }}>Recents</div>
        {props.threads.map((t) => (
          <div
            key={t.id}
            onClick={() => props.onSelect(t.id)}
            style={{
              padding: "6px 8px",
              cursor: "pointer",
              background: t.id === props.activeThreadId ? "#eee" : "transparent",
            }}
          >
            {t.title}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `Shell.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { ThreadSummary } from "@cogni/contract";
import { api } from "./api.js";
import { Sidebar } from "./Sidebar.js";
import { Conversation } from "./Conversation.js"; // created in Task 22

export function Shell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [mode, setMode] = useState<"chat" | "project">("chat");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const refreshThreads = () => api.listThreads(token).then(setThreads);
  useEffect(() => { refreshThreads(); }, [token]);

  const newChat = async () => {
    const t = await api.createThread(token);
    await refreshThreads();
    setActiveThreadId(t.id);
  };

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar
        mode={mode}
        onMode={setMode}
        threads={threads}
        activeThreadId={activeThreadId}
        onSelect={setActiveThreadId}
        onNewChat={newChat}
      />
      <div style={{ flex: 1 }}>
        {activeThreadId ? (
          <Conversation token={token} threadId={activeThreadId} onTitleMaybeChanged={refreshThreads} />
        ) : (
          <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
            <button onClick={newChat}>开始一个新对话</button>
          </div>
        )}
      </div>
    </div>
  );
}
```

> `Conversation` does not exist yet — Task 22 creates it. Temporarily stub `Conversation.tsx` with `export function Conversation() { return <div>conversation</div>; }` so the app compiles.

- [ ] **Step 3: Verify**

Run: `pnpm --filter desktop tauri dev` (with cloud running + logged in)
Expected: sidebar shows "chat"/"项目" toggle (项目 disabled), "+ New chat" creates a thread that appears under Recents.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop && git commit -m "feat(desktop): app shell + sidebar (Recents, chat/项目 toggle)"
```

### Task 22: Conversation view + WS streaming + host-status banner

**Files:**
- Create: `apps/desktop/src/useThreadStream.ts`
- Create: `apps/desktop/src/Conversation.tsx` (replaces the stub)

- [ ] **Step 1: Write `useThreadStream.ts`**

```ts
import { useEffect, useRef, useState } from "react";
import type { MessageView, RunnerEvent, CloudToClient } from "@cogni/contract";
import { api } from "./api.js";

export function useThreadStream(token: string, threadId: string) {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [streaming, setStreaming] = useState<RunnerEvent[]>([]);
  const [hostOnline, setHostOnline] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setStreaming([]);
    api.getThread(token, threadId).then((d) => setMessages(d.messages ?? []));

    const ws = new WebSocket(`${api.wsUrl}/api/ws?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "subscribe", threadId }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as CloudToClient;
      if (msg.t === "message") {
        setMessages((m) => [...m, {
          id: msg.messageId, threadId: msg.threadId, role: msg.role,
          content: msg.content, createdAt: msg.createdAt,
        }]);
      } else if (msg.t === "event") {
        if (msg.event.type === "done" || msg.event.type === "error") setStreaming([]);
        else setStreaming((s) => [...s, msg.event]);
      } else if (msg.t === "host-status") {
        setHostOnline(msg.online);
      }
    };
    return () => ws.close();
  }, [token, threadId]);

  const send = (text: string) => {
    wsRef.current?.send(JSON.stringify({ t: "send", threadId, text }));
  };
  return { messages, streaming, hostOnline, send };
}
```

- [ ] **Step 2: Write `Conversation.tsx`**

```tsx
import { useState } from "react";
import type { RunnerEvent } from "@cogni/contract";
import { useThreadStream } from "./useThreadStream.js";

function EventBlock({ event }: { event: RunnerEvent }) {
  if (event.type === "text") return <span>{event.text}</span>;
  if (event.type === "tool-call") return <pre style={{ background: "#f4f4f4" }}>🔧 {event.name}({JSON.stringify(event.input)})</pre>;
  if (event.type === "tool-result") return <pre style={{ background: "#f0f7f0" }}>↳ {String(event.output).slice(0, 200)}</pre>;
  if (event.type === "error") return <pre style={{ color: "crimson" }}>⚠ {event.code}: {event.message}</pre>;
  return null;
}

export function Conversation({ token, threadId }: { token: string; threadId: string; onTitleMaybeChanged?: () => void }) {
  const { messages, streaming, hostOnline, send } = useThreadStream(token, threadId);
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (!draft.trim()) return;
    send(draft);
    setDraft("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {!hostOnline && (
        <div style={{ background: "#fff3cd", padding: 8, fontSize: 13 }}>
          本地运行环境未连接 —— 启动你电脑上的 Cogni 才能跑任务
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {messages.map((m) => (
          <div key={m.id} style={{ margin: "8px 0" }}>
            <b>{m.role === "user" ? "你" : m.role === "assistant" ? "Cogni" : "系统"}:</b> {m.content}
          </div>
        ))}
        {streaming.length > 0 && (
          <div style={{ margin: "8px 0", color: "#444" }}>
            <b>Cogni:</b> {streaming.map((e, i) => <EventBlock key={i} event={e} />)}
          </div>
        )}
      </div>
      <div style={{ display: "flex", padding: 8, borderTop: "1px solid #ddd" }}>
        <input
          style={{ flex: 1 }}
          value={draft}
          placeholder="Write a message..."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button onClick={submit}>发送</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify**

Run the full stack (cloud + runner-host daemon + `pnpm --filter desktop tauri dev`, logged in). Type a message and press Enter.
Expected: user message appears immediately; Claude Code output streams into a "Cogni:" block (text + tool blocks); on completion it settles into a persisted assistant message. If the daemon is not running, the yellow "本地运行环境未连接" banner shows.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop && git commit -m "feat(desktop): conversation view with WS streaming + host-status banner"
```

### Task 23: Runner-host daemon — register + spawn from the desktop app

**Files:**
- Create: `apps/desktop/src-tauri/src/daemon.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register commands)
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (bundle runner-host as a sidecar)
- Modify: `apps/desktop/src/Shell.tsx` (ensure host on login)

- [ ] **Step 1: Bundle the runner-host binary as a Tauri sidecar**

Build a single-file runner-host binary (e.g. with `pnpm --filter @cogni/runner-host build` then a packaging step, or `pkg`/`node --experimental-sea`). Place it at `apps/desktop/src-tauri/binaries/cogni-runner-host-<target-triple>`. In `tauri.conf.json`:
```json
{
  "bundle": {
    "externalBin": ["binaries/cogni-runner-host"]
  }
}
```

> SP-1 keeps packaging simple: a shell-script wrapper that runs `node <path-to-dist>/main.js` is acceptable as the sidecar. Proper single-binary packaging + OS login-item auto-start is SP-4.

- [ ] **Step 2: Write `daemon.rs` — write config + spawn detached + liveness check**

```rust
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn cogni_home() -> PathBuf {
    std::env::var("COGNI_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap().join(".cogni"))
}

#[tauri::command]
pub fn write_host_config(host_id: String, registration_token: String, cloud_url: String) -> Result<(), String> {
    let dir = cogni_home();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cfg = serde_json::json!({
        "hostId": host_id,
        "registrationToken": registration_token,
        "cloudUrl": cloud_url,
    });
    fs::write(dir.join("host.json"), serde_json::to_string_pretty(&cfg).unwrap())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ensure_daemon(app: tauri::AppHandle) -> Result<bool, String> {
    let pid_file = cogni_home().join("daemon.pid");
    // If a live pid is recorded, do nothing.
    if let Ok(pid_str) = fs::read_to_string(&pid_file) {
        if let Ok(pid) = pid_str.trim().parse::<i32>() {
            if is_alive(pid) {
                return Ok(false); // already running
            }
        }
    }
    // Spawn the bundled sidecar detached and record its pid.
    let (_rx, child) = app
        .shell()
        .sidecar("cogni-runner-host")
        .map_err(|e| e.to_string())?
        .spawn()
        .map_err(|e| e.to_string())?;
    fs::write(&pid_file, child.pid().to_string()).map_err(|e| e.to_string())?;
    Ok(true) // spawned
}

#[cfg(unix)]
fn is_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}
#[cfg(windows)]
fn is_alive(_pid: i32) -> bool {
    true // SP-1 Windows: assume alive; SP-4 adds a real check
}
```

Add to `Cargo.toml`: `dirs`, `serde_json`, `libc` (unix), and `tauri-plugin-shell`. Register the shell plugin in `lib.rs` and the two commands:
```rust
.plugin(tauri_plugin_shell::init())
.invoke_handler(tauri::generate_handler![daemon::write_host_config, daemon::ensure_daemon])
```

- [ ] **Step 3: Ensure host on login from `Shell.tsx`**

Add to `Shell.tsx` an effect that runs once after login:
```tsx
import { invoke } from "@tauri-apps/api/core";
// ...inside Shell, after the threads effect:
useEffect(() => {
  (async () => {
    const hosts = await api.listHosts(token);
    if (hosts.length === 0) {
      const reg = await api.createHost(token, "My Computer");
      await invoke("write_host_config", {
        hostId: reg.hostId,
        registrationToken: reg.registrationToken,
        cloudUrl: api.wsUrl,
      });
    }
    await invoke("ensure_daemon");
  })().catch((e) => console.error("host setup failed", e));
}, [token]);
```

- [ ] **Step 4: Verify the daemon lifecycle**

Run cloud + `pnpm --filter desktop tauri dev`, log in fresh (clear `~/.cogni` first).
Expected: `~/.cogni/host.json` is written; `~/.cogni/daemon.pid` appears; the runner-host connects to the cloud (cloud logs "runner host registered"); the conversation's host-status banner is *not* shown. Quit the app, relaunch — `ensure_daemon` sees the live pid and does not double-spawn.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop && git commit -m "feat(desktop): register + spawn runner-host daemon on login"
```

---

## Phase 7 — End-to-End Verification

### Task 24: Full-stack smoke test + README

**Files:**
- Create: `README.md`
- Create: `docs/RUNNING.md`

- [ ] **Step 1: Write `docs/RUNNING.md` — the local run recipe**

Document, with exact commands:
1. Create a Neon project; put its URL in `packages/cloud/.env` as `DATABASE_URL`. Run `pnpm --filter @cogni/cloud exec drizzle-kit push` to create tables.
2. Create Google OAuth credentials (Web application); authorized redirect URI `http://localhost:8787/auth/google/callback`; fill `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `JWT_SECRET` in `.env`.
3. `pnpm --filter @cogni/cloud dev` — cloud control plane on :8787.
4. `pnpm --filter desktop tauri dev` — desktop app.
5. Ensure `claude` CLI is installed and authenticated on the machine (the runner-host shells out to it).

- [ ] **Step 2: Run the automated test suite**

Run: `pnpm test && pnpm typecheck`
Expected: all vitest suites pass (contract, cloud incl. `server.e2e.test.ts`, runner-host); typecheck clean across all packages.

- [ ] **Step 3: Manual walkthrough against the SP-1 acceptance criteria**

With the full stack running, verify each criterion from the spec:
1. **桌面 Google 登录** — click login, complete Google consent, app leaves Login screen.
2. **新建 chat** — "+ New chat" creates a thread under Recents.
3. **发消息 → 云端路由到本地 Runner Host → Claude Code 跑** — type a message; cloud logs show a `dispatch` to the host; `claude` runs in `~/.cogni/threads/<threadId>/`.
4. **工具调用 + 文本流式回桌面** — the conversation shows streaming text and 🔧 tool blocks.
5. **thread/消息持久化在 Neon** — query Neon: `threads`, `messages`, `events` rows exist for the conversation.
6. **关 app 重开,Recents 还在、能续聊** — quit and relaunch; the thread is still in Recents; opening it shows prior messages; sending again resumes (cloud `dispatch` carries the stored `runnerSessionId`).
7. **host 离线空态** — quit the runner-host daemon (`kill $(cat ~/.cogni/daemon.pid)`); the conversation shows the yellow "本地运行环境未连接" banner.

- [ ] **Step 4: Write `README.md`**

Short project README: what Cogni is, the SP-1 → SP-4 roadmap pointer (link the spec), the package layout, and a pointer to `docs/RUNNING.md`.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/RUNNING.md && git commit -m "docs: SP-1 running guide + project README"
```

---

## Notes for the implementer

- **Third-party API drift:** `arctic`, `@hono/node-ws`, `tauri-plugin-deep-link`, and the `claude` CLI flags evolve. The plan's *own* types (contract/cloud/runner-host) are the contract; if a third-party signature differs from what's shown, adapt the call site — don't change the `@cogni/contract` shapes.
- **The `claude` invocation** in `defaultClaudeRunner` is the one integration point not unit-tested. The working reference is `~/code/cognit-flow/src/coding-tool/claude-cli.ts` — match its flags if Task 24 step 3 shows no stream output.
- **pglite vs Neon:** `test-db.ts` hand-maintains DDL parallel to `schema.ts`. When `drizzle-kit` migrations land (SP-2), generate migrations from `schema.ts` and have `test-db.ts` apply the same migration files.
- **Type consistency anchors:** `RunnerEvent` (contract/runner.ts), the four protocol unions (contract/protocol.ts), and `DispatchInput` (runner-host/runner-manager.ts) must stay in sync — they are referenced across all four packages.
- **Task 13 thread-ownership:** every thread-scoped client endpoint (`GET /api/threads/:id`, `.../events`, WS `subscribe`/`send`) MUST gate on `threadBelongsToUser(db, threadId, userId)` — a client-supplied `threadId` is not an authorization boundary. (This was missing from the original Task 13 reference code and added during review.)
