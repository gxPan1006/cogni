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
