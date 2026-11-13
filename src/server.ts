import http from "node:http";
import { createApp, processDueScheduledTransfers } from "./app.js";
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

processDueScheduledTransfers(database);
const scheduledTransferTimer = setInterval(() => processDueScheduledTransfers(database), 30_000);

server.listen(config.port, () => {
  console.log(`BankTest disponível em http://localhost:${config.port}`);
});

function shutdown(): void {
  clearInterval(scheduledTransferTimer);
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
