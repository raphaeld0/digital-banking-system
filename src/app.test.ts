import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { createApp } from "./app.js";
import { openDatabase, type BankDatabase } from "./database.js";

let origin: string;
let database: BankDatabase;
let server: http.Server;
let temporaryDirectory: string;
const sentCodes = new Map<string, string>();
let failNextSend = false;

before(async () => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mini-bank-"));
  database = openDatabase(path.join(temporaryDirectory, "test.db"));
  server = http.createServer(createApp({
    database,
    publicDirectory: path.resolve("public"),
    sessionHours: 1,
    verificationSecret: "chave-de-testes-do-cadastro",
    sendVerificationEmail: async (email, code) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error("Falha simulada no envio");
      }
      sentCodes.set(email, code);
    },
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Servidor de teste não iniciou.");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("cadastro, sessão, login e logout", async () => {
  const started = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Ana Silva", username: "@ana_silva", email: "ANA@example.com", password: "segura123" }),
  });
  assert.equal(started.response.status, 202);
  assert.equal(started.body.token, undefined);

  const beforeVerification = await request("/api/auth/login", {
    method: "POST", body: JSON.stringify({ username: "ana_silva", password: "segura123" }),
  });
  assert.equal(beforeVerification.response.status, 401);

  const wrongCode = await request("/api/auth/verify", {
    method: "POST", body: JSON.stringify({ email: "ana@example.com", code: "999999" === sentCodes.get("ana@example.com") ? "000000" : "999999" }),
  });
  assert.equal(wrongCode.response.status, 400);

  const registered = await request("/api/auth/verify", {
    method: "POST", body: JSON.stringify({ email: "ana@example.com", code: sentCodes.get("ana@example.com") }),
  });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.body.user.email, "ana@example.com");
  assert.equal(registered.body.user.username, "ana_silva");
  assert.equal(registered.body.user.balanceCents, 0);
  assert.equal(typeof registered.body.token, "string");

  const me = await request("/api/auth/me", {}, registered.body.token);
  assert.equal(me.response.status, 200);
  assert.equal(me.body.user.name, "Ana Silva");

  const invalid = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "@ana_silva", password: "senha-errada" }),
  });
  assert.equal(invalid.response.status, 401);

  const loggedIn = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "@ANA_SILVA", password: "segura123" }),
  });
  assert.equal(loggedIn.response.status, 200);

  const emailLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "ana@example.com", password: "segura123" }),
  });
  assert.equal(emailLogin.response.status, 400);

  const logout = await request("/api/auth/logout", { method: "POST" }, loggedIn.body.token);
  assert.equal(logout.response.status, 204);
  const endedSession = await request("/api/auth/me", {}, loggedIn.body.token);
  assert.equal(endedSession.response.status, 401);
});

test("impede e-mail duplicado e senha fraca", async () => {
  const duplicate = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Outra Ana", username: "outra_ana", email: "ana@example.com", password: "outrasenha123" }),
  });
  assert.equal(duplicate.response.status, 409);

  const weak = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "João", username: "joao", email: "joao@example.com", password: "curta" }),
  });
  assert.equal(weak.response.status, 400);

  const duplicateUsername = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Outra Pessoa", username: "ANA_SILVA", email: "outro@example.com", password: "segura123" }),
  });
  assert.equal(duplicateUsername.response.status, 409);
});

test("transferência atualiza ambos os saldos e aparece nos dois extratos", async () => {
  const sender = await registerAndVerify({ name: "Rafael Dias", username: "raphaeldias", email: "rafael@example.com", password: "segura123" });
  const recipient = await registerAndVerify({ name: "Bia Lima", username: "bialima", email: "bia@example.com", password: "segura123" });
  assert.equal(sender.response.status, 201);
  assert.equal(recipient.response.status, 201);

  const noFunds = await request("/api/transfers", {
    method: "POST", body: JSON.stringify({ recipientUsername: "@bialima", amountCents: 2500 }),
  }, sender.body.token);
  assert.equal(noFunds.response.status, 409);

  const credit = await request("/api/account/demo-credit", { method: "POST" }, sender.body.token);
  assert.equal(credit.response.status, 200);
  assert.equal(credit.body.user.balanceCents, 100000);
  const repeatedCredit = await request("/api/account/demo-credit", { method: "POST" }, sender.body.token);
  assert.equal(repeatedCredit.response.status, 409);

  const self = await request("/api/transfers", {
    method: "POST", body: JSON.stringify({ recipientUsername: "@raphaeldias", amountCents: 2500 }),
  }, sender.body.token);
  assert.equal(self.response.status, 400);

  const invalidAmount = await request("/api/transfers", {
    method: "POST", body: JSON.stringify({ recipientUsername: "@bialima", amountCents: 1.5 }),
  }, sender.body.token);
  assert.equal(invalidAmount.response.status, 400);

  const transfer = await request("/api/transfers", {
    method: "POST", body: JSON.stringify({ recipientUsername: "@BIALIMA", amountCents: 2500 }),
  }, sender.body.token);
  assert.equal(transfer.response.status, 201);
  assert.equal(transfer.body.user.balanceCents, 97500);
  assert.equal(transfer.body.transfer.to, "@bialima");

  const recipientMe = await request("/api/auth/me", {}, recipient.body.token);
  assert.equal(recipientMe.body.user.balanceCents, 2500);

  const senderStatement = await request("/api/statement", {}, sender.body.token);
  assert.equal(senderStatement.response.status, 200);
  assert.deepEqual(senderStatement.body.entries.map((entry: any) => entry.amountCents).sort((a: number, b: number) => a - b), [-2500, 100000]);
  assert.equal(senderStatement.body.entries.find((entry: any) => entry.type === "transfer").counterpartyUsername, "bialima");

  const recipientStatement = await request("/api/statement", {}, recipient.body.token);
  assert.equal(recipientStatement.response.status, 200);
  assert.equal(recipientStatement.body.entries.length, 1);
  assert.equal(recipientStatement.body.entries[0].amountCents, 2500);
  assert.equal(recipientStatement.body.entries[0].counterpartyUsername, "raphaeldias");
});

test("amizades favoritas são unilaterais e independem de transferência", async () => {
  const owner = await registerAndVerify({ name: "Lia Costa", username: "liacosta", email: "lia@example.com", password: "segura123" });
  const contact = await registerAndVerify({ name: "Theo Rocha", username: "theorocha", email: "theo@example.com", password: "segura123" });
  const ownerToken = owner.body.token;
  const contactToken = contact.body.token;

  const unauthorized = await request("/api/favorites");
  assert.equal(unauthorized.response.status, 401);
  const unknown = await request("/api/favorites", {
    method: "POST", body: JSON.stringify({ username: "@naoexiste" }),
  }, ownerToken);
  assert.equal(unknown.response.status, 404);
  const self = await request("/api/favorites", {
    method: "POST", body: JSON.stringify({ username: "@liacosta" }),
  }, ownerToken);
  assert.equal(self.response.status, 400);

  const added = await request("/api/favorites", {
    method: "POST", body: JSON.stringify({ username: "@THEOROCHA" }),
  }, ownerToken);
  assert.equal(added.response.status, 201);
  assert.equal(added.body.contact.username, "theorocha");
  const repeated = await request("/api/favorites", {
    method: "POST", body: JSON.stringify({ username: "theorocha" }),
  }, ownerToken);
  assert.equal(repeated.response.status, 409);

  const ownerList = await request("/api/favorites", {}, ownerToken);
  assert.deepEqual(ownerList.body.contacts.map((item: any) => item.username), ["theorocha"]);
  const contactList = await request("/api/favorites", {}, contactToken);
  assert.deepEqual(contactList.body.contacts, []);
  const statement = await request("/api/statement", {}, ownerToken);
  assert.deepEqual(statement.body.entries, []);

  const removed = await request("/api/favorites", {
    method: "DELETE", body: JSON.stringify({ username: "@theorocha" }),
  }, ownerToken);
  assert.equal(removed.response.status, 204);
  const after = await request("/api/favorites", {}, ownerToken);
  assert.deepEqual(after.body.contacts, []);
  const repeatedRemoval = await request("/api/favorites", {
    method: "DELETE", body: JSON.stringify({ username: "theorocha" }),
  }, ownerToken);
  assert.equal(repeatedRemoval.response.status, 404);
});

test("migração mantém contas antigas e permite escolher @usuário", async () => {
  const filename = path.join(temporaryDirectory, "legacy.db");
  const legacy = new DatabaseSync(filename);
  legacy.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, password_hash TEXT, balance_cents INTEGER DEFAULT 0, created_at TEXT)");
  legacy.prepare("INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, datetime('now'))")
    .run("Usuário antigo", "antigo@example.com", "hash-antigo");
  legacy.close();

  const migrated = openDatabase(filename);
  const before = migrated.prepare("SELECT username FROM users WHERE email = ?").get("antigo@example.com") as { username: string | null };
  assert.equal(before.username, null);
  migrated.prepare("UPDATE users SET username = ? WHERE email = ?").run("usuario_antigo", "antigo@example.com");
  const after = migrated.prepare("SELECT username FROM users WHERE email = ?").get("antigo@example.com") as { username: string };
  assert.equal(after.username, "usuario_antigo");
  migrated.close();
});

test("conta existente sem @usuário escolhe um identificador autenticada", async () => {
  const registered = await registerAndVerify({ name: "Conta Antiga", username: "temporario", email: "antiga2@example.com", password: "segura123" });
  assert.equal(registered.response.status, 201);
  database.prepare("UPDATE users SET username = NULL WHERE id = ?").run(registered.body.user.id);

  const legacyLogin = await request("/api/auth/legacy-login", {
    method: "POST", body: JSON.stringify({ email: "antiga2@example.com", password: "segura123" }),
  });
  assert.equal(legacyLogin.response.status, 200);
  assert.equal(legacyLogin.body.user.username, null);

  const withoutSession = await request("/api/account/username", {
    method: "POST", body: JSON.stringify({ username: "@novo_nome" }),
  });
  assert.equal(withoutSession.response.status, 401);

  const claimed = await request("/api/account/username", {
    method: "POST", body: JSON.stringify({ username: "@novo_nome" }),
  }, registered.body.token);
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.body.user.username, "novo_nome");

  const repeated = await request("/api/account/username", {
    method: "POST", body: JSON.stringify({ username: "@outro_nome" }),
  }, registered.body.token);
  assert.equal(repeated.response.status, 409);

  const oldMethod = await request("/api/auth/legacy-login", {
    method: "POST", body: JSON.stringify({ email: "antiga2@example.com", password: "segura123" }),
  });
  assert.equal(oldMethod.response.status, 401);

  const newMethod = await request("/api/auth/login", {
    method: "POST", body: JSON.stringify({ username: "@novo_nome", password: "segura123" }),
  });
  assert.equal(newMethod.response.status, 200);
});

test("configurações alteram e-mail e senha com confirmação da senha atual", async () => {
  const registered = await registerAndVerify({ name: "Maria Souza", username: "mariasouza", email: "maria@example.com", password: "senhaInicial123" });
  assert.equal(registered.response.status, 201);
  const token = registered.body.token;

  const otherSession = await request("/api/auth/login", {
    method: "POST", body: JSON.stringify({ username: "@mariasouza", password: "senhaInicial123" }),
  });
  assert.equal(otherSession.response.status, 200);

  const noSession = await request("/api/account/email", {
    method: "PATCH", body: JSON.stringify({ email: "nova@example.com", currentPassword: "senhaInicial123" }),
  });
  assert.equal(noSession.response.status, 401);

  const wrongPassword = await request("/api/account/email", {
    method: "PATCH", body: JSON.stringify({ email: "nova@example.com", currentPassword: "senhaErrada123" }),
  }, token);
  assert.equal(wrongPassword.response.status, 403);

  const duplicate = await request("/api/account/email", {
    method: "PATCH", body: JSON.stringify({ email: "ana@example.com", currentPassword: "senhaInicial123" }),
  }, token);
  assert.equal(duplicate.response.status, 409);

  const changedEmail = await request("/api/account/email", {
    method: "PATCH", body: JSON.stringify({ email: "NOVA@example.com", currentPassword: "senhaInicial123" }),
  }, token);
  assert.equal(changedEmail.response.status, 200);
  assert.equal(changedEmail.body.user.email, "nova@example.com");

  const weakPassword = await request("/api/account/password", {
    method: "PATCH", body: JSON.stringify({ currentPassword: "senhaInicial123", newPassword: "fraca" }),
  }, token);
  assert.equal(weakPassword.response.status, 400);

  const wrongCurrentPassword = await request("/api/account/password", {
    method: "PATCH", body: JSON.stringify({ currentPassword: "incorreta123", newPassword: "senhaNova456" }),
  }, token);
  assert.equal(wrongCurrentPassword.response.status, 403);

  const changedPassword = await request("/api/account/password", {
    method: "PATCH", body: JSON.stringify({ currentPassword: "senhaInicial123", newPassword: "senhaNova456" }),
  }, token);
  assert.equal(changedPassword.response.status, 200);

  const stillActive = await request("/api/auth/me", {}, token);
  assert.equal(stillActive.response.status, 200);
  assert.equal(stillActive.body.user.email, "nova@example.com");
  const revoked = await request("/api/auth/me", {}, otherSession.body.token);
  assert.equal(revoked.response.status, 401);

  const oldLogin = await request("/api/auth/login", {
    method: "POST", body: JSON.stringify({ username: "mariasouza", password: "senhaInicial123" }),
  });
  assert.equal(oldLogin.response.status, 401);
  const newLogin = await request("/api/auth/login", {
    method: "POST", body: JSON.stringify({ username: "mariasouza", password: "senhaNova456" }),
  });
  assert.equal(newLogin.response.status, 200);
});

test("código pode ser reenviado após intervalo e expira", async () => {
  const email = "resend@example.com";
  const started = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Usuário Reenvio", username: "reenvio", email, password: "segura123" }),
  });
  assert.equal(started.response.status, 202);

  const early = await request("/api/auth/resend-code", { method: "POST", body: JSON.stringify({ email }) });
  assert.equal(early.response.status, 429);

  database.prepare("UPDATE pending_registrations SET last_sent_at = ? WHERE email = ?")
    .run(Date.now() - 61_000, email);
  const resent = await request("/api/auth/resend-code", { method: "POST", body: JSON.stringify({ email }) });
  assert.equal(resent.response.status, 202);

  const verified = await request("/api/auth/verify", {
    method: "POST", body: JSON.stringify({ email, code: sentCodes.get(email) }),
  });
  assert.equal(verified.response.status, 201);

  const expiredEmail = "expirado@example.com";
  const expiring = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Usuário Expirado", username: "expirado", email: expiredEmail, password: "segura123" }),
  });
  assert.equal(expiring.response.status, 202);
  database.prepare("UPDATE pending_registrations SET expires_at = ? WHERE email = ?")
    .run(Date.now() - 1, expiredEmail);
  const expired = await request("/api/auth/verify", {
    method: "POST", body: JSON.stringify({ email: expiredEmail, code: sentCodes.get(expiredEmail) }),
  });
  assert.equal(expired.response.status, 410);
});

test("cinco códigos incorretos bloqueiam o cadastro pendente", async () => {
  const email = "tentativas@example.com";
  const started = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Usuário Tentativas", username: "tentativas", email, password: "segura123" }),
  });
  assert.equal(started.response.status, 202);
  const wrongCode = sentCodes.get(email) === "000000" ? "999999" : "000000";
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await request("/api/auth/verify", {
      method: "POST", body: JSON.stringify({ email, code: wrongCode }),
    });
    assert.equal(result.response.status, 400);
  }
  const last = await request("/api/auth/verify", {
    method: "POST", body: JSON.stringify({ email, code: sentCodes.get(email) }),
  });
  assert.equal(last.response.status, 404);
});

test("falha no e-mail não deixa cadastro preso e preserva código anterior no reenvio", async () => {
  const email = "falha@example.com";
  failNextSend = true;
  const failed = await request("/api/auth/register", {
    method: "POST", body: JSON.stringify({ name: "Teste Falha", username: "testefalha", email, password: "segura123" }),
  });
  assert.equal(failed.response.status, 502);
  assert.equal(database.prepare("SELECT 1 FROM pending_registrations WHERE email = ?").get(email), undefined);

  const started = await request("/api/auth/register", {
    method: "POST", body: JSON.stringify({ name: "Teste Falha", username: "testefalha", email, password: "segura123" }),
  });
  assert.equal(started.response.status, 202);
  const originalCode = sentCodes.get(email);
  database.prepare("UPDATE pending_registrations SET last_sent_at = ? WHERE email = ?")
    .run(Date.now() - 61_000, email);

  failNextSend = true;
  const resendFailed = await request("/api/auth/resend-code", {
    method: "POST", body: JSON.stringify({ email }),
  });
  assert.equal(resendFailed.response.status, 502);
  const verified = await request("/api/auth/verify", {
    method: "POST", body: JSON.stringify({ email, code: originalCode }),
  });
  assert.equal(verified.response.status, 201);
});

test("interface e arquivos do painel são servidos", async () => {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="auth-screen"/);
  assert.match(html, /id="app-shell"/);
  assert.match(html, /class="handle-input"/);
  assert.match(html, /id="settings-view"/);
  assert.match(html, /id="verify-card"/);
  assert.match(html, /BankTest/);
  assert.match(html, /id="favorite-form"/);

  const script = await fetch(`${origin}/app.js`);
  assert.equal(script.status, 200);
  const themeScript = await fetch(`${origin}/theme.js`);
  assert.equal(themeScript.status, 200);
  const style = await fetch(`${origin}/styles.css`);
  assert.equal(style.status, 200);
});

async function request(route: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${origin}${route}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const body = response.status === 204 ? null : await response.json() as any;
  return { response, body };
}

async function registerAndVerify(input: { name: string; username: string; email: string; password: string }) {
  const started = await request("/api/auth/register", { method: "POST", body: JSON.stringify(input) });
  assert.equal(started.response.status, 202);
  const email = input.email.toLowerCase();
  const code = sentCodes.get(email);
  assert.match(code ?? "", /^\d{6}$/);
  return request("/api/auth/verify", { method: "POST", body: JSON.stringify({ email, code }) });
}
