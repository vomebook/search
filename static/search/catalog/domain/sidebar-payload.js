// Compact static sidebar data retains the site's original root-relative paths.
(function () {
  /** @param {unknown} value @param {string} [path] */
  function normalize(value, path = "") {
    path = path || "";
    if (!value || typeof value !== "object") return value;
    const data = /** @type {CatalogSidebarPayload} */ (value);
    if (Array.isArray(data.repos)) return data;
    return {
      repo: data.repo || "",
      path: data.path || path,
      folders: (data.folders || []).map(function(item) {
        var name = item.n || "";
        return { name: name, path: path ? path + "/" + name : name, count: item.c || 0 };
      }),
      files: (data.files || []).map(function(item) {
        return {
          name: item.n || "", ext: item.e || "", hasTxt: !!item.t,
          size: item.s === undefined ? "" : item.s, link: "",
        };
      }),
    };
  }
  globalThis.VoiceOfMLCatalogSidebarPayload = { normalize };
})();
