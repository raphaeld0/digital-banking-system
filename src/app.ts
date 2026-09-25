
import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "http";
import type { BankDatabase } from "./database.js";
import { createSessionToken, hashPassword, hashToken, verifyPassword } from "./auth.js";
import { ValidationError, validateCredentials, validateEmailChange, validateLegacyCredentials, validatePasswordChange, validateRegistration, validateResendRequest, validateTransfer, validateUsername, validateVerification } from "./validation.js";
import type { VerificationEmailSender } from "./resend.js";
import { generateVerificationCode, hashVerificationCode, matchesVerificationCode } from "./verification.js";

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

interface AppOptions {
  database: BankDatabase;
  publicDirectory: string;
  sessionHours: number;
  sendVerificationEmail: VerificationEmailSender;
  verificationSecret: string;
}

interface UserRow {
  id: number;
  name: string;
  email: string;
  username: string | null;
  password_hash: string;
  balance_cents: number;
  created_at: string;
}

interface PendingRegistrationRow {
  email: string;
  name: string;
  username: string;
  password_hash: string;
  code_hash: string;
  expires_at: number;
  attempts: number;
  last_sent_at: number;
}

export function createApp(options: AppOptions) {
  const { database, publicDirectory, sessionHours, sendVerificationEmail, verificationSecret } = options;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    setSecurityHeaders(response);
    const url = new URL(request.url ?? "/", "http://localhost");

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(response, 200, { status: "ok" });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/register") {
        const input = validateRegistration(await readJson(request));
        if (!verificationSecret) return json(response, 503, { error: "Envio de e-mail não configurado." });
        const now = Date.now();
        database.prepare("DELETE FROM pending_registrations WHERE expires_at <= ?").run(now);
        if (database.prepare("SELECT 1 FROM users WHERE email = ?").get(input.email)) {
          return json(response, 409, { error: "Este e-mail já está cadastrado." });
        }
        if (database.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(input.username)) {
          return json(response, 409, { error: "Este @usuário já está em uso." });
        }
        const previous = database.prepare("SELECT * FROM pending_registrations WHERE email = ?")
          .get(input.email) as unknown as PendingRegistrationRow | undefined;
        if (previous && now - previous.last_sent_at < RESEND_COOLDOWN_MS) {
          return json(response, 429, { error: "Aguarde um minuto antes de solicitar outro código." });
        }
        const reserved = database.prepare("SELECT email FROM pending_registrations WHERE username = ? COLLATE NOCASE")
          .get(input.username) as { email: string } | undefined;
        if (reserved && reserved.email.toLowerCase() !== input.email) {
          return json(response, 409, { error: "Este @usuário já está reservado por outro cadastro." });
        }
        const passwordHash = await hashPassword(input.password);
        let code = generateVerificationCode();
        let codeHash = hashVerificationCode(verificationSecret, input.email, code);
        while (previous && codeHash === previous.code_hash) {
          code = generateVerificationCode();
          codeHash = hashVerificationCode(verificationSecret, input.email, code);
        }
        try {
          if (previous) {
            const updated = database.prepare(`
              UPDATE pending_registrations SET name = ?, username = ?, password_hash = ?, code_hash = ?,
                expires_at = ?, attempts = 0, last_sent_at = ?
              WHERE email = ? AND code_hash = ? AND last_sent_at <= ?
            `).run(input.name, input.username, passwordHash, codeHash, now + CODE_LIFETIME_MS, now,
              input.email, previous.code_hash, now - RESEND_COOLDOWN_MS);
            if (updated.changes === 0) return json(response, 429, { error: "Aguarde um minuto antes de solicitar outro código." });
          } else {
            database.prepare(`
              INSERT INTO pending_registrations
                (email, name, username, password_hash, code_hash, expires_at, attempts, last_sent_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            `).run(input.email, input.name, input.username, passwordHash, codeHash, now + CODE_LIFETIME_MS, now);
          }
        } catch (error) {
          if (String(error).includes("UNIQUE constraint failed")) {
            return json(response, 409, { error: "E-mail ou @usuário já está em uso." });
          }
          throw error;
        }
        try {
          await sendVerificationEmail(input.email, code);
        } catch {
          restorePendingRegistration(database, previous, input.email, codeHash);
          return json(response, 502, { error: "Não foi possível enviar o código. Verifique o remetente configurado no Resend e tente novamente." });
        }
        return json(response, 202, { email: input.email, expiresInSeconds: 600 });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/resend-code") {
        const email = validateResendRequest(await readJson(request));
        if (!verificationSecret) return json(response, 503, { error: "Envio de e-mail não configurado." });
        const pending = database.prepare("SELECT * FROM pending_registrations WHERE email = ?")
          .get(email) as unknown as PendingRegistrationRow | undefined;
        if (!pending) return json(response, 404, { error: "Cadastro pendente não encontrado." });
        const now = Date.now();
        if (pending.expires_at <= now) {
          database.prepare("DELETE FROM pending_registrations WHERE email = ?").run(email);
          return json(response, 410, { error: "Código expirado. Inicie o cadastro novamente." });
        }
        if (now - pending.last_sent_at < RESEND_COOLDOWN_MS) {
          return json(response, 429, { error: "Aguarde um minuto antes de reenviar o código." });
        }
        let code = generateVerificationCode();
        let codeHash = hashVerificationCode(verificationSecret, email, code);
        while (codeHash === pending.code_hash) {
          code = generateVerificationCode();
          codeHash = hashVerificationCode(verificationSecret, email, code);
        }
        const updated = database.prepare(`
          UPDATE pending_registrations SET code_hash = ?, expires_at = ?, attempts = 0, last_sent_at = ?
          WHERE email = ? AND code_hash = ?
        `).run(codeHash, now + CODE_LIFETIME_MS, now, email, pending.code_hash);
        if (updated.changes === 0) return json(response, 409, { error: "O cadastro foi alterado. Tente novamente." });
        try {
          await sendVerificationEmail(email, code);
        } catch {
          restorePendingRegistration(database, pending, email, codeHash);
          return json(response, 502, { error: "Não foi possível reenviar o código. Tente novamente." });
        }
        return json(response, 202, { email, expiresInSeconds: 600 });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/verify") {
        const input = validateVerification(await readJson(request));
        if (!verificationSecret) return json(response, 503, { error: "Verificação de e-mail não configurada." });
        database.exec("BEGIN IMMEDIATE");
        try {
          const pending = database.prepare("SELECT * FROM pending_registrations WHERE email = ?")
            .get(input.email) as unknown as PendingRegistrationRow | undefined;
          if (!pending) {
            database.exec("ROLLBACK");
            return json(response, 404, { error: "Cadastro pendente não encontrado." });
          }
          if (pending.expires_at <= Date.now()) {
            database.prepare("DELETE FROM pending_registrations WHERE email = ?").run(input.email);
            database.exec("COMMIT");
            return json(response, 410, { error: "Código expirado. Inicie o cadastro novamente." });
          }
          if (!matchesVerificationCode(verificationSecret, input.email, input.code, pending.code_hash)) {
            if (pending.attempts + 1 >= MAX_CODE_ATTEMPTS) {
              database.prepare("DELETE FROM pending_registrations WHERE email = ?").run(input.email);
            } else {
              database.prepare("UPDATE pending_registrations SET attempts = attempts + 1 WHERE email = ?").run(input.email);
            }
            database.exec("COMMIT");
            return json(response, 400, { error: pending.attempts + 1 >= MAX_CODE_ATTEMPTS
              ? "Muitas tentativas. Inicie o cadastro novamente." : "Código incorreto." });
          }
          const result = database.prepare("INSERT INTO users (name, email, username, password_hash) VALUES (?, ?, ?, ?)")
            .run(pending.name, pending.email, pending.username, pending.password_hash);
          database.prepare("DELETE FROM pending_registrations WHERE email = ?").run(input.email);
          const user = findUserById(database, Number(result.lastInsertRowid));
          const token = issueSession(database, user.id, sessionHours);
          database.exec("COMMIT");
          return json(response, 201, { token, user: publicUser(user) });
        } catch (error) {
          database.exec("ROLLBACK");
          if (String(error).includes("UNIQUE constraint failed")) {
            return json(response, 409, { error: "E-mail ou @usuário já está em uso. Inicie o cadastro novamente." });
          }
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const input = validateCredentials(await readJson(request));
        const user = database.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(input.username) as unknown as UserRow | undefined;
        if (!user || !(await verifyPassword(input.password, user.password_hash))) {
          return json(response, 401, { error: "@usuário ou senha inválidos." });
        }
        const token = issueSession(database, user.id, sessionHours);
        return json(response, 200, { token, user: publicUser(user) });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/legacy-login") {
        const input = validateLegacyCredentials(await readJson(request));
        const user = database.prepare("SELECT * FROM users WHERE email = ? AND username IS NULL").get(input.email) as unknown as UserRow | undefined;
        if (!user || !(await verifyPassword(input.password, user.password_hash))) {
          return json(response, 401, { error: "E-mail ou senha inválidos, ou a conta já possui @usuário." });
        }
        const token = issueSession(database, user.id, sessionHours);
        return json(response, 200, { token, user: publicUser(user) });
      }
      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        const user = authenticate(database, request);
        if (!user) return json(response, 401, { error: "Sessão inválida ou expirada." });
        return json(response, 200, { user: publicUser(user) });
      }
      if (request.method === "POST" && url.pathname === "/api/account/username") {
        const user = authenticate(database, request);
        if (!user) return json(response, 401, { error: "Sessão inválida ou expirada." });
        if (user.username) return json(response, 409, { error: "Esta conta já possui @usuário." });
        const body = await readJson(request);
        const username = validateUsername((body as Record<string, unknown>)?.username);
        try {
          database.prepare("UPDATE users SET username = ? WHERE id = ? AND username IS NULL").run(username, user.id);
        } catch (error) {
          if (String(error).includes("UNIQUE constraint failed")) return json(response, 409, { error: "Este @usuário já está em uso." });
          throw error;
        }
        return json(response, 200, { user: publicUser(findUserById(database, user.id)) });
      }
      if (request.method === "PATCH" && url.pathname === "/api/account/email") {
        const user = authenticate(database, request);
        if (!user) return json(response, 401, { error: "Sessão inválida ou expirada." });
        const input = validateEmailChange(await readJson(request));
        if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
          return json(response, 403, { error: "Senha atual incorreta." });
        }
        try {
          const updated = database.prepare("UPDATE users SET email = ? WHERE id = ? AND password_hash = ?")
            .run(input.email, user.id, user.password_hash);
          if (updated.changes === 0) return json(response, 409, { error: "A conta foi alterada. Tente novamente." });
        } catch (error) {
          if (String(error).includes("users.email")) return json(response, 409, { error: "Este e-mail já está cadastrado." });
          throw error;
        }
        return json(response, 200, { user: publicUser(findUserById(database, user.id)) });
      }
      if (request.method === "PATCH" && url.pathname === "/api/account/password") {
        const user = authenticate(database, request);
        if (!user) return json(response, 401, { error: "Sessão inválida ou expirada." });
        const input = validatePasswordChange(await readJson(request));
        if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
          return json(response, 403, { error: "Senha atual incorreta." });
        }
        const newHash = await hashPassword(input.newPassword);
        database.exec("BEGIN IMMEDIATE");
        try {
          const updated = database.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?")
            .run(newHash, user.id, user.password_hash);
          if (updated.changes === 0) {
            database.exec("ROLLBACK");
            return json(response, 409, { error: "A conta foi alterada. Tente novamente." });
          }
          database.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?")
            .run(user.id, hashToken(bearerToken(request)!));
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        return json(response, 200, { message: "Senha alterada. Outras sessões foram encerradas." });
      }
      if (request.method === "POST" && url.pathname === "/api/account/demo-credit") {
        const user = authenticate(database, request);
        if (!user) return json(response, 401, { error: "Sessão inválida ou expirada." });
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = database.prepare("INSERT INTO demo_credits (user_id, amount_cents) VALUES (?, 100000) ON CONFLICT(user_id) DO NOTHING").run(user.id);
          if (result.changes === 0) {
            database.exec("ROLLBACK");
            return json(response, 409, { error: "O saldo de teste já foi adicionado a esta conta." });
          }
          database.prepare("UPDATE users SET balance_cents = balance_cents + 100000 WHERE id = ?").run(user.id);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        return json(response, 200, { user: publicUser(findUserById(database, user.id)) });
      }
      if (request.method === "GET" && url.pathname === "/api/favorites") {
        const user = authenticate(database, request);
        if (!user) return json(response, 401, { error: "Sessão inválida ou expirada." });
        const contacts = database.prepare(`
          SELECT u.name, u.username, f.created_at AS addedAt
          FROM favorite_contacts f
          JOIN users u ON u.id = f.contact_id
          WHERE f.owner_id = ?
          ORDER BY f.created_at DESC, u.name COLLATE NOCASE
        `).all(user.id);
        return json(response, 200, { contacts });
      }
      if (request.method === "POST" && url.pathname === "/api/favorites") {
        const user = authenticate(database, request);
        if (!user) return json(response, 401, { error: "Sessão inválida ou expirada." });
        const body = await readJson(request) as Record<string, unknown>;
        const username = validateUsername(body?.username);
        const contact = database.prepare("SELECT id, name, username FROM users WHERE username = ? COLLATE NOCASE")
          .get(username) as { id: number; name: string; username: string } | undefined;
        if (!contact) return json(response, 404, { error: "@usuário não encontrado." });
        if (contact.id === user.id) return json(response, 400, { error: "Você não pode favoritar sua própria conta." });
        const result = database.prepare("INSERT INTO favorite_contacts (owner_id, contact_id) VALUES (?, ?) ON CONFLICT DO NOTHING")
          .run(user.id, contact.id);
        if (result.changes === 0) return json(response, 409, { error: "Este contato já está nos favoritos." });
        return json(response, 201, { contact: { name: contact.name, username: contact.username } });
      }
      if (request.method === "DELETE" && url.pathname === "/api/favorites") {
        const user = authenticate(database, request);
        if (!user) return json(response, 401, { error: "Sessão inválida ou expirada." });
        const body = await readJson(request) as Record<string, unknown>;
        const username = validateUsername(body?.username);
        const result = database.prepare(`
          DELETE FROM favorite_contacts
          WHERE owner_id = ? AND contact_id IN (SELECT id FROM users WHERE username = ? COLLATE NOCASE)
        `).run(user.id, username);
        if (result.changes === 0) return json(response, 404, { error: "Contato não está nos favoritos." });
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/transfers") {
        const user = authenticate(database, request);
        if (!user) return json(response, 401, { error: "Sessão inválida ou expirada." });
        if (!user.username) return json(response, 409, { error: "Escolha seu @usuário antes de transferir." });
        const input = validateTransfer(await readJson(request));
        database.exec("BEGIN IMMEDIATE");
        try {
          const recipient = database.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(input.recipientUsername) as unknown as UserRow | undefined;
          if (!recipient) {
            database.exec("ROLLBACK");
            return json(response, 404, { error: "@usuário de destino não encontrado." });
          }
          if (recipient.id === user.id) {
            database.exec("ROLLBACK");
            return json(response, 400, { error: "Você não pode transferir para sua própria conta." });
          }
          const debit = database.prepare("UPDATE users SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?")
            .run(input.amountCents, user.id, input.amountCents);
          if (debit.changes === 0) {
            database.exec("ROLLBACK");
            return json(response, 409, { error: "Saldo insuficiente." });
          }
          database.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?").run(input.amountCents, recipient.id);
          const result = database.prepare("INSERT INTO transfers (sender_id, recipient_id, amount_cents) VALUES (?, ?, ?)")
            .run(user.id, recipient.id, input.amountCents);
          database.exec("COMMIT");
          return json(response, 201, {
            transfer: { id: Number(result.lastInsertRowid), to: `@${recipient.username}`, amountCents: input.amountCents },
            user: publicUser(findUserById(database, user.id)),
          });
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/statement") {
        const user = authenticate(database, request);
        if (!user) return json(response, 401, { error: "Sessão inválida ou expirada." });
        const entries = database.prepare(`
          SELECT t.id, t.created_at AS createdAt, 'transfer' AS type,
            CASE WHEN t.sender_id = ? THEN -t.amount_cents ELSE t.amount_cents END AS amountCents,
            u.name AS counterpartyName, u.username AS counterpartyUsername
          FROM transfers t
          JOIN users u ON u.id = CASE WHEN t.sender_id = ? THEN t.recipient_id ELSE t.sender_id END
          WHERE t.sender_id = ? OR t.recipient_id = ?
          UNION ALL
          SELECT d.id, d.created_at AS createdAt, 'demo_credit' AS type,
            d.amount_cents AS amountCents, NULL AS counterpartyName, NULL AS counterpartyUsername
          FROM demo_credits d WHERE d.user_id = ?
          ORDER BY createdAt DESC, id DESC LIMIT 50
        `).all(user.id, user.id, user.id, user.id, user.id);
        return json(response, 200, { entries });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const token = bearerToken(request);
        if (token) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app.js" || url.pathname === "/theme.js" || url.pathname === "/styles.css")) {
        return serveStatic(response, publicDirectory, url.pathname);
      }
      json(response, 404, { error: "Rota não encontrada." });
    } catch (error) {
      if (error instanceof ValidationError || error instanceof SyntaxError) {
        return json(response, 400, { error: error instanceof ValidationError ? error.message : "JSON inválido." });
      }
      if (error instanceof PayloadTooLargeError) return json(response, 413, { error: error.message });
      console.error(error);
      json(response, 500, { error: "Erro interno do servidor." });
    }
  };
}

function restorePendingRegistration(
  database: BankDatabase,
  previous: PendingRegistrationRow | undefined,
  email: string,
  failedCodeHash: string,
): void {
  if (!previous) {
    database.prepare("DELETE FROM pending_registrations WHERE email = ? AND code_hash = ?")
      .run(email, failedCodeHash);
    return;
  }
  database.prepare(`
    UPDATE pending_registrations SET name = ?, username = ?, password_hash = ?, code_hash = ?,
      expires_at = ?, attempts = ?, last_sent_at = ?
    WHERE email = ? AND code_hash = ?
  `).run(previous.name, previous.username, previous.password_hash, previous.code_hash,
    previous.expires_at, previous.attempts, previous.last_sent_at, email, failedCodeHash);
}

function findUserById(database: BankDatabase, id: number): UserRow {
  return database.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow;
}

function issueSession(database: BankDatabase, userId: number, hours: number): string {
  database.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace("T", " ");
  database.prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)")
    .run(userId, hashToken(token), expiresAt);
  return token;
}

function authenticate(database: BankDatabase, request: IncomingMessage): UserRow | undefined {
  const token = bearerToken(request);
  if (!token) return undefined;
  return database.prepare(`
    SELECT users.* FROM users
    JOIN sessions ON sessions.user_id = users.id
    WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')
  `).get(hashToken(token)) as unknown as UserRow | undefined;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice(7).trim();
  return token || undefined;
}

function publicUser(user: UserRow) {
  return { id: user.id, name: user.name, email: user.email, username: user.username, balanceCents: user.balance_cents, createdAt: user.created_at };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new PayloadTooLargeError("O corpo da requisição é muito grande.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

class PayloadTooLargeError extends Error {}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
}

async function serveStatic(response: ServerResponse, directory: string, pathname: string): Promise<void> {
  const filename = pathname === "/" ? "index.html" : pathname.slice(1);
  const contentTypes: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const content = await fs.readFile(path.join(directory, filename));
  response.writeHead(200, { "Content-Type": `${contentTypes[path.extname(filename)] ?? "application/octet-stream"}; charset=utf-8` });
  response.end(content);
}
