import { hashPassword } from "./auth.js";
import { config } from "./config.js";
import { openDatabase } from "./database.js";

const database = openDatabase(config.databasePath);

try {
  const existing = database.prepare("SELECT username, email FROM users WHERE username = ? COLLATE NOCASE OR email = ?")
    .all("admin", "admin@gmail.com") as Array<{ username: string | null; email: string }>;
  const matching = existing[0];
  if (existing.length > 0) {
    if (existing.length === 1 && matching?.username?.toLowerCase() === "admin" && matching.email.toLowerCase() === "admin@gmail.com") {
      console.log("A conta @admin já existe; senha e saldo foram preservados.");
    } else {
      throw new Error("@admin ou admin@gmail.com já pertence a outra conta.");
    }
  } else {
    const passwordHash = await hashPassword("admin");
    database.prepare("INSERT INTO users (name, username, email, password_hash, balance_cents) VALUES (?, ?, ?, ?, ?)")
      .run("Admin", "admin", "admin@gmail.com", passwordHash, 900_000_000);
    console.log("Conta de demonstração @admin criada com R$ 9.000.000,00.");
  }
} finally {
  database.close();
}
