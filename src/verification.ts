import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export function generateVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashVerificationCode(secret: string, email: string, code: string): string {
  return createHmac("sha256", secret).update(`registration:${email}:${code}`).digest("hex");
}

export function matchesVerificationCode(secret: string, email: string, code: string, storedHash: string): boolean {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashVerificationCode(secret, email, code), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
