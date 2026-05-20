/**
 * Password hashing for email+password auth.
 *
 * Uses Node's built-in `crypto.scrypt` — no third-party dependency. The encoded
 * form stored in `users.password_hash` is:
 *
 *     scrypt$<saltBase64>$<derivedKeyBase64>
 *
 * scrypt is memory-hard, which is the property that matters against offline
 * brute-force of a leaked hash. The cost parameters are baked into the string
 * implicitly via the fixed N/r/p below; if we ever raise them we can detect
 * the old format and rehash on next successful login. Verification is
 * constant-time (`timingSafeEqual`) so a wrong password can't be distinguished
 * from a right one by timing the comparison.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LEN = 64;
const SALT_LEN = 16;
const PREFIX = "scrypt";

/** Derive an encoded `scrypt$salt$key` string from a plaintext password. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(plain, salt, KEY_LEN);
  return `${PREFIX}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/**
 * Constant-time check of a plaintext password against an encoded hash. Returns
 * false (never throws) for any malformed/foreign encoding, so a corrupt row
 * just fails the login rather than 500-ing the request.
 */
export async function verifyPassword(plain: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1]!, "base64");
    expected = Buffer.from(parts[2]!, "base64");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  const actual = await scrypt(plain, salt, KEY_LEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
