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
  const portRaw = process.env.PORT ?? "8787";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: "${portRaw}" (must be an integer 1-65535)`);
  }

  return {
    databaseUrl: get("DATABASE_URL"),
    jwtSecret: get("JWT_SECRET"),
    googleClientId: get("GOOGLE_CLIENT_ID"),
    googleClientSecret: get("GOOGLE_CLIENT_SECRET"),
    publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8787",
    port,
  };
}
