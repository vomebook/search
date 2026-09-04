(function(root) {
  "use strict";

  const FEATURE_MATRIX = Object.freeze({
    pdf: { toc: true, search: true, zoom: true, bookmarks: true, pagination: true, media: false },
    "pdf-pages": { toc: false, search: false, zoom: true, bookmarks: true, pagination: true, media: false },
    foliate: { toc: true, search: true, zoom: true, bookmarks: true, pagination: false, media: false },
    "epub-chapters": { toc: true, search: true, zoom: true, bookmarks: true, pagination: false, media: false },
    docx: { toc: true, search: true, zoom: true, bookmarks: true, pagination: true, media: false },
    html: { toc: true, search: true, zoom: true, bookmarks: true, pagination: false, media: false },
    text: { toc: false, search: true, zoom: true, bookmarks: true, pagination: false, media: false },
    markdown: { toc: true, search: true, zoom: true, bookmarks: true, pagination: false, media: false },
    image: { toc: false, search: false, zoom: true, bookmarks: true, pagination: false, media: false },
    audio: { toc: false, search: false, zoom: false, bookmarks: true, pagination: false, media: true },
    video: { toc: false, search: false, zoom: false, bookmarks: true, pagination: false, media: true },
    unsupported: { toc: false, search: false, zoom: false, bookmarks: false, pagination: false, media: false },
  });

  function createEventBus() {
    const listeners = new Map();
    let disposed = false;
    function on(type, listener) {
      if (disposed) return () => {};
      const set = listeners.get(type) || new Set();
      set.add(listener); listeners.set(type, set);
      return () => { set.delete(listener); if (!set.size) listeners.delete(type); };
    }
    function emit(type, detail) {
      if (disposed) return;
      for (const listener of [...(listeners.get(type) || []), ...(listeners.get("*") || [])]) listener(detail, type);
    }
    function dispose() { disposed = true; listeners.clear(); }
    return Object.freeze({ on, emit, dispose, get disposed() { return disposed; } });
  }

  function createReaderRuntime(options = {}) {
    const events = options.events || createEventBus();
    const state = {
      lifecycle: { phase: "startup", stage: "startup", disposed: false, errorCode: "" },
      source: { id: "", url: "", contentUrl: "", downloadUrl: "", extension: "", metadata: null },
      document: { title: "", zoom: 1, page: 1, pageCount: 0, restoredEntry: null, restorationReady: false },
      navigation: { tocEntries: [], currentChapterIndex: -1 },
      search: { query: "", results: [], index: -1 },
      panel: { open: false, selected: "toc", showingAllBookmarks: false, editingBookmark: null },
      formats: { active: null, pdf: {}, foliate: {}, html: {}, media: {} },
      capability: null,
      ...(options.initialState || {}),
    };
    const generations = new Map();
    const disposables = new Set();

    function snapshot() {
      return Object.freeze({
        lifecycle: Object.freeze({ ...state.lifecycle }),
        source: Object.freeze({ ...state.source }),
        document: Object.freeze({ ...state.document }),
        navigation: Object.freeze({ ...state.navigation }),
        search: Object.freeze({ ...state.search }),
        panel: Object.freeze({ ...state.panel }),
        formats: Object.freeze(Object.fromEntries(Object.entries(state.formats).map(([name, value]) => [name, Object.freeze({ ...value })]))),
        capability: state.capability,
      });
    }
    function update(domain, patch) {
      if (state.lifecycle.disposed && domain !== "lifecycle") return false;
      Object.assign(state[domain], patch);
      const current = snapshot();
      events.emit(`state:${domain}`, current);
      events.emit("state", current);
      return true;
    }
    function updateFormat(format, patch) {
      if (state.lifecycle.disposed || !state.formats[format]) return false;
      Object.assign(state.formats[format], patch);
      events.emit(`format:${format}`, snapshot());
      events.emit("state", snapshot());
      return true;
    }
    function setPhase(phase) {
      if (state.lifecycle.disposed && phase !== "disposed") return false;
      state.lifecycle.phase = phase;
      events.emit("phase", { phase, state: snapshot() });
      return true;
    }
    function setStage(stage) {
      if (!setPhase(stage)) return false;
      state.lifecycle.stage = stage;
      events.emit("stage", { stage, state: snapshot() });
      return true;
    }
    function fail(code) {
      state.lifecycle.errorCode = code;
      setPhase("failed");
      events.emit("error", { code, state: snapshot() });
    }
    function nextGeneration(name) {
      const value = (generations.get(name) || 0) + 1;
      generations.set(name, value);
      events.emit("generation", { name, value });
      return value;
    }
    function isCurrent(name, value) { return !state.lifecycle.disposed && generations.get(name) === value; }
    function track(disposable) { if (disposable) disposables.add(disposable); return disposable; }
    function untrack(disposable) { disposables.delete(disposable); }
    function negotiate(capability) {
      const mode = capability?.mode || "unsupported";
      const value = Object.freeze({ ...capability, features: Object.freeze({ ...(FEATURE_MATRIX[mode] || FEATURE_MATRIX.unsupported) }) });
      state.capability = value;
      events.emit("capability", value);
      return value;
    }
    function dispose() {
      if (state.lifecycle.disposed) return;
      state.lifecycle.disposed = true;
      state.lifecycle.phase = "disposed";
      for (const name of generations.keys()) nextGeneration(name);
      for (const disposable of [...disposables].reverse()) {
        try { if (typeof disposable === "function") disposable(); else disposable.dispose?.(); } catch (_) {}
      }
      disposables.clear();
      events.emit("phase", { phase: "disposed", state: snapshot() });
      events.emit("dispose", snapshot());
      events.dispose();
    }
    return Object.freeze({ state, events, snapshot, update, updateFormat, setPhase, setStage, fail, nextGeneration, isCurrent, track, untrack, negotiate, dispose });
  }

  root.VoiceOfMLReaderRuntime = Object.freeze({ FEATURE_MATRIX, createEventBus, createReaderRuntime });
})(typeof self !== "undefined" ? self : globalThis);
