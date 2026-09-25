const $ = (selector) => document.querySelector(selector);
const money = (cents) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
const state = { user: null, entries: [], favorites: [], view: "home", balanceVisible: true, authMode: "login", pendingEmail: null };
let toastTimer;
let resendTimer;

function setAuthMode(mode) {
  state.authMode = mode;
  const registration = mode === "register";
  const legacy = mode === "legacy-login";
  $("#name-field").classList.toggle("hidden", !registration);
  $("#email-field").classList.toggle("hidden", !registration && !legacy);
  $("#username-field").classList.toggle("hidden", legacy);
  $("#name-field input").required = registration;
  $("#email-field input").required = registration || legacy;
  $("#username-field input").required = !legacy;
  $("#auth-form [name=password]").autocomplete = registration ? "new-password" : "current-password";
  $("#form-title").textContent = registration ? "Crie sua conta" : legacy ? "Acesse sua conta antiga" : "Acesse sua conta";
  $("#form-subtitle").textContent = registration ? "Escolha seu @usuário e comece agora." : legacy ? "Entre com seu e-mail e escolha um @usuário." : "Entre com seu @usuário para continuar.";
  $("#submit-button").innerHTML = `${registration ? "Criar minha conta" : "Entrar na conta"} <span aria-hidden="true">→</span>`;
  $("#legacy-toggle").textContent = legacy ? "Voltar para entrar com @usuário" : "Tenho uma conta antiga sem @usuário";
  $("#legacy-toggle").classList.toggle("hidden", registration);
  $("#message").textContent = "";
  $("#continue-verification").classList.toggle("hidden", !state.pendingEmail);
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.mode === (registration ? "register" : "login");
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.mode)));
$("#legacy-toggle").addEventListener("click", () => setAuthMode(state.authMode === "legacy-login" ? "login" : "legacy-login"));
$("#continue-verification").addEventListener("click", () => showVerification(state.pendingEmail));
$("#back-to-register").addEventListener("click", () => {
  $("#verify-card").classList.add("hidden");
  $("#auth-card").classList.remove("hidden");
  setAuthMode("register");
});
$("#verify-code").addEventListener("input", (event) => {
  event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "").slice(0, 6);
});

// O @ é parte fixa do campo; colagens com @ continuam funcionando.
document.querySelectorAll(".handle-input input").forEach((input) => input.addEventListener("input", () => {
  if (input.value.startsWith("@")) input.value = input.value.replace(/^@+/, "");
}));

const transferAmountInput = $("#transfer-form [name=amount]");
transferAmountInput.addEventListener("input", () => {
  transferAmountInput.value = formatAmountFromDigits(transferAmountInput.value);
  transferAmountInput.setSelectionRange(transferAmountInput.value.length, transferAmountInput.value.length);
});
transferAmountInput.addEventListener("click", () => {
  transferAmountInput.setSelectionRange(transferAmountInput.value.length, transferAmountInput.value.length);
});

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#submit-button");
  const message = $("#message");
  message.textContent = "";
  button.disabled = true;
  try {
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const payload = state.authMode === "register"
      ? { name: fields.name, username: fields.username, email: fields.email, password: fields.password }
      : state.authMode === "legacy-login"
        ? { email: fields.email, password: fields.password }
        : { username: fields.username, password: fields.password };
    const result = await api(`/api/auth/${state.authMode}`, { method: "POST", body: JSON.stringify(payload) });
    if (state.authMode === "register") {
      $("#auth-form [name=password]").value = "";
      showVerification(result.email, true);
    } else {
      await finishAuthentication(result);
    }
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#verify-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  const message = $("#verify-message");
  button.disabled = true;
  message.textContent = "";
  message.classList.remove("success");
  try {
    const code = $("#verify-code").value;
    const result = await api("/api/auth/verify", {
      method: "POST", body: JSON.stringify({ email: state.pendingEmail, code }),
    });
    state.pendingEmail = null;
    try { sessionStorage.removeItem("bank_pending_email"); } catch {}
    $("#verify-form").reset();
    await finishAuthentication(result);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#resend-code").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  $("#verify-message").textContent = "";
  try {
    await api("/api/auth/resend-code", {
      method: "POST", body: JSON.stringify({ email: state.pendingEmail }),
    });
    $("#verify-code").value = "";
    $("#verify-message").textContent = "Novo código enviado. Confira sua caixa de entrada.";
    $("#verify-message").classList.add("success");
    startResendCooldown();
  } catch (error) {
    $("#verify-message").classList.remove("success");
    $("#verify-message").textContent = error.message;
    button.disabled = false;
  }
});

function showVerification(email, startCooldown = false) {
  state.pendingEmail = email;
  try { sessionStorage.setItem("bank_pending_email", email); } catch {}
  $("#verify-email").textContent = email;
  $("#verify-code").value = "";
  $("#verify-message").textContent = "";
  $("#verify-message").classList.remove("success");
  $("#auth-card").classList.add("hidden");
  $("#verify-card").classList.remove("hidden");
  if (startCooldown) startResendCooldown();
  $("#verify-code").focus();
}

function startResendCooldown() {
  const button = $("#resend-code");
  const until = Date.now() + 60_000;
  clearInterval(resendTimer);
  button.disabled = true;
  const update = () => {
    const remaining = Math.ceil((until - Date.now()) / 1000);
    button.textContent = remaining > 0 ? `Reenviar em ${remaining}s` : "Reenviar código";
    button.disabled = remaining > 0;
    if (remaining <= 0) clearInterval(resendTimer);
  };
  resendTimer = setInterval(update, 1000);
  update();
}

async function finishAuthentication(result) {
  clearInterval(resendTimer);
  $("#resend-code").textContent = "Reenviar código";
  $("#resend-code").disabled = false;
  localStorage.setItem("bank_token", result.token);
  state.pendingEmail = null;
  try { sessionStorage.removeItem("bank_pending_email"); } catch {}
  state.entries = [];
  state.favorites = [];
  renderContacts();
  state.view = "home";
  $("#search-input").value = "";
  resetSettingsForms();
  setUser(result.user);
  try { await loadStatement(); } catch { notify("Não foi possível carregar o extrato agora.", true); }
  try { await loadFavorites(); } catch { notify("Não foi possível carregar as amizades agora.", true); }
}

$("#favorite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const message = $("#favorite-message");
  message.textContent = "";
  message.classList.remove("success");
  button.disabled = true;
  try {
    const username = new FormData(form).get("username");
    await api("/api/favorites", { method: "POST", body: JSON.stringify({ username }) });
    form.reset();
    await loadFavorites();
    message.textContent = "Contato adicionado às suas amizades.";
    message.classList.add("success");
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#username-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const username = new FormData(event.currentTarget).get("username");
    const result = await api("/api/account/username", { method: "POST", body: JSON.stringify({ username }) });
    setUser(result.user);
    notify(`Seu identificador agora é @${result.user.username}.`);
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#demo-credit").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api("/api/account/demo-credit", { method: "POST" });
    setUser(result.user);
    await loadStatement();
    notify("R$ 1.000,00 de teste adicionados à sua conta.");
  } catch (error) {
    notify(error.message, true);
    button.disabled = false;
  }
});

$("#transfer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  const message = $("#transfer-message");
  message.textContent = "";
  button.disabled = true;
  try {
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const amountCents = parseReais(fields.amount);
    const result = await api("/api/transfers", {
      method: "POST",
      body: JSON.stringify({ recipientUsername: fields.recipientUsername, amountCents }),
    });
    setUser(result.user);
    await loadStatement();
    closeTransfer();
    event.currentTarget.reset();
    notify(`${money(amountCents)} enviados para ${result.transfer.to}.`);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#quick-transfer").addEventListener("click", () => openTransfer());
$("#new-transfer").addEventListener("click", () => openTransfer());
$("#close-transfer").addEventListener("click", closeTransfer);
$("#transfer-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeTransfer(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeTransfer(); });
$("#quick-statement").addEventListener("click", () => showView("transactions"));
$("#see-all").addEventListener("click", () => showView("transactions"));
document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", () => showView(link.dataset.view)));
document.querySelectorAll(".theme-option").forEach((option) => option.addEventListener("click", () => applyTheme(option.dataset.theme)));
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark", false);

$("#settings-email-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const message = $("#settings-email-message");
  message.textContent = "";
  message.classList.remove("success");
  button.disabled = true;
  try {
    const fields = Object.fromEntries(new FormData(form));
    const result = await api("/api/account/email", {
      method: "PATCH",
      body: JSON.stringify({ email: fields.email, currentPassword: fields.currentPassword }),
    });
    setUser(result.user);
    form.querySelector("[name=currentPassword]").value = "";
    message.textContent = "E-mail atualizado com sucesso.";
    message.classList.add("success");
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#settings-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const message = $("#settings-password-message");
  message.textContent = "";
  message.classList.remove("success");
  button.disabled = true;
  try {
    const fields = Object.fromEntries(new FormData(form));
    if (fields.newPassword !== fields.confirmPassword) throw new Error("A confirmação não corresponde à nova senha.");
    const result = await api("/api/account/password", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword: fields.currentPassword, newPassword: fields.newPassword }),
    });
    form.reset();
    message.textContent = result.message;
    message.classList.add("success");
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#search-input").addEventListener("input", (event) => {
  if (event.target.value.trim()) showView("transactions");
  renderMovements();
});
$("#toggle-balance").addEventListener("click", () => {
  state.balanceVisible = !state.balanceVisible;
  renderBalance();
  $("#toggle-balance").setAttribute("aria-label", state.balanceVisible ? "Ocultar saldo" : "Mostrar saldo");
});
$("#copy-handle").addEventListener("click", async () => {
  if (!state.user?.username) return notify("Escolha seu @usuário primeiro.", true);
  try {
    await navigator.clipboard.writeText(`@${state.user.username}`);
    notify("@usuário copiado.");
  } catch {
    notify("Não foi possível copiar. Seu usuário aparece no menu lateral.", true);
  }
});
$("#logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  localStorage.removeItem("bank_token");
  state.user = null;
  state.entries = [];
  state.favorites = [];
  renderContacts();
  $("#search-input").value = "";
  $("#demo-credit").disabled = false;
  resetSettingsForms();
  $("#app-shell").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  $("#auth-form").reset();
  setAuthMode("login");
});

function openTransfer(username = "") {
  if (!state.user?.username) return notify("Escolha seu @usuário para fazer transferências.", true);
  $("#transfer-form").reset();
  $("#transfer-message").textContent = "";
  $("#transfer-form [name=recipientUsername]").value = username;
  $("#transfer-dialog").classList.remove("hidden");
  $("#transfer-form [name=recipientUsername]").focus();
}

function closeTransfer() { $("#transfer-dialog").classList.add("hidden"); }

function showView(view) {
  state.view = view;
  $("#home-view").classList.toggle("hidden", view !== "home");
  $("#transactions-view").classList.toggle("hidden", view !== "transactions");
  $("#settings-view").classList.toggle("hidden", view !== "settings");
  $("#search-box").classList.toggle("hidden", view === "settings");
  $("#welcome").textContent = view === "settings" ? "Configurações" : view === "transactions" ? "Transações" : `Olá, ${state.user.name.split(" ")[0]}`;
  $("#topbar-subtitle").textContent = view === "settings" ? "Gerencie seus dados de acesso e a aparência do site." : view === "transactions" ? "Confira as movimentações da sua conta." : "Bem-vindo de volta! Aqui está o resumo das suas finanças.";
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === view));
}

function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#f2f6fa" : "#0d1118";
  document.querySelectorAll(".theme-option").forEach((option) => {
    option.setAttribute("aria-pressed", String(option.dataset.theme === theme));
  });
  if (persist) {
    try { localStorage.setItem("bank_theme", theme); } catch {}
  }
  renderChart();
}

function resetSettingsForms() {
  $("#settings-email-form").reset();
  $("#settings-password-form").reset();
  $("#settings-email-message").textContent = "";
  $("#settings-password-message").textContent = "";
}

function setUser(user) {
  state.user = user;
  $("#auth-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  $("#welcome").textContent = `Olá, ${user.name.split(" ")[0]}`;
  $("#sidebar-name").textContent = user.name;
  $("#sidebar-handle").textContent = user.username ? `@${user.username}` : "Definir @usuário";
  $("#sidebar-avatar").textContent = initials(user.name);
  $("#settings-email-form [name=email]").value = user.email;
  $("#legacy-username-card").classList.toggle("hidden", Boolean(user.username));
  $("#quick-transfer").disabled = !user.username;
  $("#copy-handle").disabled = !user.username;
  renderBalance();
  showView(state.view);
}

function renderBalance() {
  $("#balance").textContent = state.balanceVisible ? money(state.user.balanceCents) : "R$ ••••••";
}

async function loadStatement() {
  const result = await api("/api/statement");
  state.entries = result.entries;
  $("#demo-credit").disabled = state.entries.some((entry) => entry.type === "demo_credit");
  renderMovements();
  renderChart();
}

async function loadFavorites() {
  const result = await api("/api/favorites");
  state.favorites = result.contacts;
  renderContacts();
}

function renderMovements() {
  const query = $("#search-input").value.trim().toLowerCase();
  const filtered = state.entries.filter((entry) =>
    !query || (entry.counterpartyUsername || "").toLowerCase().includes(query.replace(/^@/, "")) ||
    (entry.counterpartyName || "").toLowerCase().includes(query) ||
    (entry.type === "demo_credit" && "saldo de teste".includes(query))
  );
  fillMovements($("#recent-list"), filtered.slice(0, 4));
  fillMovements($("#statement-list"), filtered);
  $("#recent-empty").classList.toggle("hidden", filtered.length > 0);
  $("#statement-empty").classList.toggle("hidden", filtered.length > 0);
}

function fillMovements(container, entries) {
  container.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "movement";
    const icon = document.createElement("span");
    icon.className = `movement-icon${entry.amountCents < 0 ? " out" : ""}`;
    icon.textContent = entry.amountCents < 0 ? "↗" : "↙";
    const detail = document.createElement("span");
    detail.className = "movement-info";
    const title = document.createElement("strong");
    title.textContent = entry.type === "demo_credit" ? "Saldo de teste" :
      `${entry.amountCents < 0 ? "Para" : "De"} @${entry.counterpartyUsername}`;
    const sub = document.createElement("small");
    const date = new Date(`${entry.createdAt.replace(" ", "T")}Z`);
    sub.textContent = `${entry.type === "demo_credit" ? "Crédito de demonstração" : entry.counterpartyName} · ${date.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    detail.append(title, sub);
    const amount = document.createElement("strong");
    amount.className = `movement-amount${entry.amountCents > 0 ? " in" : ""}`;
    amount.textContent = `${entry.amountCents > 0 ? "+" : "−"} ${money(Math.abs(entry.amountCents))}`;
    row.append(icon, detail, amount);
    container.append(row);
  }
}

function renderContacts() {
  const container = $("#contacts-list");
  container.replaceChildren();
  $("#contacts-empty").classList.toggle("hidden", state.favorites.length > 0);
  let index = 0;
  for (const contact of state.favorites) {
    const row = document.createElement("div"); row.className = "contact";
    const avatar = document.createElement("span"); avatar.className = "avatar"; avatar.textContent = initials(contact.name);
    avatar.style.background = ["#37d9f4", "#28d5a0", "#b28aff", "#ffc35a", "#ff8aaf"][index++ % 5];
    const info = document.createElement("span"); info.className = "contact-info";
    const name = document.createElement("strong"); name.textContent = contact.name;
    const handle = document.createElement("small"); handle.textContent = `@${contact.username}`;
    info.append(name, handle);
    const actions = document.createElement("span"); actions.className = "contact-actions";
    const transfer = document.createElement("button"); transfer.type = "button"; transfer.textContent = "Transferir ↗";
    transfer.addEventListener("click", () => openTransfer(contact.username));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-favorite";
    remove.textContent = "×"; remove.title = `Remover @${contact.username} dos favoritos`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await api("/api/favorites", { method: "DELETE", body: JSON.stringify({ username: contact.username }) });
        await loadFavorites();
        notify(`@${contact.username} removido das amizades.`);
      } catch (error) {
        notify(error.message, true);
        remove.disabled = false;
      }
    });
    actions.append(transfer, remove);
    row.append(avatar, info, actions); container.append(row);
  }
}

function renderChart() {
  const svg = $("#activity-chart");
  svg.replaceChildren();
  const themeStyles = getComputedStyle(document.documentElement);
  const gridColor = themeStyles.getPropertyValue("--chart-grid").trim();
  const incomingColor = themeStyles.getPropertyValue("--green").trim();
  const outgoingColor = themeStyles.getPropertyValue("--cyan").trim();
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, index) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + index, 1)));
  const keys = months.map((date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  const incoming = Array(6).fill(0);
  const outgoing = Array(6).fill(0);
  for (const entry of state.entries) {
    const index = keys.indexOf(entry.createdAt.slice(0, 7));
    if (index >= 0) (entry.amountCents >= 0 ? incoming : outgoing)[index] += Math.abs(entry.amountCents);
  }
  const max = Math.max(...incoming, ...outgoing, 1);
  const ns = "http://www.w3.org/2000/svg";
  for (const y of [25, 70, 115, 160]) {
    const grid = document.createElementNS(ns, "line");
    for (const [key, value] of Object.entries({ x1: 20, x2: 580, y1: y, y2: y, stroke: gridColor, "stroke-width": 1 })) grid.setAttribute(key, value);
    svg.append(grid);
  }
  for (const [values, color] of [[incoming, incomingColor], [outgoing, outgoingColor]]) {
    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", values.map((value, i) => `${20 + i * 112},${160 - (value / max) * 130}`).join(" "));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "2.5");
    line.setAttribute("fill", "none");
    svg.append(line);
  }
  $("#chart-labels").replaceChildren(...months.map((date) => {
    const label = document.createElement("span");
    label.textContent = date.toLocaleString("pt-BR", { month: "short", timeZone: "UTC" }).replace(".", "");
    return label;
  }));
}

function initials(name) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }

function parseReais(input) {
  const amountCents = Number(input.replace(/\D/g, ""));
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 10_000_000) {
    throw new Error("Informe um valor entre R$ 0,01 e R$ 100.000,00.");
  }
  return amountCents;
}

function formatAmountFromDigits(value) {
  const digits = value.replace(/\D/g, "").replace(/^0+(?=\d)/, "").padStart(3, "0");
  const reais = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${reais},${digits.slice(-2)}`;
}

function notify(text, error = false) {
  const toast = $("#toast");
  toast.textContent = text;
  toast.classList.toggle("error", error);
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4500);
}

async function api(url, options = {}) {
  const token = localStorage.getItem("bank_token");
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Não foi possível concluir a operação.");
  return body;
}

(async () => {
  try { state.pendingEmail = sessionStorage.getItem("bank_pending_email"); } catch {}
  if (!localStorage.getItem("bank_token")) {
    if (state.pendingEmail) showVerification(state.pendingEmail);
    return;
  }
  try {
    const result = await api("/api/auth/me");
    setUser(result.user);
    await loadStatement();
    await loadFavorites();
  } catch {
    localStorage.removeItem("bank_token");
    $("#app-shell").classList.add("hidden");
    $("#auth-screen").classList.remove("hidden");
    if (state.pendingEmail) showVerification(state.pendingEmail);
  }
})();
