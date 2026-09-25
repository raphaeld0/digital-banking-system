import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

const envFile = path.resolve(".env");
if (fs.existsSync(envFile)) loadEnvFile(envFile);

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: positiveInteger(process.env.PORT, 3000),
  databasePath: path.resolve(process.env.DATABASE_PATH ?? "./data/bank.db"),
  sessionHours: positiveInteger(process.env.SESSION_HOURS, 24),
  publicDirectory: path.resolve("public"),
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  resendFromEmail: process.env.RESEND_FROM_EMAIL ?? "BankTest <onboarding@resend.dev>",
};
