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
