/** @type implementation @purpose Share persistent appearance preferences across operator and assignment workspaces. */
(() => {
  const key = "vse-appearance", system = matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  try { preference = localStorage.getItem(key) || "system"; } catch { /* Storage may be unavailable in private contexts. */ }
  const valid = (value) => ["system", "light", "dark"].includes(value) ? value : "system";
  const apply = () => {
    preference = valid(preference);
    document.documentElement.dataset.theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
    document.querySelectorAll("[data-appearance]").forEach((select) => { select.value = preference; });
  };
  apply();
  system.addEventListener("change", apply);
  addEventListener("storage", (event) => { if (event.key === key || event.key === null) { preference = event.newValue || "system"; apply(); } });
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.querySelectorAll("[data-appearance]").forEach((select) => select.addEventListener("change", () => {
      preference = valid(select.value);
      try { localStorage.setItem(key, preference); } catch { /* Keep the preference for this page when storage is disabled. */ }
      apply();
    }));
  });
})();
