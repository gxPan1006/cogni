import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readHostConfig, type HostConfig } from "../config.js";
import { COGNI_TOOL_NAMES } from "./mcp-config.js";

/** ws://… → http://…, wss://… → https://… (the cloud REST base for callbacks). */
export function httpBaseFromWsUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http");
}

interface ToolDeps {
  fetch: typeof globalThis.fetch;
  config: Pick<HostConfig, "cloudUrl" | "registrationToken"> & { hostId?: string };
}

interface ToolRoute {
  method: string;
  path: (a: Record<string, any>) => string;
  body?: (a: Record<string, any>) => unknown;
}

/**
 * SP-4: each cogni MCP tool maps to one existing cloud REST endpoint. Calls
 * carry `Authorization: Host <registrationToken>`, which the cloud's `/api/*`
 * middleware resolves to the host's owning user (see Task 5).
 */
const ROUTES: Record<string, ToolRoute> = {
  list_projects: { method: "GET", path: () => `/api/projects` },
  list_tasks: { method: "GET", path: (a) => `/api/projects/${a.projectId}/tasks` },
  create_task: {
    method: "POST",
    path: (a) => `/api/projects/${a.projectId}/tasks`,
    body: (a) => ({ title: a.title, description: a.description, priority: a.priority, labels: a.labels, adapter: a.adapter }),
  },
  cancel_task: { method: "POST", path: (a) => `/api/tasks/${a.taskId}/cancel` },
  delete_task: { method: "DELETE", path: (a) => `/api/tasks/${a.taskId}` },
  accept_task: { method: "POST", path: (a) => `/api/tasks/${a.taskId}/accept` },
  reject_task: { method: "POST", path: (a) => `/api/tasks/${a.taskId}/reject` },
  retry_task: { method: "POST", path: (a) => `/api/tasks/${a.taskId}/retry` },
  reply_task: { method: "POST", path: (a) => `/api/tasks/${a.taskId}/reply`, body: (a) => ({ content: a.content }) },
  create_project: {
    method: "POST",
    path: () => `/api/projects`,
    body: (a) => ({ name: a.name, repoPath: a.repoPath, description: a.description }),
  },
  rename_project: { method: "PATCH", path: (a) => `/api/projects/${a.projectId}`, body: (a) => ({ name: a.name }) },
  delete_project: { method: "DELETE", path: (a) => `/api/projects/${a.projectId}` },
};

export async function callCogniTool(deps: ToolDeps, name: string, args: Record<string, any>): Promise<string> {
  const route = ROUTES[name];
  if (!route) throw new Error(`unknown tool: ${name}`);
  const url = httpBaseFromWsUrl(deps.config.cloudUrl) + route.path(args);
  const init: RequestInit = {
    method: route.method,
    headers: { Authorization: `Host ${deps.config.registrationToken}`, "Content-Type": "application/json" },
  };
  if (route.body) init.body = JSON.stringify(route.body(args));
  const res = await deps.fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return JSON.stringify({ error: true, status: res.status, body: json });
  return JSON.stringify(json);
}

// Minimal JSON schema per tool (kept loose; the orchestrator prompt guides usage).
const INPUT_SCHEMAS: Record<string, object> = {
  list_projects: { type: "object", properties: {} },
  list_tasks: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
  create_task: {
    type: "object",
    properties: { projectId: { type: "string" }, title: { type: "string" }, description: { type: "string" } },
    required: ["projectId", "title"],
  },
  cancel_task: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  delete_task: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  accept_task: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  reject_task: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  retry_task: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  reply_task: {
    type: "object",
    properties: { taskId: { type: "string" }, content: { type: "string" } },
    required: ["taskId", "content"],
  },
  create_project: {
    type: "object",
    properties: { name: { type: "string" }, repoPath: { type: "string" } },
    required: ["name", "repoPath"],
  },
  rename_project: {
    type: "object",
    properties: { projectId: { type: "string" }, name: { type: "string" } },
    required: ["projectId", "name"],
  },
  delete_project: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
};

/**
 * Run the cogni stdio MCP server. Invoked by `main.js mcp-serve` as a child of
 * the Claude Code orchestrator runner. Reads `~/.cogni/host.json` for the
 * cloud URL + host token; bails loudly if the host isn't registered yet.
 */
export async function startCogniMcpServer(): Promise<void> {
  const config = await readHostConfig();
  if (!config) throw new Error("cogni mcp-serve: no ~/.cogni/host.json (register this host first)");
  const deps: ToolDeps = { fetch: globalThis.fetch, config };
  const server = new Server({ name: "cogni", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: COGNI_TOOL_NAMES.map((name) => ({
      name,
      description: `cogni ${name}`,
      inputSchema: INPUT_SCHEMAS[name]!,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const text = await callCogniTool(deps, req.params.name, req.params.arguments ?? {});
    return { content: [{ type: "text", text }] };
  });
  await server.connect(new StdioServerTransport());
}
