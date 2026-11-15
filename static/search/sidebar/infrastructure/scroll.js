// Directory browsing: explicit view and effect ports, owned lifecycle.
(function () {
  /** @param {VoiceOfMLSidebarScrollDependencies} deps */
  function create(deps) {
const SIDEBAR_SCROLL_STORAGE_KEY = deps.storageKey;
const SIDEBAR_SCROLL_LIMIT = 80;
/** @type {Map<string, number>} */
const sidebarScrollPositions = new Map();
let activeSidebarScrollKey = "";
let sidebarScrollFrame = 0;
let sidebarScrollRestoreFrame = 0;
let sidebarScrollRestoring = false;
let sidebarScrollPersistTimer = 0;

/** @param {string | null} repo @param {string} path */
function sidebarScrollKeyFor(repo, path) {
  return repo ? `repo:${repo}|path:${path || ""}` : "global";
}

/** @param {string} key @param {number} top */
function setSidebarScrollPosition(key, top) {
  if (!key || !Number.isFinite(top) || top < 0) return;
  sidebarScrollPositions.delete(key);
  sidebarScrollPositions.set(key, Math.round(top));
  while (sidebarScrollPositions.size > SIDEBAR_SCROLL_LIMIT) {
    sidebarScrollPositions.delete(/** @type {string} */ (sidebarScrollPositions.keys().next().value));
  }
  scheduleSidebarScrollPersist();
}

function scheduleSidebarScrollPersist() {
  if (sidebarScrollPersistTimer) return;
  sidebarScrollPersistTimer = setTimeout(() => {
    sidebarScrollPersistTimer = 0;
    persistSidebarScrollPositions();
  }, 250);
}

function loadSidebarScrollPositions() {
  try {
    const raw = sessionStorage.getItem(SIDEBAR_SCROLL_STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== "object") return;
    for (const [key, value] of Object.entries(stored)) {
      if (typeof key === "string" && Number.isFinite(value) && value >= 0) {
        sidebarScrollPositions.set(key, Math.round(value));
      }
    }
    while (sidebarScrollPositions.size > SIDEBAR_SCROLL_LIMIT) {
      sidebarScrollPositions.delete(/** @type {string} */ (sidebarScrollPositions.keys().next().value));
    }
  } catch (_) {}
}

function persistSidebarScrollPositions() {
  try {
    /** @type {Record<string, number>} */
    const stored = {};
    for (const [key, value] of sidebarScrollPositions) {
      if (value > 0) stored[key] = value;
    }
    sessionStorage.setItem(SIDEBAR_SCROLL_STORAGE_KEY, JSON.stringify(stored));
  } catch (_) {}
}

function rememberSidebarScroll() {
  if (!deps.content() || !activeSidebarScrollKey || sidebarScrollRestoring) return;
  const top = deps.content().scrollTop;
  if (Number.isFinite(top) && top >= 0) setSidebarScrollPosition(activeSidebarScrollKey, top);
}

/** @param {string} key */
function activateSidebarScrollKey(key) {
  if (key === activeSidebarScrollKey) return;
  rememberSidebarScroll();
  activeSidebarScrollKey = key;
}

function restoreSidebarScroll() {
  if (!deps.content() || !activeSidebarScrollKey) return;
  const target = sidebarScrollPositions.get(activeSidebarScrollKey) || 0;
  const max = Math.max(0, deps.content().scrollHeight - deps.content().clientHeight);
  const next = Math.min(target, max);
  sidebarScrollRestoring = true;
  if (Math.abs(deps.content().scrollTop - next) > 1) deps.content().scrollTop = next;
  if (!sidebarScrollRestoreFrame) {
    sidebarScrollRestoreFrame = requestAnimationFrame(() => {
      sidebarScrollRestoreFrame = 0;
      sidebarScrollRestoring = false;
    });
  }
}

function handleSidebarScroll() {
  if (sidebarScrollRestoring || sidebarScrollFrame) return;
  sidebarScrollFrame = requestAnimationFrame(() => {
    sidebarScrollFrame = 0;
    rememberSidebarScroll();
  });
}

function flushSidebarScroll() {
  rememberSidebarScroll();
  if (sidebarScrollFrame) {
    cancelAnimationFrame(sidebarScrollFrame);
    sidebarScrollFrame = 0;
  }
  if (sidebarScrollPersistTimer) {
    clearTimeout(sidebarScrollPersistTimer);
    sidebarScrollPersistTimer = 0;
  }
  persistSidebarScrollPositions();
}
function install() {
  loadSidebarScrollPositions();
  deps.content().addEventListener("scroll", handleSidebarScroll, { passive: true });
  window.addEventListener("pagehide", flushSidebarScroll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSidebarScroll();
  });
}
    return { keyFor: sidebarScrollKeyFor, activate: activateSidebarScrollKey, remember: rememberSidebarScroll, restore: restoreSidebarScroll, flush: flushSidebarScroll, install, positions: sidebarScrollPositions, get activeKey() { return activeSidebarScrollKey; }, get restoring() { return sidebarScrollRestoring; } };
  }
  /** @type {typeof globalThis & {VoiceOfMLSidebarScroll: typeof VoiceOfMLSidebarScroll}} */
  const globals = globalThis;
  globals.VoiceOfMLSidebarScroll = {create};
})();
