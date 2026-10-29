"use strict";

/* ───────── Config ───────── */
const DATA_URL = "./unipdfs.json";
const API_URL = "";
const FAV_KEY = "s3-favorites";

const VALID_TYPES = new Set(["cours", "td", "tp", "exam"]);
const TYPE_LABELS = { cours: "Course", td: "Tutorial", tp: "Practical", exam: "Exam" };
const TYPE_SHORT = { cours: "CRS", td: "TD", tp: "TP", exam: "EXM" };
const MODULE_LABELS = { 
  algo: "Algorithm", 
  archi: "Architecture", 
  asd: "ASD", 
  mn: "Numerical Methods", 
  si: "Information Systems", 
  other: "Other" 
};
const MODULE_ORDER = ["algo", "archi", "asd", "mn", "si"];
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
let activeType = "all";
let activeModule = "all";
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
  if (activeType === "fav") render({ keepScroll: true });
}

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

function guessModule(item) {
  if (typeof item.module === "string" && item.module.trim()) return item.module.trim().toLowerCase();
  const text = normalize(`${item.title} ${item.filename}`);
  if (/archi/.test(text)) return "archi";
  if (/(^|[^a-z])asd([^a-z]|$)/.test(text)) return "asd";
  if (/algo/.test(text)) return "algo";
  if (/(^|[^a-z])mn([^a-z]|$)/.test(text)) return "mn";
  if (/(^|[^a-z])si([^a-z]|$)/.test(text)) return "si";
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

function highlight(text, tokens) {
  const frag = document.createDocumentFragment();
  if (!tokens.length) { frag.append(text); return frag; }

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
    } else { frag.append(buffer); }
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

  moduleBar.hidden = keys.length < 2;
  if (activeModule !== "all" && !counts.has(activeModule)) activeModule = "all";
  syncModuleChips();
}

function selectModule(module) {
  activeModule = module;
  syncModuleChips();
  animateNext = true;
  render();
}

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
    downloadViaFetch = false;
    fallback();
  } finally {
    link.classList.remove("is-busy");
  }
}

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

  themeSwitching = true;
  const transition = document.startViewTransition(() => setTheme(next));
  transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 650, easing: "cubic-bezier(0.16, 1, 0.3, 1)", pseudoElement: "::view-transition-new(root)" }
    );
  }).catch(() => {});
  transition.finished.finally(() => { themeSwitching = false; });
});

async function loadDocuments() {
  try {
    const fetchList = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Network error");
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("Invalid document list");
      return data.filter(isDocument);
    };

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
        if (event.shiftKey) toggleFavorite(item, row.querySelector(".fav"));
        else if (event.ctrlKey || event.metaKey) downloadDocument(row.querySelector(".dl"), item);
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

panel.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".result") || event.target.closest(".result-action")) event.preventDefault();
});
resultsEl.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "mouse") return;
  const el = event.target.closest(".result");
  if (el && Number(el.dataset.index) !== activeIndex) setActive(Number(el.dataset.index), false);
});

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
  }
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

/* ───────── Quotes ───────── */
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

/* ───────── Background Library (Keep your existing code) ───────── */
/* (Your canvas library script goes here) */

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
(function scheduleTick() {
  setTimeout(() => { tickClock(); scheduleTick(); }, 1000 - (Date.now() % 1000));
})();

setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
loadDocuments();
