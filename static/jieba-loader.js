/* ═══════════════════════════════════════════════════════════
   jieba-wasm Loader
   Uses dynamic import from CDN (ES module, --target web).
   Sets window._jiebaReady = Promise that resolves when loaded.
   ═══════════════════════════════════════════════════════════ */

(function() {
  // jieba-wasm CDN URLs (--target web, ES module)
  var JIEBA_JS  = "https://cdn.jsdelivr.net/npm/jieba-wasm@2.4.0/pkg/web/jieba_rs_wasm.js";
  var JIEBA_WASM = "https://cdn.jsdelivr.net/npm/jieba-wasm@2.4.0/pkg/web/jieba_rs_wasm_bg.wasm";

  window._jiebaReady = new Promise(function(resolve) {
    // Fallback timeout: if CDN is unreachable after 12s, give up and resolve with null
    var fallbackTimer = setTimeout(function() {
      console.warn("[jieba] CDN timeout, falling back to Intl.Segmenter");
      window._jiebaCut = null;
      window._jiebaCutAll = null;
      window._jiebaCutForSearch = null;
      resolve(null);
    }, 12000);

    function fail(err) {
      clearTimeout(fallbackTimer);
      console.warn("[jieba] Failed to load:", err && err.message || err);
      window._jiebaCut = null;
      window._jiebaCutAll = null;
      window._jiebaCutForSearch = null;
      resolve(null);
    }

    import(JIEBA_JS).then(function(mod) {
      var init = mod.default;
      var cut  = mod.cut;
      var cut_for_search = mod.cut_for_search;

      return init(JIEBA_WASM).then(function() {
        clearTimeout(fallbackTimer);
        window._jiebaCut = function(text) { return cut(text, true); };
        window._jiebaCutAll = function(text) { return mod.cut_all(text); };
        window._jiebaCutForSearch = function(text) { return cut_for_search(text, true); };
        console.log("[jieba] WASM initialized via CDN");
        resolve(true);
      });
    }).catch(fail);
  });
})();