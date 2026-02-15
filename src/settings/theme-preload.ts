const THEME_CACHE_KEY = "focusdeck:settings-theme-mode";

(() => {
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY);
    if (cached === "dark" || cached === "light") {
      document.documentElement.setAttribute("data-fd-theme", cached);
    } else {
      document.documentElement.removeAttribute("data-fd-theme");
    }
  } catch {
    document.documentElement.removeAttribute("data-fd-theme");
  }
})();
