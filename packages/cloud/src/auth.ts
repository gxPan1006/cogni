import { SignJWT, jwtVerify } from "jose";
import { Google } from "arctic";

/**
 * SP-2: `sessionId` was added so the JWT can be revoked server-side. Every
 * issueToken caller must first create an `auth_sessions` row and pass its id
 * here. verifyToken still parses, but the actual revocation enforcement
 * happens at the HTTP middleware / WS handshake layer (which looks up
 * auth_sessions.revoked_at).
 */
export interface SessionClaims { userId: string; tenantId: string; sessionId: string }

export function makeAuth(opts: {
  jwtSecret: string;
  google: { clientId: string; clientSecret: string; redirectUri: string };
}) {
  const secret = new TextEncoder().encode(opts.jwtSecret);
  const google = new Google(opts.google.clientId, opts.google.clientSecret, opts.google.redirectUri);
  return {
    google,
    // SP-2: builds a Google client with a per-origin redirect_uri. Used by the
    // OAuth start + callback to switch between desktop's PUBLIC_URL/cogni:// flow
    // and web's WEB_URL flow without two long-lived clients.
    makeGoogle(redirectUri: string): Google {
      return new Google(opts.google.clientId, opts.google.clientSecret, redirectUri);
    },
    async issueToken(claims: SessionClaims): Promise<string> {
      return new SignJWT({ userId: claims.userId, tenantId: claims.tenantId, sessionId: claims.sessionId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(secret);
    },
    async verifyToken(token: string): Promise<SessionClaims | null> {
      try {
        const { payload } = await jwtVerify(token, secret);
        if (typeof payload.userId !== "string"
            || typeof payload.tenantId !== "string"
            || typeof payload.sessionId !== "string") return null;
        return { userId: payload.userId, tenantId: payload.tenantId, sessionId: payload.sessionId };
      } catch {
        return null;
      }
    },
  };
}
export type Auth = ReturnType<typeof makeAuth>;
