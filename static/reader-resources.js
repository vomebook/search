(function (root) {
  "use strict";
  // Canonical resource inventory for runtime, warming, caching and static builds.
  const vendors = {
    pdf: {
      url: "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.min.mjs",
      file: "pdf.min.mjs",
      sha256: "57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2"
    },
    pdfWorker: {
      url: "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs",
      file: "pdf.worker.min.mjs",
      sha256: "9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18"
    },
    marked: {
      url: "https://cdn.jsdelivr.net/npm/marked@18.1.0/lib/marked.umd.js",
      file: "marked.min.js",
      sha256: "f424dcb508fdf93e0137a970cfce8f3207ea2e3f37eca5f7556a52875683632a"
    },
    purify: {
      url: "https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.min.js",
      file: "purify.min.js",
      sha256: "2c90a9b46d6463f26038a29b686e82bc91de01fdac9d5229e7cfe3b360134ea2"
    },
    jszip: {
      url: "https://cdn.jsdelivr.net/npm/jszip@3.10.2/dist/jszip.min.js",
      file: "jszip.min.js",
      sha256: "7f839b2d4688b845c105ebf5d2f9803075f91ea0fe72bdaac176c3a04dd3d2c1"
    },
    docx: {
      url: "https://cdn.jsdelivr.net/npm/docx-preview@0.4.1/dist/docx-preview.min.js",
      file: "docx-preview.min.js",
      sha256: "c4a133c65a112799e35b143c572dfff9e923a3bf39b5fd3b07a06aa0f8f530c2"
    },
    ruffle: {
      url: "https://unpkg.com/@ruffle-rs/ruffle@0.7.1/ruffle.js",
      file: "ruffle.js",
      sha256: "26036a94567088dfb3de88a759e8ed10a4cea07b29500af36f345eef42420098"
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
    url: "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz",
    sha256: "86269b40170eb41740ea05ad2102d71d33de4f122b34eb2f478be0ea7779c415"
  });
  const foliateVendors = {
    fflateLicense: {
      url: "https://cdn.jsdelivr.net/npm/fflate@0.8.3/LICENSE",
      file: "LICENSE_fflate",
      sha256: "0a1df3a083d0c010560aa342e87959c8c1070e6fd54545741f083f22d0c8b551"
    },
    zipLicense: {
      url: "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.23.0/LICENSE",
      file: "LICENSE_zipjs",
      sha256: "1b7ebc8d7889ed25491484ab2b102370742ca6c0b26650a0c62cc2269b579b84"
    },
    fflate: {
      url: "https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js",
      file: "fflate.js",
      sha256: "b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1"
    },
    zip: {
      url: "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.23.0/index.min.js",
      file: "zip.js",
      sha256: "1b4d7f05a108b7e5815b429f116f17deb36af1949e1aff5aedcf47292d65c8ed"
    },
    textLayer: {
      url: "https://cdn.jsdelivr.net/gh/mozilla/pdf.js@v6.4.299/web/text_layer_builder.css",
      file: "pdfjs/text_layer_builder.css",
      sha256: "5b21bcb7d703cae5b8eebf9c8579435409aaf351b62e7518327ada60bdd0946f"
    },
    annotationLayer: {
      url: "https://cdn.jsdelivr.net/gh/mozilla/pdf.js@v6.4.299/web/annotation_layer_builder.css",
      file: "pdfjs/annotation_layer_builder.css",
      sha256: "5a692d678ff97932023adf101c9faae5a0fda623f341e6646b6dc9251e259ad8"
    }
  };
  for (const vendor of Object.values(foliateVendors)) Object.freeze(vendor);
  const readerFiles = Object.freeze([
    "reader-resources.js",
    "reader-engine-preload.js",
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
    "reader-v3.mjs",
    "reader-book-text.js",
    "reader-pdf-book-search-worker.mjs",
    "reader-pdf-book-search.mjs",
    "pdf-worker-wrapper.mjs",
    "reader-pdf-network.mjs",
    "reader-pdf-text-store.mjs",
    "reader.css",
    "reader.js"
  ]);
  const lazyFiles = new Set([
    "reader-pdf-text-store.mjs",
    "reader-chapter-search-worker.mjs",
    "reader-chapter-search.mjs",
    "reader-pdf-book-search-worker.mjs",
    "reader-pdf-book-search.mjs",
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
    foliateVendors: Object.freeze(foliateVendors),
    foliateRevision: "78914aef4466eb960965702401634c2cb348e9b1",
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
