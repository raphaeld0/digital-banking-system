import http from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { openDatabase } from "./database.js";
import { createResendSender } from "./resend.js";

const database = openDatabase(config.databasePath);
const server = http.createServer(createApp({
  database,
  publicDirectory: config.publicDirectory,
  sessionHours: config.sessionHours,
  sendVerificationEmail: createResendSender(config.resendApiKey, config.resendFromEmail),
  verificationSecret: config.resendApiKey,
}));

server.listen(config.port, () => {
  console.log(`BankTest disponível em http://localhost:${config.port}`);
});

function shutdown(): void {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
