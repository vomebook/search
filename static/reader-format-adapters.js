(function(root) {
  "use strict";
  const METHODS = Object.freeze(["open", "render", "navigate", "search", "progress", "restore", "dispose"]);
  function createAdapterRegistry() {
    const adapters = new Map();
    let active = null;
    function register(mode, adapter) {
      if (!mode || adapters.has(mode)) throw new Error(`READER_ADAPTER_DUPLICATE:${mode}`);
      for (const method of METHODS) if (typeof adapter?.[method] !== "function") throw new TypeError(`READER_ADAPTER_METHOD:${mode}:${method}`);
      const value = Object.freeze({ mode, ...adapter }); adapters.set(mode, value); return value;
    }
    function activate(mode) { const adapter = adapters.get(mode); if (!adapter) throw new Error(`READER_ADAPTER_MISSING:${mode}`); active = adapter; return adapter; }
    function get(mode) { return adapters.get(mode) || null; }
    function dispose() { const adapter = active; active = null; return adapter ? adapter.dispose() : undefined; }
    return Object.freeze({ register, activate, get, dispose, get active() { return active; }, get modes() { return [...adapters.keys()]; } });
  }
  root.VoiceOfMLReaderAdapters = Object.freeze({ METHODS, createAdapterRegistry });
})(typeof self !== "undefined" ? self : globalThis);
