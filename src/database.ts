import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type BankDatabase = DatabaseSync;

export function openDatabase(filename: string): BankDatabase {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrate(database);
  return database;
}

function migrate(database: BankDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);

  // Contas criadas antes do recurso de @usuário continuam acessíveis.
  const columns = database.prepare("PRAGMA table_info(users)").all() as unknown as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "username")) {
    database.exec("ALTER TABLE users ADD COLUMN username TEXT");
  }

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      recipient_id INTEGER NOT NULL REFERENCES users(id),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (sender_id <> recipient_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_sender ON transfers(sender_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_recipient ON transfers(recipient_id, id DESC);

    CREATE TABLE IF NOT EXISTS demo_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_registrations (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      name TEXT NOT NULL,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_registrations_expiry ON pending_registrations(expires_at);

    CREATE TABLE IF NOT EXISTS favorite_contacts (
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_id, contact_id),
      CHECK (owner_id <> contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_favorite_contacts_owner ON favorite_contacts(owner_id, created_at DESC);
  `);
}
