/* global document, Element, HTMLElement, IntersectionObserver, navigator, window */

const root = document.documentElement;
const themeToggle = document.querySelector("[data-theme-toggle]");
const themeLabel = document.querySelector("[data-theme-label]");
const themeColor = document.querySelector('meta[name="theme-color"]');
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

function storedTheme() {
  try {
    return window.localStorage.getItem("ghosttea-theme");
  } catch {
    return null;
  }
}

function resolvedTheme() {
  return root.dataset.theme ?? (systemTheme.matches ? "dark" : "light");
}

function syncThemeControl() {
  const dark = resolvedTheme() === "dark";
  if (themeToggle) {
    themeToggle.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} mode`);
    themeToggle.setAttribute("aria-pressed", String(dark));
  }
  if (themeLabel) themeLabel.textContent = dark ? "Light" : "Dark";
  if (themeColor) themeColor.setAttribute("content", dark ? "#0a0a0a" : "#fafaf7");
}

const savedTheme = storedTheme();
if (savedTheme === "light" || savedTheme === "dark") root.dataset.theme = savedTheme;
syncThemeControl();

themeToggle?.addEventListener("click", () => {
  const next = resolvedTheme() === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try {
    window.localStorage.setItem("ghosttea-theme", next);
  } catch {
    // The selected theme still applies for this page view.
  }
  syncThemeControl();
});

systemTheme.addEventListener("change", () => {
  if (!storedTheme()) syncThemeControl();
});

const navToggle = document.querySelector("[data-nav-toggle]");
const navLinks = document.querySelector("[data-nav-links]");

function closeNavigation() {
  document.body.classList.remove("nav-open");
  navToggle?.setAttribute("aria-expanded", "false");
  navToggle?.setAttribute("aria-label", "Open navigation");
}

if (navToggle && navLinks) {
  navToggle.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  });

  navLinks.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("a")) return;
    closeNavigation();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeNavigation();
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const selector = button.getAttribute("data-copy");
    const source = selector ? document.querySelector(selector) : null;
    const text = button.getAttribute("data-copy-text") ?? source?.textContent?.trim();
    if (!text) return;

    const previous = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select";
      if (source instanceof HTMLElement) {
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }

    window.setTimeout(() => {
      button.textContent = previous;
    }, 1400);
  });
}

for (const year of document.querySelectorAll("[data-year]")) {
  year.textContent = String(new Date().getFullYear());
}

const sidebarLinks = [...document.querySelectorAll(".docs-sidebar a[href^='#']")];
const trackedSections = sidebarLinks
  .map((link) => {
    const target = document.querySelector(link.getAttribute("href"));
    return target instanceof HTMLElement ? { link, target } : null;
  })
  .filter(Boolean);

if (trackedSections.length > 0 && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
      if (!visible) return;
      for (const item of trackedSections) {
        item.link.classList.toggle("is-active", item.target === visible.target);
      }
    },
    { rootMargin: "-18% 0px -72% 0px", threshold: [0, 0.25] },
  );
  for (const item of trackedSections) observer.observe(item.target);
}
