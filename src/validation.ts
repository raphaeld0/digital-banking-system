export interface Credentials {
  username: string;
  password: string;
}

export interface Registration extends Credentials {
  name: string;
  email: string;
}

export interface LegacyCredentials {
  email: string;
  password: string;
}

export interface TransferInput {
  recipientUsername: string;
  amountCents: number;
}

export interface EmailChange {
  email: string;
  currentPassword: string;
}

export interface PasswordChange {
  currentPassword: string;
  newPassword: string;
}

export interface VerificationInput {
  email: string;
  code: string;
}

export function validateRegistration(value: unknown): Registration {
  const body = asObject(value);
  const name = requiredString(body.name, "nome").replace(/\s+/g, " ").trim();
  const email = normalizeEmail(requiredString(body.email, "e-mail"));
  const password = requiredString(body.password, "senha");
  const username = validateUsername(body.username);

  if (name.length < 2 || name.length > 100) throw new ValidationError("O nome deve ter entre 2 e 100 caracteres.");
  validateEmail(email);
  validatePassword(password);
  return { name, email, password, username };
}

export function validateUsername(value: unknown): string {
  const raw = requiredString(value, "@usuário").trim().toLowerCase();
  const username = raw.startsWith("@") ? raw.slice(1) : raw;
  if (!/^[a-z][a-z0-9_]{2,23}$/.test(username)) {
    throw new ValidationError("O @usuário deve ter de 3 a 24 caracteres, começar com letra e usar apenas letras, números ou _.");
  }
  return username;
}

export function validateTransfer(value: unknown): TransferInput {
  const body = asObject(value);
  const recipientUsername = validateUsername(body.recipientUsername);
  const amountCents = body.amountCents;
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 10_000_000) {
    throw new ValidationError("Informe um valor entre R$ 0,01 e R$ 100.000,00.");
  }
  return { recipientUsername, amountCents };
}

export function validateCredentials(value: unknown): Credentials {
  const body = asObject(value);
  const username = validateUsername(body.username);
  const password = requiredString(body.password, "senha");
  if (password.length > 128) throw new ValidationError("Credenciais inválidas.");
  return { username, password };
}

export function validateLegacyCredentials(value: unknown): LegacyCredentials {
  const body = asObject(value);
  const email = normalizeEmail(requiredString(body.email, "e-mail"));
  const password = requiredString(body.password, "senha");
  validateEmail(email);
  if (password.length > 128) throw new ValidationError("Credenciais inválidas.");
  return { email, password };
}

export function validateEmailChange(value: unknown): EmailChange {
  const body = asObject(value);
  const email = normalizeEmail(requiredString(body.email, "e-mail"));
  const currentPassword = requiredString(body.currentPassword, "a senha atual");
  validateEmail(email);
  if (currentPassword.length > 128) throw new ValidationError("Senha atual inválida.");
  return { email, currentPassword };
}

export function validatePasswordChange(value: unknown): PasswordChange {
  const body = asObject(value);
  const currentPassword = requiredString(body.currentPassword, "a senha atual");
  const newPassword = requiredString(body.newPassword, "a nova senha");
  if (currentPassword.length > 128) throw new ValidationError("Senha atual inválida.");
  validatePassword(newPassword);
  if (newPassword === currentPassword) throw new ValidationError("A nova senha deve ser diferente da atual.");
  return { currentPassword, newPassword };
}

export function validateVerification(value: unknown): VerificationInput {
  const body = asObject(value);
  const email = normalizeEmail(requiredString(body.email, "e-mail"));
  const code = requiredString(body.code, "o código").trim();
  validateEmail(email);
  if (!/^\d{6}$/.test(code)) throw new ValidationError("O código deve ter 6 dígitos.");
  return { email, code };
}

export function validateResendRequest(value: unknown): string {
  const body = asObject(value);
  const email = normalizeEmail(requiredString(body.email, "e-mail"));
  validateEmail(email);
  return email;
}

export class ValidationError extends Error {}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Envie um objeto JSON válido.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`Informe ${field}.`);
  return value;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateEmail(email: string): void {
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError("Informe um e-mail válido.");
  }
}

function validatePassword(password: string): void {
  if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new ValidationError("A senha deve ter de 8 a 128 caracteres, com ao menos uma letra e um número.");
  }
}
