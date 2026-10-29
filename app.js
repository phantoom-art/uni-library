"use strict";

/* ───────── Config ───────── */
const DATA_URL = "./unipdfs.json";
// Paste your Cloudflare Worker URL here to list the R2 bucket automatically, to keep uploading more pdfs
const API_URL = "";
const FAV_KEY = "s3-favorites";

const VALID_TYPES = new Set(["cours", "td", "tp", "exam"]);
const TYPE_LABELS = { cours: "Course", td: "Tutorial", tp: "Practical", exam: "Exam" };
const TYPE_SHORT = { cours: "CRS", td: "TD", tp: "TP", exam: "EXM" };
// Modules: add a "module" field to each entry in unipdfs.json (e.g. "algo", "archi", "asd").
// Unknown names still work — they just get a capitalised label.
const MODULE_LABELS = { algo: "Algorithm", archi: "Architecture", asd: "ASD", other: "Other" };
const MODULE_ORDER = ["algo", "archi", "asd"];
const MAX_RESULTS = 60;

const ICONS = {
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.8l-5.6 2.9 1.1-6.2L3 10.1l6.2-.9z"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
};

const notice = document.querySelector("#notice");
const searchInput = document.querySelector("#search-input");
const searchClear = document.querySelector("#search-clear");
const searchWrap = document.querySelector(".search-wrap");
const panel = document.querySelector("#search-panel");
const resultsEl = document.querySelector("#results");
const resultsCount = document.querySelector("#results-count");
const themeToggle = document.querySelector("#theme-toggle");
const moduleBar = document.querySelector("#module-filters");
const filterButtons = [...document.querySelectorAll("#type-filters .chip")];
const navLinks = [...document.querySelectorAll(".nav-link")];

let documents = [];
let visibleDocs = [];
let activeType = "all";   // all | fav | cours | td | tp | exam
let activeModule = "all"; // all | algo | archi | asd | etc
let items = [];
let activeIndex = -1;
let isOpen = false;
let closeTimer = 0;
let animateNext = false;
let renderQueued = false;
let themeSwitching = false;
let downloadViaFetch = true;
let favorites = loadFavorites();

/* ───────── Favorites (localStorage) ───────── */
function loadFavorites() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
  } catch (e) {
    return new Set();
  }
}

function saveFavorites() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch (e) {}
}

function setFavState(button, item) {
  const on = favorites.has(item.filename);
  button.classList.toggle("is-fav", on);
  button.setAttribute("aria-pressed", String(on));
  button.setAttribute("aria-label", `${on ? "Remove from" : "Add to"} favorites: ${item.title}`);
  button.title = on ? "Remove from favorites" : "Add to favorites";
}

function toggleFavorite(item, button) {
  const added = !favorites.has(item.filename);
  if (added) favorites.add(item.filename);
  else favorites.delete(item.filename);
  saveFavorites();
  if (button) {
    setFavState(button, item);
    if (added) {
      button.classList.remove("pop");
      void button.offsetWidth;
      button.classList.add("pop");
      button.addEventListener("animationend", () => button.classList.remove("pop"), { once: true });
    }
  }
  updateFilterCounts();
  if (activeType === "fav") render({ keepScroll: true }); // the unstarred row leaves the list
}

// keep several open tabs in sync
window.addEventListener("storage", (event) => {
  if (event.key !== FAV_KEY) return;
  favorites = loadFavorites();
  updateFilterCounts();
  if (isOpen) render({ keepScroll: true });
});

/* ───────── Helpers ───────── */
function normalize(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function isDocument(item) {
  return item && typeof item.title === "string" && typeof item.filename === "string" && VALID_TYPES.has(item.type);
}

function getDocumentUrl(documentItem) {
  return `https://pub-1a2a4cddc8a046ad9c3f49516d55aa88.r2.dev/${encodeURI(documentItem.filename)}`;
}

function moduleLabel(module) {
  return MODULE_LABELS[module] || module.charAt(0).toUpperCase() + module.slice(1);
}

// use the "module" field when present; otherwise guess it from the title / file name
function guessModule(item) {
  if (typeof item.module === "string" && item.module.trim()) return item.module.trim().toLowerCase();
  const text = normalize(`${item.title} ${item.filename}`);
  if (/archi/.test(text)) return "archi";
  if (/(^|[^a-z])asd([^a-z]|$)/.test(text)) return "asd";
  if (/algo/.test(text)) return "algo";
  return "other";
}

function prepare(item) {
  const module = guessModule(item);
  return { ...item, module, _hay: normalize(`${item.title} ${item.filename} ${moduleLabel(module)}`) };
}

function getTokens(query) {
  return normalize(query.trim()).split(/\s+/).filter(Boolean);
}

function getMatchingDocuments(tokens) {
  return documents.filter((item) => {
    if (activeType === "fav") {
      if (!favorites.has(item.filename)) return false;
    } else if (activeType !== "all" && item.type !== activeType) {
      return false;
    }
    if (activeModule !== "all" && item.module !== activeModule) return false;
    if (!tokens.length) return true;
    return tokens.every((token) => item._hay.includes(token));
  });
}

/* Highlight matches while keeping the original text (accent-safe). */
function highlight(text, tokens) {
  const frag = document.createDocumentFragment();
  if (!tokens.length) {
    frag.append(text);
    return frag;
  }

  let normalized = "";
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const piece = normalize(text[i]);
    for (let k = 0; k < piece.length; k++) map.push(i);
    normalized += piece;
  }

  const marked = new Array(text.length).fill(false);
  for (const token of tokens) {
    let from = 0;
    let at;
    while ((at = normalized.indexOf(token, from)) !== -1) {
      for (let k = at; k < at + token.length; k++) marked[map[k]] = true;
      from = at + token.length;
    }
  }

  let buffer = "";
  let current = false;
  const flush = () => {
    if (!buffer) return;
    if (current) {
      const mark = document.createElement("mark");
      mark.textContent = buffer;
      frag.append(mark);
    } else {
      frag.append(buffer);
    }
    buffer = "";
  };
  for (let i = 0; i < text.length; i++) {
    if (marked[i] !== current) { flush(); current = marked[i]; }
    buffer += text[i];
  }
  flush();
  return frag;
}

/* ───────── Rendering ───────── */
function createResult(item, index, tokens) {
  const url = getDocumentUrl(item);

  const row = document.createElement("div");
  row.className = "result";
  row.id = `result-${index}`;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.style.setProperty("--i", Math.min(index, 8));
  row.dataset.index = index;

  // the main area opens the PDF in a new tab
  const main = document.createElement("a");
  main.className = "result-main";
  main.href = url;
  main.target = "_blank";
  main.rel = "noopener noreferrer";

  const icon = document.createElement("span");
  icon.className = `result-icon type-${item.type}`;
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = TYPE_SHORT[item.type];

  const body = document.createElement("span");
  body.className = "result-body";
  const title = document.createElement("span");
  title.className = "result-title";
  title.append(highlight(item.title, tokens));
  const file = document.createElement("span");
  file.className = "result-file";
  file.append(highlight(item.filename, tokens));
  body.append(title, file);

  const tag = document.createElement("span");
  tag.className = "result-tag";
  tag.textContent = TYPE_LABELS[item.type];

  main.append(icon, body, tag);

  // actions: ☆ star · ↓ download · ↗ open
  const actions = document.createElement("div");
  actions.className = "result-actions";

  const fav = document.createElement("button");
  fav.type = "button";
  fav.className = "result-action fav";
  fav.dataset.action = "fav";
  fav.innerHTML = ICONS.star;
  setFavState(fav, item);

  const dl = document.createElement("a");
  dl.className = "result-action dl";
  dl.dataset.action = "download";
  dl.href = url;
  dl.setAttribute("download", item.filename.split("/").pop());
  dl.target = "_blank";
  dl.rel = "noopener noreferrer";
  dl.title = "Download";
  dl.setAttribute("aria-label", `Download ${item.title}`);
  dl.innerHTML = ICONS.download;

  const open = document.createElement("a");
  open.className = "result-action open";
  open.href = url;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.title = "Open in new tab";
  open.setAttribute("aria-label", `Open ${item.title} in a new tab`);
  open.innerHTML = ICONS.open;

  actions.append(fav, dl, open);
  row.append(main, actions);
  return row;
}

function render({ keepScroll = false } = {}) {
  const tokens = getTokens(searchInput.value);
  const matches = getMatchingDocuments(tokens);
  const visible = matches.slice(0, MAX_RESULTS);
  visibleDocs = visible;

  const fragment = document.createDocumentFragment();
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const strong = document.createElement("strong");
    if (activeType === "fav" && favorites.size === 0) {
      strong.textContent = "No favorites yet";
      empty.append(strong, "Tap the ☆ on any document to keep it here.");
    } else {
      strong.textContent = "No documents found";
      empty.append(strong, "Try another search or choose a different category.");
    }
    fragment.append(empty);
  } else {
    visible.forEach((item, i) => fragment.append(createResult(item, i, tokens)));
  }

  // Entrance animation only when the list opens or the filter changes — not on every keystroke.
  resultsEl.classList.toggle("animate", animateNext);
  animateNext = false;
  const prevScroll = resultsEl.scrollTop;
  const prevActive = activeIndex;
  resultsEl.replaceChildren(fragment);
  resultsEl.scrollTop = keepScroll ? prevScroll : 0;
  items = [...resultsEl.querySelectorAll(".result")];
  activeIndex = -1;
  const nextActive = items.length ? (keepScroll ? Math.min(Math.max(prevActive, 0), items.length - 1) : 0) : -1;
  setActive(nextActive, false);

  const total = matches.length;
  resultsCount.textContent = `${total} ${total === 1 ? "document" : "documents"}`;
  searchWrap.classList.toggle("has-value", searchInput.value.length > 0);
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function setActive(index, scroll = true) {
  const prev = items[activeIndex];
  if (prev) {
    prev.classList.remove("is-active");
    prev.setAttribute("aria-selected", "false");
  }
  activeIndex = index;
  const current = items[index];
  if (current) {
    current.classList.add("is-active");
    current.setAttribute("aria-selected", "true");
    searchInput.setAttribute("aria-activedescendant", current.id);
    if (scroll) current.scrollIntoView({ block: "nearest" });
  } else {
    searchInput.removeAttribute("aria-activedescendant");
  }
}

function updateFilterCounts() {
  document.querySelector('[data-count="all"]').textContent = documents.length;
  document.querySelector('[data-count="fav"]').textContent = documents.filter((item) => favorites.has(item.filename)).length;
  for (const type of VALID_TYPES) {
    document.querySelector(`[data-count="${type}"]`).textContent = documents.filter((item) => item.type === type).length;
  }
}

function selectType(type) {
  activeType = type;
  for (const button of filterButtons) {
    const isActive = button.dataset.type === type;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
  for (const link of navLinks) link.classList.toggle("is-active", link.dataset.type === type);
  animateNext = true;
  render();
}

/* ───────── Module filter (built from the data) ───────── */
function syncModuleChips() {
  for (const chip of moduleBar.querySelectorAll(".chip-module")) {
    const on = chip.dataset.module === activeModule;
    chip.classList.toggle("is-active", on);
    chip.setAttribute("aria-pressed", String(on));
  }
}

function buildModuleFilters() {
  for (const chip of moduleBar.querySelectorAll(".chip-module:not([data-module='all'])")) chip.remove();

  const counts = new Map();
  for (const item of documents) counts.set(item.module, (counts.get(item.module) || 0) + 1);
  const keys = [...counts.keys()].sort((a, b) => {
    const ia = MODULE_ORDER.indexOf(a), ib = MODULE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  for (const key of keys) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip chip-module";
    chip.dataset.module = key;
    chip.setAttribute("aria-pressed", "false");
    chip.append(`${moduleLabel(key)} `);
    const count = document.createElement("span");
    count.textContent = counts.get(key);
    chip.append(count);
    moduleBar.append(chip);
  }

  moduleBar.hidden = keys.length < 2; // a module filter only makes sense with 2+ modules
  if (activeModule !== "all" && !counts.has(activeModule)) activeModule = "all";
  syncModuleChips();
}

function selectModule(module) {
  activeModule = module;
  syncModuleChips();
  animateNext = true;
  render();
}

/* ───────── Open / close popup ───────── */
function openPanel() {
  clearTimeout(closeTimer);
  if (isOpen) return;
  isOpen = true;
  panel.hidden = false;
  searchWrap.classList.remove("is-closing");
  animateNext = true;
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => searchWrap.classList.add("is-open")));
  searchInput.setAttribute("aria-expanded", "true");
}

function closePanel() {
  if (!isOpen) return;
  isOpen = false;
  searchWrap.classList.remove("is-open");
  searchWrap.classList.add("is-closing");
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
  closeTimer = setTimeout(() => {
    panel.hidden = true;
    searchWrap.classList.remove("is-closing");
  }, 240);
}

function openActive() {
  const link = items[activeIndex]?.querySelector(".result-main");
  if (link) window.open(link.href, "_blank", "noopener,noreferrer");
}

/* ───────── Download ─────────
   The <a download> link is the baseline. Browsers ignore "download" on cross-origin links,
   so we first try fetch → blob → save, which needs a CORS rule on the R2 bucket (GET).
   Without it we fall back to the normal link and open the file in a new tab.            */
async function downloadDocument(link, item) {
  const name = item.filename.split("/").pop();
  const fallback = () => {
    const a = document.createElement("a");
    a.href = link.href;
    a.download = name;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.append(a);
    a.click();
    a.remove();
  };
  if (!downloadViaFetch) return fallback();

  link.classList.add("is-busy");
  try {
    const response = await fetch(link.href, { mode: "cors" });
    if (!response.ok) throw new Error("Bad response");
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  } catch (error) {
    downloadViaFetch = false; // CORS not enabled on the bucket → use the plain link from now on
    fallback();
  } finally {
    link.classList.remove("is-busy");
  }
}

/* ───────── Theme (circular reveal from the toggle) ───────── */
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} mode`);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#0b0b0c" : "#fcfcfc";
  try { localStorage.setItem("s3-theme", theme); } catch (e) {}
}

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!document.startViewTransition || reduced) {
    setTheme(next);
    return;
  }

  const rect = themeToggle.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

  themeSwitching = true; // pause the background light so the reveal stays smooth
  const transition = document.startViewTransition(() => setTheme(next));
  transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 650, easing: "cubic-bezier(0.16, 1, 0.3, 1)", pseudoElement: "::view-transition-new(root)" }
    );
  }).catch(() => {});
  transition.finished.finally(() => { themeSwitching = false; });
});

/* ───────── Data ───────── */
async function loadDocuments() {
  try {
    const fetchList = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Network error");
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("Invalid document list");
      return data.filter(isDocument);
    };

    // unipdfs.json = optional manual titles/types/modules; the Worker = the live list from R2.
    const manual = await fetchList(DATA_URL).catch(() => []);
    const auto = API_URL ? await fetchList(API_URL).catch(() => null) : null;

    let list;
    if (auto) {
      const overrides = new Map(manual.map((item) => [item.filename, item]));
      list = auto.map((item) => overrides.get(item.filename) || item);
    } else if (manual.length) {
      list = manual;
    } else {
      throw new Error("No document list available");
    }

    documents = list.map(prepare);
    updateFilterCounts();
    buildModuleFilters();
    if (isOpen) render();
  } catch (error) {
    notice.textContent = "Could not load PDFs. Make sure unipdfs.json exists.";
    notice.hidden = false;
  }
}

/* ───────── Search events ───────── */
searchInput.addEventListener("focus", openPanel);
searchInput.addEventListener("click", openPanel);
searchInput.addEventListener("input", () => {
  if (!isOpen) openPanel();
  else scheduleRender();
});

searchInput.addEventListener("keydown", (event) => {
  const count = items.length;
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      if (!isOpen) return openPanel();
      if (count) setActive((activeIndex + 1) % count);
      break;
    case "ArrowUp":
      event.preventDefault();
      if (count) setActive((activeIndex - 1 + count) % count);
      break;
    case "Enter":
      if (isOpen && activeIndex >= 0) {
        event.preventDefault();
        const row = items[activeIndex];
        const item = visibleDocs[activeIndex];
        if (event.shiftKey) toggleFavorite(item, row.querySelector(".fav")); // ⇧↵ = star
        else if (event.ctrlKey || event.metaKey) downloadDocument(row.querySelector(".dl"), item); // ⌘/Ctrl ↵ = download
        else openActive();
      }
      break;
    case "Escape":
      if (searchInput.value) { searchInput.value = ""; render(); }
      else { closePanel(); searchInput.blur(); }
      break;
    case "Tab":
      closePanel();
      break;
  }
});

/* keep input focus while interacting with the panel */
panel.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".result") || event.target.closest(".result-action")) event.preventDefault();
});
resultsEl.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "mouse") return; // touch scrolling must not change the selection
  const el = event.target.closest(".result");
  if (el && Number(el.dataset.index) !== activeIndex) setActive(Number(el.dataset.index), false);
});

// star / download live inside the row, so stop them from also "opening" the document
resultsEl.addEventListener("click", (event) => {
  const action = event.target.closest(".result-action");
  if (!action) return;
  event.stopPropagation();
  const row = action.closest(".result");
  const item = visibleDocs[Number(row.dataset.index)];
  if (!item) return;
  if (action.dataset.action === "fav") {
    event.preventDefault();
    toggleFavorite(item, action);
  } else if (action.dataset.action === "download") {
    event.preventDefault();
    downloadDocument(action, item);
  } // the ↗ button is a plain link
});

document.addEventListener("pointerdown", (event) => {
  if (!searchWrap.contains(event.target)) closePanel();
});

for (const button of filterButtons) {
  button.addEventListener("click", () => { selectType(button.dataset.type); searchInput.focus(); });
}

moduleBar.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip-module");
  if (!chip) return;
  selectModule(chip.dataset.module);
  searchInput.focus();
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchInput.focus();
  render();
});

document.addEventListener("keydown", (event) => {
  const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || "");
  if ((event.key === "/" && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")) {
    event.preventDefault();
    searchInput.focus();
  }
});

/* ───────── Top navigation = quick type filters ───────── */
for (const link of navLinks) {
  link.addEventListener("click", () => {
    selectType(link.dataset.type);
    if (link.dataset.type === "all" && !searchInput.value) {
      closePanel();
      searchInput.blur();
    } else {
      searchInput.focus();
      openPanel();
    }
  });
}

/* ───────── Changing inspirational quotes ───────── */
const QUOTES = [
  "Every expert you admire once stared at a blank file and typed the first line.",
  "Small steps, taken daily, beat big plans left for tomorrow.",
  "Debug your doubts the same way you debug your code: one step at a time.",
  "Today's confusing chapter is next month's easy exercise.",
  "Consistency turns “I can't” into “I did.”",
  "Every bug you fix is a skill you now own.",
  "Done is better than perfect, and shipped is better than done.",
  "Study a little each day and the semester takes care of itself.",
  "Your future clients are being built by the work you do tonight.",
  "Slow progress is still progress. Keep the commits coming.",
  "Focus for twenty-five minutes. Then rest. Then do it again.",
  "The exam is just a snapshot; the skills are yours to keep.",
  "Be the student who tries one more time.",
  "Nobody writes perfect code on the first try. Write it, run it, improve it.",
  "Hard topics are just easy topics you haven't met yet.",
  "Build the habit, and motivation will follow you.",
];
const QUOTE_MS = 9000;
const quoteBox = document.querySelector("#quote");
const quoteText = document.querySelector("#quote-text");
const quoteFill = document.querySelector("#quote-fill");
let quoteOrder = [];
let quoteTimer = 0;

function nextQuoteText() {
  if (!quoteOrder.length) {
    quoteOrder = QUOTES.map((_, i) => i).sort(() => Math.random() - 0.5);
    if (quoteText.dataset.i && quoteOrder[quoteOrder.length - 1] === Number(quoteText.dataset.i)) quoteOrder.reverse();
  }
  const i = quoteOrder.pop();
  quoteText.dataset.i = i;
  return QUOTES[i];
}

function restartProgress() {
  quoteFill.style.animation = "none";
  void quoteFill.offsetWidth;
  quoteFill.style.animation = "";
}

function showQuote(animate = true) {
  clearTimeout(quoteTimer);
  const swap = () => {
    quoteText.textContent = nextQuoteText();
    quoteBox.classList.remove("is-swapping");
    restartProgress();
    quoteTimer = setTimeout(showQuote, QUOTE_MS);
  };
  if (animate) {
    quoteBox.classList.add("is-swapping");
    setTimeout(swap, 200);
  } else {
    swap();
  }
}

quoteBox.style.setProperty("--quote-time", `${QUOTE_MS}ms`);
quoteBox.addEventListener("click", () => showQuote());
showQuote(false);

/* ───────── Background: a huge library, lit by your cursor ─────────
   A static illustration of endless shelves, books, papers and PDFs is drawn once.
   It is almost invisible until you move the mouse: the cursor acts like a lamp and
   leaves a fading trail of warm light that reveals what is hiding in the shelves.
   - the scene is rendered once (and again only on resize / theme change)
   - the light trail lives on a tiny low-resolution canvas, so each frame is cheap
   - nothing is drawn while idle; the loop pauses with the search open / tab hidden
   - touch screens get a light that wanders by itself, since there is no hover         */
(() => {
  const canvas = document.querySelector("#library");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  const scene = document.createElement("canvas"); // the full library, drawn once
  const lit = document.createElement("canvas");    // library × light mask (per frame)
  const mask = document.createElement("canvas");   // soft light trail, low resolution
  const sctx = scene.getContext("2d");
  const lctx = lit.getContext("2d");
  const mctx = mask.getContext("2d");

  const MASK_SCALE = 0.25;
  const LIGHT = {
    light: { ambient: 0.05, reveal: 0.6 },
    dark: { ambient: 0.07, reveal: 0.68 },
  };
  const PALETTE = {
    light: {
      plank: "#3a3a40", shadow: "rgba(0,0,0,0.16)", hi: "rgba(255,255,255,0.4)", shade: "rgba(0,0,0,0.22)",
      label: "rgba(255,255,255,0.55)", inkSoft: "rgba(0,0,0,0.35)",
      spines: ["#2a2a30", "#44444c", "#5f5f68", "#7a7a84", "#9a9aa3", "#b9b9c1", "#6b7fa8", "#a88b6b", "#6b9a7c", "#9c7aa8"],
      paper: "#ffffff", edge: "#a9a9b3", fold: "#dcdce2", line: "#c4c4cc", ink: "#7d7d88", pdf: "#c0504d",
    },
    dark: {
      plank: "#c9c9d2", shadow: "rgba(0,0,0,0.4)", hi: "rgba(255,255,255,0.26)", shade: "rgba(0,0,0,0.3)",
      label: "rgba(255,255,255,0.3)", inkSoft: "rgba(0,0,0,0.45)",
      spines: ["#e4e4ea", "#c2c2cc", "#a0a0ac", "#80808c", "#60606c", "#454550", "#8da2cf", "#cfae8d", "#8dc4a0", "#bf9dcc"],
      paper: "#ececf1", edge: "#8a8a95", fold: "#b7b7c2", line: "#b4b4be", ink: "#8d8d99", pdf: "#e0645f",
    },
  };

  let w = 0, h = 0, ds = 1, R = 160, phone = false, dark = false;
  let tx = -9999, ty = -9999;        // where the pointer is
  let sx = -9999, sy = -9999;        // the smoothed light position
  let lastInput = -1e9, live = 0, cleared = true, last = 0, raf = 0, resizeTimer = 0;
  let ang = 0, stretch = 1, lobe = 0; // direction + stretch of the light, and a slow drift for its soft, uneven edges

  function mulberry(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ----- the library illustration ----- */
  function drawScene() {
    const P = dark ? PALETTE.dark : PALETTE.light;
    const g = sctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, scene.width, scene.height);
    g.setTransform(ds, 0, 0, ds, 0, 0);

    const rand = mulberry(20261029);
    const r = (a, b) => a + rand() * (b - a);
    const pick = (arr) => arr[(rand() * arr.length) | 0];

    const u = Math.max(90, Math.min(150, h / 6.5)); // shelf height
    const k = u / 120;                               // global scale for everything on the shelves
    const rows = Math.ceil(h / u);
    const y0 = (h - rows * u) / 2;
    const section = Math.max(240, w / 4);

    // shelves full of books
    for (let row = 0; row < rows; row++) {
      const baseY = y0 + (row + 1) * u;
      g.fillStyle = P.plank; g.fillRect(0, baseY - 3, w, 5);
      g.fillStyle = P.shadow; g.fillRect(0, baseY + 2, w, 3);

      let x = 4 + r(0, 10);
      let nextPost = section * (0.4 + r(0, 0.3));
      while (x < w) {
        if (x >= nextPost) {
          g.fillStyle = P.plank; g.fillRect(x, baseY - u + 6, 6, u - 9);
          x += 12; nextPost += section * (0.9 + r(0, 0.2));
          continue;
        }
        const roll = rand();
        if (roll < 0.06) { x += r(18, 50) * k; continue; } // empty slot
        if (roll < 0.14) {                                  // pile of books lying down
          const n = 2 + ((rand() * 3) | 0), sw = r(56, 90) * k;
          let yy = baseY - 3;
          for (let i = 0; i < n; i++) {
            const sh = r(9, 15) * k, ox = r(-4, 4) * k;
            yy -= sh;
            g.fillStyle = pick(P.spines); g.fillRect(x + ox, yy, sw, sh - 1);
            g.fillStyle = P.hi; g.fillRect(x + ox + sw * 0.15, yy + sh * 0.35, sw * 0.6, 1.2);
          }
          x += sw + 6 * k;
          continue;
        }
        const bw = r(9, 24) * k, bh = u * r(0.56, 0.9), by = baseY - 3 - bh;
        const lean = rand() < 0.05;
        g.save();
        if (lean) {
          g.translate(x + bw, baseY - 3); g.rotate(-r(0.18, 0.32)); g.translate(-(x + bw), -(baseY - 3));
        }
        g.fillStyle = pick(P.spines); g.fillRect(x, by, bw, bh);
        g.fillStyle = P.hi; g.fillRect(x, by + bh * 0.12, bw, 2 * k); g.fillRect(x, baseY - 3 - bh * 0.14, bw, 2 * k);
        if (bw > 12 * k) {
          g.fillStyle = P.label; g.fillRect(x + bw * 0.2, by + bh * 0.18, bw * 0.6, bh * 0.26);
          g.fillStyle = P.inkSoft; g.fillRect(x + bw * 0.3, by + bh * 0.28, bw * 0.4, 1.2);
        }
        g.fillStyle = P.shade; g.fillRect(x + bw - 2 * k, by, 2 * k, bh);
        g.restore();
        x += bw + (lean ? 12 * k : 0.6);
      }
    }

    // a single sheet: plain, or with PDF badge / chart / table / text
    function sheet(cx, cy, pw, rot, detail, pdf, kind) {
      const ph = pw * 1.38, m = pw * 0.12, lh = Math.max(1.6, pw * 0.034);
      g.save();
      g.translate(cx, cy); g.rotate(rot);
      g.fillStyle = P.shadow; g.fillRect(-pw / 2 + 3, -ph / 2 + 4, pw, ph);
      g.fillStyle = P.paper; g.fillRect(-pw / 2, -ph / 2, pw, ph);
      g.strokeStyle = P.edge; g.lineWidth = 1; g.strokeRect(-pw / 2 + 0.5, -ph / 2 + 0.5, pw - 1, ph - 1);
      if (detail) {
        const f = pw * 0.2;
        g.fillStyle = P.fold; g.beginPath();
        g.moveTo(pw / 2 - f, -ph / 2); g.lineTo(pw / 2, -ph / 2 + f); g.lineTo(pw / 2 - f, -ph / 2 + f); g.closePath(); g.fill();
        let y = -ph / 2 + m;
        if (pdf) {
          g.fillStyle = P.pdf; g.fillRect(-pw / 2 + m, y, pw * 0.34, pw * 0.15);
          g.fillStyle = "#fff"; g.font = `700 ${pw * 0.1}px Helvetica, Arial, sans-serif`; g.textBaseline = "middle";
          g.fillText("PDF", -pw / 2 + m + pw * 0.045, y + pw * 0.077);
          y += pw * 0.26;
        } else {
          g.fillStyle = P.ink; g.fillRect(-pw / 2 + m, y, pw * 0.5, lh * 1.6);
          y += lh * 4;
        }
        const innerW = pw - 2 * m, bottom = ph / 2 - m;
        if (kind === 1) {                       // bar chart
          const area = ph * 0.3, bw = innerW / 7;
          g.fillStyle = P.line; g.fillRect(-pw / 2 + m, y + area, innerW, 1);
          for (let i = 0; i < 5; i++) {
            const bh2 = area * r(0.25, 1);
            g.fillStyle = i % 2 ? P.line : P.ink;
            g.fillRect(-pw / 2 + m + bw * (i * 1.3 + 0.2), y + area - bh2, bw, bh2);
          }
          y += area + lh * 3;
        } else if (kind === 2) {                // table
          const rowsN = 5, rh = ph * 0.05;
          g.fillStyle = P.line;
          for (let i = 0; i <= rowsN; i++) g.fillRect(-pw / 2 + m, y + i * rh, innerW, 1);
          for (let i = 0; i <= 3; i++) g.fillRect(-pw / 2 + m + (innerW / 3) * i, y, 1, rowsN * rh);
          y += rowsN * rh + lh * 3;
        }
        g.fillStyle = P.line;
        for (let ly = y; ly < bottom - lh; ly += lh * 2.7) g.fillRect(-pw / 2 + m, ly, innerW * r(0.55, 1), lh);
      }
      g.restore();
    }

    // loose papers & PDFs everywhere
    const count = Math.max(14, Math.min(46, Math.round((w * h) / 36000)));
    for (let i = 0; i < count; i++) {
      sheet(r(0.02, 0.98) * w, r(0.05, 0.95) * h, r(48, 84) * k * 1.15, r(-0.55, 0.55), true, rand() < 0.42, (rand() * 3) | 0);
    }
    // stacks of paper
    const stacks = Math.max(4, Math.round(count / 6));
    for (let s = 0; s < stacks; s++) {
      const cx = r(0.05, 0.95) * w, cy = r(0.1, 0.9) * h, pw = r(58, 80) * k * 1.1, rot = r(-0.3, 0.3);
      const n = 4 + ((rand() * 4) | 0);
      for (let i = 0; i < n; i++) sheet(cx + r(-3, 3), cy - i * 2.6, pw, rot + r(-0.07, 0.07), i === n - 1, false, 0);
    }

    // keep the area behind the title and search bar calm, and the very top/bottom clean
    g.globalCompositeOperation = "destination-out";
    g.save();
    if (phone) { g.translate(w / 2, h * 0.3); g.scale(w * 0.75, h * 0.2); }
    else { g.translate(w / 2, h * 0.46); g.scale(w * 0.34, h * 0.34); }
    const cg = g.createRadialGradient(0, 0, 0.1, 0, 0, 1);
    cg.addColorStop(0, "rgba(0,0,0,0.9)"); cg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = cg; g.fillRect(-1.2, -1.2, 2.4, 2.4);
    g.restore();
    const tg = g.createLinearGradient(0, 0, 0, 90);
    tg.addColorStop(0, "rgba(0,0,0,0.7)"); tg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = tg; g.fillRect(0, 0, w, 90);
    const bg = g.createLinearGradient(0, h - 110, 0, h);
    bg.addColorStop(0, "rgba(0,0,0,0)"); bg.addColorStop(1, "rgba(0,0,0,0.7)");
    g.fillStyle = bg; g.fillRect(0, h - 110, w, 110);
    g.globalCompositeOperation = "source-over";
  }

  /* ----- light trail + compositing ----- */
  // Light is never a perfect circle: three overlapping soft lobes, stretched along the direction of travel
  function stamp(x, y) {
    const rr = R * MASK_SCALE;
    mctx.save();
    mctx.translate(x * MASK_SCALE, y * MASK_SCALE);
    mctx.rotate(ang);
    mctx.scale(stretch, 1 / Math.sqrt(stretch));
    const lobes = [
      [0, 0, 1, 1],
      [0.34 * Math.cos(lobe), 0.26 * Math.sin(lobe * 1.3), 0.72, 0.7],
      [-0.3 * Math.cos(lobe * 0.8), -0.28 * Math.sin(lobe), 0.6, 0.55],
    ];
    for (const [ox, oy, rad, k] of lobes) {
      const cx = ox * rr, cy = oy * rr, r2 = rr * rad;
      const gr = mctx.createRadialGradient(cx, cy, 0, cx, cy, r2);
      gr.addColorStop(0, `rgba(0,0,0,${0.5 * k})`);
      gr.addColorStop(0.5, `rgba(0,0,0,${0.28 * k})`);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      mctx.fillStyle = gr;
      mctx.fillRect(cx - r2, cy - r2, r2 * 2, r2 * 2);
    }
    mctx.restore();
  }

  function composite(level) {
    const L = dark ? LIGHT.dark : LIGHT.light;
    lctx.globalCompositeOperation = "source-over";
    lctx.clearRect(0, 0, lit.width, lit.height);
    lctx.drawImage(scene, 0, 0);
    lctx.globalCompositeOperation = "destination-in";
    lctx.drawImage(mask, 0, 0, lit.width, lit.height);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = L.ambient;
    ctx.drawImage(scene, 0, 0);
    ctx.globalAlpha = L.reveal;
    ctx.drawImage(lit, 0, 0);
    ctx.globalAlpha = 1;

    if (level > 0 && sx > -5000) { // the warm light: soft, uneven, no bright dot at the cursor
      ctx.setTransform(ds, 0, 0, ds, 0, 0);
      ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(ang);
      ctx.scale(stretch, 1 / Math.sqrt(stretch));
      const flicker = 1 + 0.035 * Math.sin(lobe * 7);
      const a0 = (dark ? 0.1 : 0.12) * level, a1 = (dark ? 0.045 : 0.055) * level;
      const lobes = [
        [0.08 * Math.cos(lobe * 0.6), 0.06 * Math.sin(lobe * 0.9), 1.5, 1],
        [0.38 * Math.cos(lobe), 0.28 * Math.sin(lobe * 1.3), 1.05, 0.8],
        [-0.34 * Math.cos(lobe * 0.8), -0.32 * Math.sin(lobe), 0.85, 0.6],
      ];
      for (const [ox, oy, rad, k] of lobes) {
        const cx = ox * R, cy = oy * R, rr = R * rad * flicker;
        const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
        gr.addColorStop(0, `rgba(255, ${dark ? 214 : 200}, ${dark ? 150 : 100}, ${a0 * 0.8 * k})`);
        gr.addColorStop(0.3, `rgba(255, ${dark ? 206 : 196}, ${dark ? 140 : 100}, ${a0 * 0.8 * k})`);
        gr.addColorStop(0.7, `rgba(255, 190, 110, ${a1 * k})`);
        gr.addColorStop(1, "rgba(255, 190, 110, 0)");
        ctx.fillStyle = gr;
        ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
      }
      ctx.restore();
      ctx.globalCompositeOperation = "source-over";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || themeSwitching || isOpen) return;
    if (t - last < 22) return; // ~45 fps is plenty
    last = t;
    lobe = t * 0.0007;

    const idle = t - lastInput;
    let gx = tx, gy = ty, active = idle < 3500 && tx > -5000;
    if (!reduce && coarse && idle > 1200) { // phones: the light wanders by itself
      gx = w * (0.5 + 0.38 * Math.sin(t * 0.00031));
      gy = h * (0.5 + 0.34 * Math.sin(t * 0.00047 + 1.3));
      active = true;
    }

    if (!active && live <= 0) {
      if (!cleared) { mctx.clearRect(0, 0, mask.width, mask.height); composite(0); cleared = true; }
      return; // nothing to do while idle
    }

    // fade the old trail, then leave new light along the path the lamp travelled
    mctx.globalCompositeOperation = "destination-out";
    mctx.fillStyle = `rgba(0,0,0,${reduce ? 0.2 : 0.045})`;
    mctx.fillRect(0, 0, mask.width, mask.height);
    mctx.globalCompositeOperation = "source-over";

    if (active) {
      cleared = false;
      live = 100;
      if (sx < -5000) { sx = gx; sy = gy; }
      const ox = sx, oy = sy, ease = reduce ? 1 : 0.2;
      sx += (gx - sx) * ease;
      sy += (gy - sy) * ease;
      // stretch the light along the way it moves, like a real beam sweeping across the shelves
      const speed = Math.hypot(sx - ox, sy - oy);
      if (speed > 0.4) {
        let d = Math.atan2(sy - oy, sx - ox) - ang;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        ang += d * 0.25;
      }
      stretch += ((1 + Math.min(0.45, speed / 35)) - stretch) * 0.2;
      const steps = Math.max(1, Math.ceil(Math.hypot(sx - ox, sy - oy) / (R * 0.3)));
      for (let i = 1; i <= steps; i++) stamp(ox + ((sx - ox) * i) / steps, oy + ((sy - oy) * i) / steps);
    } else {
      live--;
      stretch += (1 - stretch) * 0.1;
    }
    composite(Math.min(1, live / 40));
  }

  /* ----- setup ----- */
  function resize() {
    ds = Math.min(window.devicePixelRatio || 1, 1.5);
    w = window.innerWidth;
    h = window.innerHeight;
    phone = w < 760;
    R = Math.max(110, Math.min(230, Math.min(w, h) * 0.24));
    for (const c of [canvas, scene, lit]) { c.width = Math.round(w * ds); c.height = Math.round(h * ds); }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    mask.width = Math.ceil(w * MASK_SCALE);
    mask.height = Math.ceil(h * MASK_SCALE);
    dark = document.documentElement.dataset.theme === "dark";
    drawScene();
    composite(live > 0 ? Math.min(1, live / 40) : 0);
  }

  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // ignore small height changes (mobile address bar, on-screen keyboard)
      if (window.innerWidth === w && Math.abs(window.innerHeight - h) < 150) return;
      resize();
    }, 120);
  });

  // new palette on theme change — redraw right away so the reveal captures the right colours
  new MutationObserver(() => {
    dark = document.documentElement.dataset.theme === "dark";
    drawScene();
    composite(live > 0 ? Math.min(1, live / 40) : 0);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const onPointer = (e) => {
    tx = e.clientX;
    ty = e.clientY;
    lastInput = performance.now();
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("pointerdown", onPointer, { passive: true });

  resize();
  raf = requestAnimationFrame(frame);
})();

/* ───────── Live clock ───────── */
const clockEl = document.querySelector("#clock");
const clockDateEl = document.querySelector("#clock-date");

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  clockEl.dateTime = now.toISOString();
  clockEl.title = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (clockDateEl) clockDateEl.textContent = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}
tickClock();
// re-sync to the start of each second so the clock never drifts
(function scheduleTick() {
  setTimeout(() => { tickClock(); scheduleTick(); }, 1000 - (Date.now() % 1000));
})();

setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
loadDocuments();
