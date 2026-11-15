// Session history persistence is independent of search submission and preferences.
(function () {
  /** @param {() => Storage} storage */
  function create(storage) {
    const key = "voml_search_history", max = 20;
    function get() {
      try {
        return JSON.parse(/** @type {string} */ (storage().getItem(key))) || [];
      } catch (_) { return []; }
    }
    /** @param {string[]} list */
    function save(list) {
      try { storage().setItem(key, JSON.stringify(list.slice(0, max))); }
      catch (_) { /* Storage may be unavailable or full. */ }
    }
    return { get, save };
  }
  globalThis.VoiceOfMLSearchHistoryStore = { create };
})();
