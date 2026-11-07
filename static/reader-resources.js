(function (root) {
  "use strict";
  // Canonical resource inventory for runtime, warming, caching and static builds.
  /** @type {Record<string, {url: string, file: string, sha256: string, path?: string}>} */
  const vendors = {
    pdf: {
      url: "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.min.mjs",
      file: "pdf.min.mjs",
      sha256: "3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440"
    },
    pdfWorker: {
      url: "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.worker.min.mjs",
      file: "pdf.worker.min.mjs",
      sha256: "1e64c8240e54735ec5913b37acd5134747799cb8c6bb3777c70adbc01232d2aa"
    },
    pdfWorkerSource: {
      url: "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.worker.mjs",
      file: "pdf.worker.mjs",
      sha256: "43710009ea26bfbcb615524946e46e3aaf8ad927514f5e465e8ff6d18044ffe9"
    },
    marked: {
      url: "https://cdn.jsdelivr.net/npm/marked@18.1.2/lib/marked.umd.js",
      file: "marked.min.js",
      sha256: "9eb730d2362ae1a8c6201698f17009e16671be6946d3d06503ddc0575283db7c"
    },
    purify: {
      url: "https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.min.js",
      file: "purify.min.js",
      sha256: "cd37898f9782adf54820c413191b5691803f0f137c799d6edcfd38523b4c2c31"
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
    url: "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.5.438.tgz",
    sha256: "7461aefcd27c4ef0dd76f9ca5760f09466eb6b3f934432670c12132e7b3d6faa"
  });
  const foliateRevision = "78914aef4466eb960965702401634c2cb348e9b1";
  const foliateArchive = Object.freeze({
    url: `https://codeload.github.com/johnfactotum/foliate-js/tar.gz/${foliateRevision}`,
    sha256: "4878cd5f04073af5046ea543da73a963a7f9e1a4b30ddc63ac86cea5adf02f38"
  });
  const foliateFiles = Object.freeze([
    "LICENSE", "comic-book.js", "epub.js", "epubcfi.js", "fb2.js", "fixed-layout.js",
    "mobi.js", "overlayer.js", "paginator.js", "pdf.js", "progress.js", "reader.html",
    "reader.js", "search.js", "text-walker.js", "tts.js", "ui/menu.js", "ui/tree.js", "view.js"
  ]);
  const foliateVendors = {
    fflateLicense: {
      url: "https://cdn.jsdelivr.net/npm/fflate@0.8.3/LICENSE",
      file: "LICENSE_fflate",
      sha256: "0a1df3a083d0c010560aa342e87959c8c1070e6fd54545741f083f22d0c8b551"
    },
    zipLicense: {
      url: "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.24.0/LICENSE",
      file: "LICENSE_zipjs",
      sha256: "1b7ebc8d7889ed25491484ab2b102370742ca6c0b26650a0c62cc2269b579b84"
    },
    fflate: {
      url: "https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js",
      file: "fflate.js",
      sha256: "b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1"
    },
    zip: {
      url: "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.24.0/index.min.js",
      file: "zip.js",
      sha256: "6c13caf4b90e08323f404f596c51549cdc6b01010bd43935a0bdc6a25bd61021"
    },
    textLayer: {
      url: "https://cdn.jsdelivr.net/gh/mozilla/pdf.js@v6.5.438/web/text_layer_builder.css",
      file: "pdfjs/text_layer_builder.css",
      sha256: "5b21bcb7d703cae5b8eebf9c8579435409aaf351b62e7518327ada60bdd0946f"
    },
    annotationLayer: {
      url: "https://cdn.jsdelivr.net/gh/mozilla/pdf.js@v6.5.438/web/annotation_layer_builder.css",
      file: "pdfjs/annotation_layer_builder.css",
      sha256: "eb7905a0db3e35b4a069c7ba47048fc131ccc2eccc8c4205e4e20dac58c80176"
    }
  };
  for (const vendor of Object.values(foliateVendors)) Object.freeze(vendor);
  const readerComponentFiles = Object.freeze([
    "reader/core/reader-diagnostics.mjs", "reader/core/reader-lifecycle.mjs", "reader/core/reader-source.mjs", "reader/ui/reader-ui.mjs",
    "reader/ui/reader-toc.mjs", "reader/search/reader-search-backends.mjs", "reader/pdf/reader-pdf-scheduler.mjs", "reader/ui/reader-navigation.mjs",
    "reader/formats/reader-foliate-format.mjs", "reader/ui/reader-progress.mjs", "reader/ui/reader-bookmarks.mjs", "reader/formats/reader-media-format.mjs",
    "reader/core/reader-document-loader.mjs", "reader/pdf/reader-pdf-page-window.mjs", "reader/pdf/reader-pdf-text-runtime.mjs",
    "reader/formats/reader-html-format.mjs", "reader/pdf/reader-pdf-renderer.mjs", "reader/formats/reader-text-format.mjs",
    "reader/formats/reader-chapter-format.mjs", "reader/formats/reader-format-controller.mjs",
    "reader/pdf/reader-pdf-engine.mjs", "reader/pdf/reader-pdf-search.mjs", "reader/core/reader-bindings.mjs", "reader/ui/reader-document-styles.mjs",
    "reader/ui/reader-speech.mjs"
  ]);
  const readerFiles = Object.freeze([
    "reader-resources.js",
    "reader/pdf/pdf-first-page-worker-adapter.mjs",
    "reader/pdf/pdf-worker-wrapper.mjs",
    "reader/pdf/reader-engine-preload.js",
    "reader/search/workers/reader-chapter-search-worker.mjs",
    "reader/search/reader-chapter-search.mjs",
    "reader/core/reader-contract.js",
    "search/reader-navigation.js",
    "reader/core/reader-store.js",
    "reader/core/reader-request-manager.js",
    "reader/formats/reader-chapter-repository.js",
    "reader/ui/reader-scroll-anchor.js",
    "reader/formats/reader-section-virtualizer.js",
    "reader/core/reader-runtime.js",
    "reader/formats/reader-format-adapters.js",
    "reader/core/reader-security.js",
    "reader/pdf/reader-djvu-engine-worker.mjs",
    "reader/pdf/reader-djvu-worker.mjs",
    "reader/pdf/reader-djvu-scheduler.mjs",
    "reader/pdf/reader-djvu-adapter.mjs",
    "reader/pdf/reader-djvu-range.mjs",
    "reader/pdf/reader-djvu-loader.mjs",
    "reader/search/reader-search-controller.mjs",
    "reader/search/reader-dom-search.mjs",
    "reader/formats/reader-image-loader.mjs",
    "reader/pdf/reader-pdf-text.js",
    "reader/pdf/reader-v3.mjs",
    "reader/search/reader-book-text.js",
    "reader/search/workers/reader-pdf-book-search-worker.mjs",
    "reader/search/reader-pdf-book-search.mjs",
    "reader/pdf/reader-pdf-range-cache.mjs",
    "reader/pdf/reader-pdf-range-hints.mjs",
    "reader/pdf/reader-pdf-network.mjs",
    "reader/pdf/reader-pdf-text-store.mjs",
    "tts-client.js",
    "reader.css",
    ...readerComponentFiles,
    "reader/reader-components.mjs",
    "reader.js"
  ]);
  const lazyFiles = new Set([
    ...readerComponentFiles,
    "reader/reader-components.mjs",
    "reader/pdf/reader-pdf-text-store.mjs",
    "reader/pdf/reader-djvu-engine-worker.mjs",
    "reader/pdf/reader-djvu-worker.mjs",
    "reader/pdf/reader-djvu-scheduler.mjs",
    "reader/pdf/reader-djvu-adapter.mjs",
    "reader/pdf/reader-djvu-loader.mjs",
    "reader/pdf/reader-djvu-range.mjs",
    "reader/search/workers/reader-chapter-search-worker.mjs",
    "reader/search/reader-chapter-search.mjs",
    "reader/search/workers/reader-pdf-book-search-worker.mjs",
    "reader/search/reader-pdf-book-search.mjs",
    "reader/pdf/pdf-first-page-worker-adapter.mjs",
    "reader/pdf/pdf-worker-wrapper.mjs"
  ]);
  /** @param {string} name @param {string} base */
  const vendorUrl = (name, base) => base + vendors[name].path;
  /** @param {string} base */
  const runtimePaths = (base) => readerFiles.map((file) => base + file);
  /** @param {string} base */
  const shellAssets = (base) =>
    ["reader.html", ...readerFiles.filter((file) => !lazyFiles.has(file))].map((file) => base + file);
  // Extracted unchanged from the checksum-pinned PDF.js archive above.
  /** @param {string} base */
  const pdfSupportAssets = (base) => [base + "vendor/wasm/qcms_bg.wasm"];
  /** @param {string} base */
  const djvuDecoderAssets = (base) => ["scalar/djvu_rs.js", "scalar/djvu_rs_bg.wasm",
    "simd128/djvu_rs.js", "simd128/djvu_rs_bg.wasm"].map(file =>
      base + "vendor/djvu-rs-reader/release-a23e0b3e3a44-025029b02a7c/" + file);
  /** @param {string} extension @param {string} base @param {string} [foliateSuffix] @param {string} [workerWrapper] @returns {string[]} */
  function engineAssets(extension, base, foliateSuffix = "", workerWrapper = base + "reader/pdf/pdf-worker-wrapper.mjs") {
    if (extension === "pdf")
      return [
        vendorUrl("pdf", base),
        workerWrapper,
        vendorUrl("pdfWorker", base)
      ];
    // view.js statically imports these leaf modules; warm them with it so they
    // are not discovered one round trip later. Format modules follow makeBook.
    /** @param {...string} files */
    const foliate = (...files) => [base + "foliate-reader/view.js" + foliateSuffix,
      ...["epubcfi.js", "progress.js", "overlayer.js", "text-walker.js", ...files].map(file => base + "foliate-reader/" + file)];
    if (extension === "epub") return foliate("vendor/zip.js", "epub.js", "paginator.js");
    if (["mobi", "azw", "azw3"].includes(extension)) return foliate("mobi.js", "vendor/fflate.js", "paginator.js");
    if (extension === "fb2") return foliate("fb2.js", "paginator.js");
    if (extension === "fbz") return foliate("vendor/zip.js", "fb2.js", "paginator.js");
    if (["md", "markdown"].includes(extension))
      return [vendorUrl("marked", base), vendorUrl("purify", base)];
    if (["html", "htm"].includes(extension)) return [vendorUrl("purify", base)];
    return [];
  }
  /** @param {string} project */
  function buildFiles(project) {
    return [
      ...readerFiles,
      "search/search-session.js",
      "search/download-controller.js",
      "search/size-format.js",
      "search/record-path.js",
      "search/highlight.js",
      "search/response-cache.js",
      "search/file-types.js",
      "search/response-validation.js",
      "search/result-identity.js",
      "search/folder-selection.js",
      "style.css",
      ...(project === "github" ? ["search/index-worker.js"] : []),
      "app.js"
    ];
  }
  /** @param {string} filename */
  function bundleArguments(filename) {
    if (!["reader.js", "reader/reader-components.mjs"].includes(filename)) return [];
    const external = readerFiles.filter(file => !readerComponentFiles.includes(file) &&
      !["reader.js", "reader/reader-components.mjs"].includes(file) && /\.(?:js|mjs)$/.test(file));
    return ["--bundle", "--format=esm", "--external:/static/*", "--external:/search/static/*",
      ...external.map(file => "--external:./" + file)];
  }
  const resources = Object.freeze({
    vendors: Object.freeze(vendors),
    foliateVendors: Object.freeze(foliateVendors),
    foliateRevision,
    foliateArchive,
    foliateFiles,
    pdfArchive,
    readerFiles,
    readerComponentFiles,
    vendorUrl,
    runtimePaths,
    shellAssets,
    pdfSupportAssets,
    djvuDecoderAssets,
    engineAssets,
    buildFiles,
    bundleArguments
  });
  if (typeof module !== "undefined" && module.exports) module.exports = resources;
  else root.VoiceOfMLReaderResources = resources;
})(typeof self !== "undefined" ? self : globalThis);
