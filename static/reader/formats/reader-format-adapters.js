(function (root) {
  "use strict";
  /**
   * @typedef {{
   *   open: () => unknown,
   *   render: (prepared: unknown) => unknown,
   *   restore: (entry: unknown, generation: number) => unknown,
   *   dispose: () => unknown
   * }} FormatAdapter
   */
  /** @type {readonly (keyof FormatAdapter)[]} */
  const METHODS = Object.freeze(["open", "render", "restore", "dispose"]);
  function createAdapterRegistry() {
    /** @type {Map<string, Readonly<FormatAdapter & {mode: string}>>} */
    const adapters = new Map();
    /** @type {Readonly<FormatAdapter & {mode: string}> | null} */
    let active = null;
    /** @param {string} mode @param {FormatAdapter} adapter */
    function register(mode, adapter) {
      if (!mode || adapters.has(mode)) throw new Error(`READER_ADAPTER_DUPLICATE:${mode}`);
      for (const method of METHODS)
        if (typeof adapter?.[method] !== "function")
          throw new TypeError(`READER_ADAPTER_METHOD:${mode}:${method}`);
      const value = Object.freeze({ mode, ...adapter });
      adapters.set(mode, value);
      return value;
    }
    /** @param {string} mode */
    function activate(mode) {
      const adapter = adapters.get(mode);
      if (!adapter) throw new Error(`READER_ADAPTER_MISSING:${mode}`);
      active = adapter;
      return adapter;
    }
    /** @param {string} mode */
    function get(mode) {
      return adapters.get(mode) || null;
    }
    function dispose() {
      const adapter = active;
      active = null;
      return adapter ? adapter.dispose() : undefined;
    }
    return Object.freeze({
      register,
      activate,
      get,
      dispose,
      get active() {
        return active;
      },
      get modes() {
        return [...adapters.keys()];
      }
    });
  }
  root.VoiceOfMLReaderAdapters = Object.freeze({ METHODS, createAdapterRegistry });
})(typeof self !== "undefined" ? self : globalThis);
