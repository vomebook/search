(function (root) {
  "use strict";
  // Canonical resource inventory for runtime, warming, caching and static builds.
  const vendors = {
    pdf: {
      url: "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs",
      file: "pdf.min.mjs",
      sha256: "f80490490320511e5df18c580b9edd6b5db8058dceebaf6f161992e0a964b9e2"
    },
    pdfWorker: {
      url: "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs",
      file: "pdf.worker.min.mjs",
      sha256: "8ab0e5e30031b4a06ecfddd5ae9562f0227f830ee7ec9ed1a968b134243d2386"
    },
    marked: {
      url: "https://cdn.jsdelivr.net/npm/marked@18.0.13/lib/marked.umd.js",
      file: "marked.min.js",
      sha256: "b147274a9ce27d17276587167e49483d719f6893eeca3a3667a59797661d3556"
    },
    purify: {
      url: "https://cdn.jsdelivr.net/npm/dompurify@3.4.15/dist/purify.min.js",
      file: "purify.min.js",
      sha256: "f263b05369e050fa175d4ecb9c9358eb4253602d510297adfb31df48b2f1c4d5"
    },
    jszip: {
      url: "https://cdn.jsdelivr.net/npm/jszip@3.10.2/dist/jszip.min.js",
      file: "jszip.min.js",
      sha256: "7f839b2d4688b845c105ebf5d2f9803075f91ea0fe72bdaac176c3a04dd3d2c1"
    },
    docx: {
      url: "https://cdn.jsdelivr.net/npm/docx-preview@0.4.0/dist/docx-preview.min.js",
      file: "docx-preview.min.js",
      sha256: "051ef503f2677d53159a388b7384e950eda41ea4e47a103e5e36f124d7faea40"
    }
  };
  for (const vendor of Object.values(vendors)) {
    const dot = vendor.file.lastIndexOf(".");
    vendor.path =
      "vendor/" +
      vendor.file.slice(0, dot) +
      "." +
      vendor.sha256.slice(0, 12) +
      vendor.file.slice(dot);
    Object.freeze(vendor);
  }
  const pdfArchive = Object.freeze({
    url: "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz",
    sha256: "06f25e887adc6489f04c9fcb14198c77e4e5623a59a0bba5c4cea5838a4f1241"
  });
  const readerFiles = Object.freeze([
    "reader-resources.js",
    "reader-chapter-search-worker.mjs",
    "reader-chapter-search.mjs",
    "reader-contract.js",
    "reader-navigation.js",
    "reader-store.js",
    "reader-request-manager.js",
    "reader-chapter-repository.js",
    "reader-scroll-anchor.js",
    "reader-section-virtualizer.js",
    "reader-runtime.js",
    "reader-format-adapters.js",
    "reader-security.js",
    "reader-pdf-text.js",
    "pdf-worker-wrapper.mjs",
    "reader.css",
    "reader.js"
  ]);
  const lazyFiles = new Set([
    "reader-chapter-search-worker.mjs",
    "reader-chapter-search.mjs",
    "pdf-worker-wrapper.mjs"
  ]);
  const vendorUrl = (name, base) => base + vendors[name].path;
  const runtimePaths = (base) => readerFiles.map((file) => base + file);
  const shellAssets = (base) =>
    readerFiles.filter((file) => !lazyFiles.has(file)).map((file) => base + file);
  function engineAssets(extension, base, foliateSuffix = "") {
    if (extension === "pdf")
      return [
        vendorUrl("pdf", base),
        base + "pdf-worker-wrapper.mjs",
        vendorUrl("pdfWorker", base)
      ];
    if (["epub", "mobi", "azw", "azw3", "fb2", "fbz"].includes(extension))
      return [base + "foliate-reader/view.js" + foliateSuffix];
    if (extension === "docx") return [vendorUrl("jszip", base), vendorUrl("docx", base)];
    if (["md", "markdown", "html", "htm"].includes(extension))
      return [vendorUrl("marked", base), vendorUrl("purify", base)];
    return [];
  }
  function buildFiles(project) {
    return [
      ...readerFiles,
      "search-session.js",
      "download-controller.js",
      "style.css",
      ...(project === "github" ? ["index-worker.js"] : []),
      "app.js"
    ];
  }
  const resources = Object.freeze({
    vendors: Object.freeze(vendors),
    pdfArchive,
    readerFiles,
    vendorUrl,
    runtimePaths,
    shellAssets,
    engineAssets,
    buildFiles
  });
  if (typeof module !== "undefined" && module.exports) module.exports = resources;
  else root.VoiceOfMLReaderResources = resources;
})(typeof self !== "undefined" ? self : globalThis);
