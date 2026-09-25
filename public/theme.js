try {
  if (localStorage.getItem("bank_theme") === "light") {
    document.documentElement.dataset.theme = "light";
    document.querySelector('meta[name="theme-color"]').content = "#f2f6fa";
  }
} catch {
  // O tema escuro continua disponível quando o armazenamento está bloqueado.
}
