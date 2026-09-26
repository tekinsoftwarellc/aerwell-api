import { createHash, createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { AppError } from "../../common/errors/AppError.js";
import { env } from "../../config/env.js";
export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
export const opaqueToken = () => randomBytes(48).toString("base64url");
export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
export function signingKey(): string {
  if (!(env.STAFF_JWT_SECRET && env.AERWELL_ORG_ID))
    throw new AppError("Staff sign-in is not configured", 503, true, undefined, "AUTH_UNAVAILABLE");
  return env.STAFF_JWT_SECRET;
}
export const hashCode = (value: string) =>
  createHmac("sha256", signingKey()).update(value).digest("hex");
let dummy: Promise<string> | undefined;
export async function equalizePassword(value: string): Promise<void> {
  dummy ??= hashPassword(opaqueToken());
  await verifyPassword(value, await dummy);
}
