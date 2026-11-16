(function (root) {
  "use strict";

  const FEATURE_MATRIX = root.VoiceOfMLReader.features;

  /** @typedef {(detail: unknown, type: string) => void} EventListener */
  /** @typedef {{mode?: string, features?: object, [key: string]: unknown}} Capability */
  /** @typedef {ReaderRuntimeState} RuntimeState */
  /** @typedef {(() => void) | {dispose?: () => void}} Disposable */

  function createEventBus() {
    /** @type {Map<string, Set<EventListener>>} */
    const listeners = new Map();
    let disposed = false;
    /** @param {string} type @param {EventListener} listener */
    function on(type, listener) {
      if (disposed) return () => {};
      const set = listeners.get(type) || new Set();
      set.add(listener);
      listeners.set(type, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(type);
      };
    }
    /** @param {string} type @param {unknown} detail */
    function emit(type, detail) {
      if (disposed) return;
      for (const listener of [...(listeners.get(type) || []), ...(listeners.get("*") || [])])
        listener(detail, type);
    }
    function dispose() {
      disposed = true;
      listeners.clear();
    }
    return Object.freeze({
      on,
      emit,
      dispose,
      get disposed() {
        return disposed;
      }
    });
  }

  /** @param {{events?: ReturnType<typeof createEventBus>, initialState?: Partial<RuntimeState>}} [options] */
  function createReaderRuntime(options = {}) {
    const events = options.events || createEventBus();
    /** @type {RuntimeState} */
    const state = {
      lifecycle: { phase: "startup", stage: "startup", disposed: false, errorCode: "" },
      source: { id: "", url: "", contentUrl: "", downloadUrl: "", extension: "", metadata: null },
      document: {
        title: "",
        zoom: 1,
        page: 1,
        pageCount: 0,
        restoredEntry: null,
        restorationReady: false
      },
      navigation: { tocEntries: [], currentChapterIndex: -1 },
      search: { query: "", results: [], index: -1 },
      panel: { open: false, selected: "toc", showingAllBookmarks: false, editingBookmark: null },
      formats: { active: null, pdf: {}, foliate: {}, html: {}, media: {} },
      capability: null,
      ...(options.initialState || {})
    };
    /** @type {Map<string, number>} */
    const generations = new Map();
    /** @type {Set<Disposable>} */
    const disposables = new Set();
    /** @type {Set<ReturnType<typeof setTimeout>>} */
    const timers = new Set();
    /** @type {Set<number>} */
    const frames = new Set();

    function snapshot() {
      return Object.freeze({
        lifecycle: Object.freeze({ ...state.lifecycle }),
        source: Object.freeze({ ...state.source }),
        document: Object.freeze({ ...state.document }),
        navigation: Object.freeze({ ...state.navigation }),
        search: Object.freeze({ ...state.search }),
        panel: Object.freeze({ ...state.panel }),
        formats: Object.freeze(
          /** @type {ReaderRuntimeFormatsSnapshot} */ (Object.fromEntries(
            Object.entries(state.formats).map(([name, value]) => [
              name,
              Object.freeze({ .../** @type {object} */ (value) })
            ])
          ))
        ),
        capability: state.capability
      });
    }
    /** @template {ReaderRuntimeUpdateDomain} K @param {K} domain @param {Partial<RuntimeState[K]>} patch */
    function update(domain, patch) {
      if (state.lifecycle.disposed && domain !== "lifecycle") return false;
      Object.assign(/** @type {object} */ (state[domain]), patch);
      const current = snapshot();
      events.emit(`state:${domain}`, current);
      events.emit("state", current);
      return true;
    }
    /** @param {string} format @param {Record<string, unknown>} patch */
    function updateFormat(format, patch) {
      if (state.lifecycle.disposed || !state.formats[format]) return false;
      Object.assign(state.formats[format], patch);
      events.emit(`format:${format}`, snapshot());
      events.emit("state", snapshot());
      return true;
    }
    /** @param {string} phase */
    function setPhase(phase) {
      if (state.lifecycle.disposed && phase !== "disposed") return false;
      state.lifecycle.phase = phase;
      events.emit("phase", { phase, state: snapshot() });
      return true;
    }
    /** @param {string} stage */
    function setStage(stage) {
      if (!setPhase(stage)) return false;
      state.lifecycle.stage = stage;
      events.emit("stage", { stage, state: snapshot() });
      return true;
    }
    /** @param {string} code */
    function fail(code) {
      state.lifecycle.errorCode = code;
      setPhase("failed");
      events.emit("error", { code, state: snapshot() });
    }
    /** @param {string} name */
    function nextGeneration(name) {
      const value = (generations.get(name) || 0) + 1;
      generations.set(name, value);
      events.emit("generation", { name, value });
      return value;
    }
    /** @param {string} name */
    function currentGeneration(name) {
      return generations.get(name) || 0;
    }
    /** @param {string} name @param {number} value */
    function isCurrent(name, value) {
      return !state.lifecycle.disposed && generations.get(name) === value;
    }
    /** @template {Disposable | null | undefined} T @param {T} disposable @returns {T} */
    function track(disposable) {
      if (disposable) disposables.add(disposable);
      return disposable;
    }
    /** @param {Disposable} disposable */
    function untrack(disposable) {
      disposables.delete(disposable);
    }
    /** @param {() => void} callback @param {number} [delay] */
    function schedule(callback, delay = 0) {
      const handle = setTimeout(() => {
        timers.delete(handle);
        callback();
      }, delay);
      timers.add(handle);
      return handle;
    }
    /** @param {ReturnType<typeof setTimeout>} handle */
    function cancel(handle) {
      if (!timers.has(handle)) return;
      clearTimeout(handle);
      timers.delete(handle);
    }
    /** @param {() => void} callback */
    function frame(callback) {
      const handle = requestAnimationFrame(() => {
        frames.delete(handle);
        callback();
      });
      frames.add(handle);
      return handle;
    }
    /** @param {number} handle */
    function cancelFrame(handle) {
      if (!frames.has(handle)) return;
      cancelAnimationFrame(handle);
      frames.delete(handle);
    }
    /**
     * @overload
     * @param {ReturnType<import('../../../typings/reader-contract-strict').ReaderContract['capability']>} capability
     * @returns {Readonly<ReturnType<import('../../../typings/reader-contract-strict').ReaderContract['capability']>>}
     */
    /**
     * @overload
     * @param {Capability | null | undefined} capability
     * @returns {Readonly<Capability & {features: object}>}
     */
    /** @param {Capability | null | undefined} capability */
    function negotiate(capability) {
      const mode = capability?.mode || "unsupported";
      const value = Object.freeze({
        ...capability,
        features: Object.freeze({
          ...(capability?.features || FEATURE_MATRIX[mode] || FEATURE_MATRIX.unsupported)
        })
      });
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
        try {
          if (typeof disposable === "function") disposable();
          else disposable.dispose?.();
        } catch (_) {}
      }
      for (const handle of timers) clearTimeout(handle);
      for (const handle of frames) cancelAnimationFrame(handle);
      timers.clear();
      frames.clear();
      disposables.clear();
      events.emit("phase", { phase: "disposed", state: snapshot() });
      events.emit("dispose", snapshot());
      events.dispose();
    }
    return Object.freeze({
      state,
      events,
      snapshot,
      update,
      updateFormat,
      setPhase,
      setStage,
      fail,
      nextGeneration,
      currentGeneration,
      isCurrent,
      track,
      untrack,
      schedule,
      cancel,
      frame,
      cancelFrame,
      negotiate,
      dispose
    });
  }

  /** @satisfies {ReaderRuntimeApi} */
  const runtimeApi = Object.freeze({
    FEATURE_MATRIX,
    createEventBus,
    createReaderRuntime
  });
  root.VoiceOfMLReaderRuntime = runtimeApi;
})(typeof self !== "undefined" ? self : globalThis);
