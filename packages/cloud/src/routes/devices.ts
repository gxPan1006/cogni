import type { Hono } from "hono";
import {
  getAuthSession,
  listAuthSessionsForUser,
  revokeAuthSession,
} from "../db/auth-sessions.js";
import type { ServerDeps } from "../server.js";

/**
 * Settings → "已同步的设备" 路由。
 *
 * - GET /api/devices
 *   列出该用户所有未 revoke 的登录会话(每台 desktop / web 端一行)。
 *   当前请求自己用的那台 session 标记 `isCurrent: true`,UI 据此显示
 *   "(当前设备)"角标,并隐藏"撤销"按钮(撤销自己等同于登出,settings 走专门
 *   的"退出登录"路径,不在 device list 里做)。
 *
 * - DELETE /api/devices/:id
 *   把指定 session 标记 revoked。下一次该 session 的 token 命中
 *   client.ts Bearer 中间件时会被 401 踢掉(此处不主动断开 WS,WS 也会因为
 *   下一次请求或重连被拒绝)。同时通过 publishUserBroadcast 给用户其它
 *   在线客户端发 device-list-changed,让 settings 页面里"已同步的设备"
 *   列表实时少一行,无需手动刷新。
 *
 * Bearer 鉴权依赖 client.ts 里挂在 `/api/*` 上的 middleware —— 它已经验签 + 拉
 * auth_session + setClaims,所以这里直接 c.get("claims") 即可。
 */
export function registerDevicesRoutes(app: Hono, deps: ServerDeps): void {
  app.get("/api/devices", async (c) => {
    const { userId, sessionId } = c.get("claims");
    const rows = await listAuthSessionsForUser(deps.db, userId);
    return c.json(
      rows.map((d) => ({
        id: d.id,
        deviceName: d.deviceName,
        userAgent: d.userAgent,
        ip: d.ip,
        createdAt: d.createdAt.toISOString(),
        lastSeenAt: d.lastSeenAt.toISOString(),
        isCurrent: d.id === sessionId,
      })),
    );
  });

  app.delete("/api/devices/:id", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    const target = await getAuthSession(deps.db, id);
    // 404 (不是 403) 用来同时覆盖 "id 不存在" 和 "id 属于别人" —— 避免一个
    // 探针接口告诉攻击者某 session id 是否真实存在。
    if (!target || target.userId !== userId) {
      return c.json({ error: "not found" }, 404);
    }
    await revokeAuthSession(deps.db, id);
    deps.clients.publishUserBroadcast(userId, { t: "device-list-changed" });
    return c.json({ ok: true });
  });
}
