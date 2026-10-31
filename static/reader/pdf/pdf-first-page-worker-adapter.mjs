// Reader-only adapter for the pinned, uncompressed PDF.js 6.4.299 worker.
// The upstream bundle retains its Apache-2.0 license notice. Refuse to patch
// different bytes or unexpected source instead of weakening validation.
const MAX_BYTES = 3 * 1024 * 1024;

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0)
    throw new Error(`PDF_PREVIEW_WORKER_VERSION_MISMATCH:${label}`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function makeFirstPageWorkerSource(source) {
  if (typeof source !== "string" || !source.includes('const workerVersion = "6.4.299";'))
    throw new Error("PDF_PREVIEW_WORKER_VERSION_MISMATCH:version");
  source = replaceOnce(source,
    `for (let last = kids.length - 1; last >= 0; last--) {
        const lastKid = kids[last];`,
    `// During the bounded validation message, request sibling dictionaries
      // together. Do not prefetch descendants or page image streams.
      if (this.readerValidationPrefetch && kids.length <= 4096) {
        for (const kid of kids) {
          if (kid instanceof Ref && !pageDictCache.has(kid)) {
            const pending = xref.fetchAsync(kid);
            pending.catch(() => {});
            this.readerValidationPromises.push(pending);
            pageDictCache.put(kid, pending);
          }
        }
      }
      for (let last = kids.length - 1; last >= 0; last--) {
        const lastKid = kids[last];`, "validation-prefetch");
  source = replaceOnce(source,
    `async initDocument(recoveryMode) {
    await this.ensureDoc("checkHeader");
    await this.ensureDoc("parseStartXRef");
    await this.ensureDoc("parse", [recoveryMode]);
    await this.ensureDoc("checkFirstPage", [recoveryMode]);
    await this.ensureDoc("checkLastPage", [recoveryMode]);
  }`,
    `async initDocument(recoveryMode, readerFirstPage = false) {
    await this.ensureDoc("checkHeader");
    await this.ensureDoc("parseStartXRef");
    await this.ensureDoc("parse", [recoveryMode]);
    if (!readerFirstPage) await this.ensureDoc("checkFirstPage", [recoveryMode]);
    if (!readerFirstPage) await this.ensureDoc("checkLastPage", [recoveryMode]);
  }`, "initialization");
  source = replaceOnce(source,
    `async checkLastPage(recoveryMode = false) {
    const {`,
    `async readerInstallPageTree(pagesTree, provisional = false) {
    const { catalog, pdfManager } = this;
    this.#pagePromises.clear();
    catalog.pageKidsCountCache.clear();
    catalog.pageIndexCache.clear();
    for (const [pageIndex, [pageDict, ref]] of pagesTree) {
      const promise = pageDict instanceof Error ? Promise.reject(pageDict) : Promise.resolve(new Page({
        pdfManager, xref: this.xref, pageIndex, pageDict, ref,
        globalIdFactory: this._globalIdFactory, fontCache: catalog.fontCache,
        builtInCMapCache: catalog.builtInCMapCache, standardFontDataCache: catalog.standardFontDataCache,
        globalColorSpaceCache: catalog.globalColorSpaceCache, globalImageCache: catalog.globalImageCache,
        systemFontCache: catalog.systemFontCache, nonBlendModesSet: catalog.nonBlendModesSet, xfaFactory: null
      }));
      promise.catch(() => {});
      this.#pagePromises.set(pageIndex, promise);
      if (ref instanceof Ref) catalog.pageIndexCache.put(ref, pageIndex);
    }
    if (!provisional) {
      catalog.setActualNumPages(pagesTree.size);
      delete this.numPages;
    }
  }
  async checkLastPage(recoveryMode = false) {
    const {`, "install-page-tree");
  source = replaceOnce(source,
    `this.#pagePromises.clear();
    catalog.pageKidsCountCache.clear();`,
    `if (!provisional) {
      for (const [index, expected] of pagesTree) {
        const cached = this.#pagePromises.get(index);
        if (!cached) continue;
        const page = await cached;
        const ref = expected[1];
        if (!(page.ref instanceof Ref) || !(ref instanceof Ref) || page.ref.toString() !== ref.toString())
          throw new Error("PDF_PAGE_IDENTITY_CHANGED");
      }
    }
    this.#pagePromises.clear();
    catalog.pageKidsCountCache.clear();`, "page-identity-check");
  source = replaceOnce(source,
    'const workerHandlerName = docId + "_worker";\n    let handler = new MessageHandler(workerHandlerName, docId, port);',
    'const workerHandlerName = docId + "_worker";\n    let readerCountPending = false;\n    let handler = new MessageHandler(workerHandlerName, docId, port);', "document-state");
  source = replaceOnce(source,
    'await pdfManager.initDocument(recoveryMode);\n      const isPureXfa = await pdfManager.ensureDoc("isPureXfa");',
    `await pdfManager.initDocument(recoveryMode, !recoveryMode);
      readerCountPending = !recoveryMode;
      const isPureXfa = await pdfManager.ensureDoc("isPureXfa");
      const formInfo = await pdfManager.ensureDoc("formInfo");
      if ((isPureXfa || formInfo?.hasXfa) && !recoveryMode) {
        await pdfManager.ensureDoc("checkLastPage", [false]);
        readerCountPending = false;
      }`, "opening");
  source = replaceOnce(source,
    'function onSuccess(doc) {\n        ensureNotTerminated();\n        handler.send("GetDoc", {',
    `function onSuccess(doc) {
        ensureNotTerminated();
        if (readerCountPending) {
          doc.numPages = 1;
          doc.readerPageCountPending = true;
        }
        handler.send("GetDoc", {`, "document-result");
  source = replaceOnce(source,
    'handler.on("GetPage", async function ({\n      pageIndex\n    }) {',
    `let readerValidation = null, readerPrefix = null, readerPrefixWork = null;
    // Enumerate strictly from the left edge without using any subtree /Count.
    // Other siblings are not fetched, so this prefix can be used before full
    // validation. Pending UI must discard it if recovery changes identities.
    async function readerWalkPagePrefix(limit) {
      ensureNotTerminated();
      if (readerPrefix?.length >= limit) return readerPrefix.slice(0,limit).map(item => item.ref.toString());
      if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error("PDF_PREFIX_LIMIT");
      const manager = pdfManager, catalog = manager.pdfDocument.catalog, xref = catalog.xref;
      const stack = [{value:catalog.toplevelPagesDict, ref:null}], seenRefs = new Set(), seenDirect = new WeakSet(), pages = [];
      const root = catalog.readerPageTreeRootRef();
      if (root instanceof Ref) seenRefs.add(root.toString());
      let visited = 0;
      while (stack.length && pages.length < limit) {
        ensureNotTerminated();
        if (++visited > 10000) throw new Error("PDF_PREFIX_LIMIT");
        const {value, ref} = stack.pop();
        if (ref instanceof Ref) {
          if (seenRefs.has(ref.toString())) throw new Error("PDF_PAGE_TREE_CYCLE");
          seenRefs.add(ref.toString());
        }
        const obj = value instanceof Ref ? await xref.fetchAsync(value) : value;
        if (!(obj instanceof Dict) || seenDirect.has(obj)) throw new Error("PDF_PAGE_TREE_INVALID");
        seenDirect.add(obj);
        let type = obj.getRaw("Type");
        if (type instanceof Ref) type = await xref.fetchAsync(type);
        if (type != null && !isName(type, "Page") && !isName(type, "Pages")) throw new Error("PDF_PAGE_TREE_INVALID");
        if (isName(type, "Page") || !obj.has("Kids")) {
          if (!(ref instanceof Ref)) throw new Error("PDF_PAGE_TREE_DIRECT_PAGE");
          pages.push({ref, dict:obj});
          continue;
        }
        let kids = obj.getRaw("Kids");
        if (kids instanceof Ref) kids = await xref.fetchAsync(kids);
        if (!Array.isArray(kids) || kids.length > 100000) throw new Error("PDF_PAGE_TREE_INVALID");
        for (let index = kids.length - 1; index >= 0; index--) {
          const kid = kids[index]; stack.push({value:kid,ref:kid instanceof Ref ? kid : null});
        }
      }
      if (!pages.length) throw new Error("PDF_PAGE_TREE_EMPTY");
      if (readerPrefix && readerPrefix.some((item,index) => item.ref.toString() !== pages[index]?.ref.toString()))
        throw new Error("PDF_PREFIX_CHANGED");
      readerPrefix = pages;
      return pages.map(item => item.ref.toString());
    }
    handler.on("ReaderGetPagePrefix", function ({limit}) {
      if (readerValidation) return readerPrefix?.map(item => item.ref.toString()) || [];
      const previous = readerPrefixWork;
      readerPrefixWork = (async () => {
        if (previous) await previous;
        return readerWalkPagePrefix(limit);
      })();
      return readerPrefixWork;
    });
    // This concurrent walk never trusts /Count. Unsupported or corrupt trees
    // fail closed; PDF.js's normal recovery still runs for malformed xrefs.
    async function readerCollectPageTree(catalog) {
      const xref = catalog.xref, pending = [catalog.toplevelPagesDict];
      const fetchRef = async ref => {
        try { return await xref.fetchAsync(ref); }
        catch (reason) {
          if (reason instanceof MissingDataException || reason instanceof XRefEntryException || reason instanceof XRefParseException) throw reason;
          throw new Error("PDF_PAGE_TREE_INVALID");
        }
      };
      const seenRefs = new Set(), seenDirect = new WeakSet(), links = new WeakMap(), visitedDicts = [], ordered = [];
      const root = catalog.readerPageTreeRootRef();
      if (root instanceof Ref) seenRefs.add(root.toString());
      let nodes = 0;
      while (pending.length) {
        ensureNotTerminated();
        const level = pending.splice(0);
        for (const node of level) {
          if (!(node instanceof Dict) || seenDirect.has(node)) throw new Error("PDF_PAGE_TREE_INVALID");
          seenDirect.add(node);
          visitedDicts.push(node);
        }
        const children = await Promise.all(level.map(async node => {
          let kids = node.getRaw("Kids");
          if (kids instanceof Ref) kids = await fetchRef(kids);
          if (!Array.isArray(kids) || kids.length > 100000) throw new Error("PDF_PAGE_TREE_INVALID");
          const children = kids.map(kid => ({kid}));
          for (const child of children) {
            if (++nodes > 200000) throw new Error("PDF_PAGE_TREE_LIMIT");
            if (child.kid instanceof Ref) {
              const id = child.kid.toString();
              if (seenRefs.has(id)) throw new Error("PDF_PAGE_TREE_CYCLE");
              seenRefs.add(id);
            }
          }
          return children;
        }));
        const flat = children.flat();
        // Limit promises across the entire breadth level, not per branch.
        for (let start = 0; start < flat.length; start += 64) {
          ensureNotTerminated();
          await Promise.all(flat.slice(start,start+64).map(async item => {
              const kid = item.kid;
              const obj = kid instanceof Ref ? await fetchRef(kid) : kid;
              if (!(obj instanceof Dict)) throw new Error("PDF_PAGE_TREE_INVALID");
              let type = obj.getRaw("Type");
              if (type instanceof Ref) type = await fetchRef(type);
              if (type != null && !isName(type, "Page") && !isName(type, "Pages")) throw new Error("PDF_PAGE_TREE_INVALID");
              if (isName(type, "Page") || !obj.has("Kids")) {
                if (!(kid instanceof Ref)) throw new Error("PDF_PAGE_TREE_DIRECT_PAGE");
                item.page = [obj, kid];
                return;
              }
              item.branch = obj;
            }));
        }
        for (let i = 0; i < level.length; i++) {
          links.set(level[i], children[i]);
          for (const item of children[i]) {
            if (item.branch) pending.push(item.branch); else visitedDicts.push(item.page[0]);
          }
        }
      }
      const distinct = new WeakSet();
      for (const dict of visitedDicts) {
        if (distinct.has(dict)) throw new Error("PDF_PAGE_TREE_INVALID");
        distinct.add(dict);
      }
      const stack = [catalog.toplevelPagesDict];
      while (stack.length) {
        const item = stack.pop();
        if (item.page) { ordered.push(item.page); if (ordered.length > 100000) throw new Error("PDF_PAGE_TREE_LIMIT"); continue; }
        const children = links.get(item.branch || item);
        if (!children) throw new Error("PDF_PAGE_TREE_INVALID");
        for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
      }
      if (!ordered.length) throw new Error("PDF_PAGE_TREE_EMPTY");
      return new Map(ordered.map((page, index) => [index, page]));
    }
    handler.on("ReaderValidatePageCount", function () {
      if (readerValidation) return readerValidation;
      readerValidation = (async () => {
        ensureNotTerminated();
        const manager = pdfManager;
        // Give direct page demand a short bounded scheduling head start.
        if (readerPrefix?.length > 1) await new Promise(resolve => setTimeout(resolve, 350));
        ensureNotTerminated();
        const catalog = manager.pdfDocument.catalog;
        catalog.readerValidationPromises = [];
        catalog.readerValidationPrefetch = true;
        try {
          try {
            await manager.ensureDoc("checkLastPage", [false]);
          } catch (reason) {
            if (!(reason instanceof XRefParseException)) throw reason;
            await manager.requestLoadedStream();
            ensureNotTerminated();
            await manager.initDocument(true);
          }
          const results = await Promise.allSettled(catalog.readerValidationPromises);
          const failed = results.find(result => result.status === "rejected");
          if (failed) throw failed.reason;
        } finally {
          catalog.readerValidationPrefetch = false;
          catalog.readerValidationPromises = null;
        }
        ensureNotTerminated();
        // Finish any prefix installation before committing the authoritative map.
        if (readerInstallPrefix) await readerInstallPrefix;
        const pagesTree = await readerCollectPageTree(manager.pdfDocument.catalog);
        if (readerPrefix) {
          for (let index = 0; index < readerPrefix.length; index++) {
            const ref = pagesTree.get(index)?.[1];
            if (!(ref instanceof Ref) || ref.toString() !== readerPrefix[index].ref.toString())
              throw new Error("PDF_PREFIX_CHANGED");
          }
        }
        await manager.pdfDocument.readerInstallPageTree(pagesTree);
        delete manager.pdfDocument.numPages;
        const count = await manager.ensureDoc("numPages");
        if (!Number.isSafeInteger(count) || count < 1) throw new Error("PDF_PAGE_COUNT_INVALID");
        return {count, refs:readerPrefix?.map(item => item.ref.toString()) || []};
      })();
      return readerValidation;
    });
    let readerInstallPrefix = null;
    handler.on("ReaderInstallPagePrefix", function () {
      if (!readerPrefix) return {refs:[],firstChanged:false};
      if (readerValidation) return {refs:[],firstChanged:false};
      const previous = readerInstallPrefix;
      const installing = readerPrefix.slice();
      readerInstallPrefix = (async () => {
        if (previous) await previous;
        const map = new Map(installing.map((item,index) => [index,[item.dict,item.ref]]));
        await pdfManager.pdfDocument.readerInstallPageTree(map, true);
        return {refs:installing.map(item => item.ref.toString()), firstChanged:false};
      })();
      return readerInstallPrefix;
    });
    handler.on("GetPage", async function ({
      pageIndex
    }) {`, "validation-message");
  source = replaceOnce(source,
    `async getPageDict(pageIndex) {
    const nodesToVisit`,
    `readerPageTreeRootRef() { return this.#catDict.getRaw("Pages"); }
  async getPageDict(pageIndex) {
    const nodesToVisit`, "catalog-root-ref");
  source = replaceOnce(source,
    `handler.on("ReaderValidatePageCount", function () {`,
    `async function readerRecoverAndCollect(manager, reason) {
      if (!(reason instanceof XRefParseException || reason instanceof XRefEntryException)) throw reason;
      await manager.requestLoadedStream();
      ensureNotTerminated();
      await manager.initDocument(true);
      return readerCollectPageTree(manager.pdfDocument.catalog);
    }
    handler.on("ReaderValidatePageCount", function () {`, "collect-recovery");
  source = replaceOnce(source,
    `const pagesTree = await readerCollectPageTree(manager.pdfDocument.catalog);`,
    `let pagesTree;
        try { pagesTree = await readerCollectPageTree(manager.pdfDocument.catalog); }
        catch (reason) { pagesTree = await readerRecoverAndCollect(manager, reason); }`, "collect-recovery-call");
  return source;
}

export async function installFirstPageWorker(url, expectedDigest) {
  const owner = new AbortController();
  const timer = setTimeout(() => owner.abort(), 20000);
  try {
    const response = await fetch(url, {signal:owner.signal, credentials:"same-origin", cache:"force-cache"});
    if (!response.ok) throw new Error(`PDF_PREVIEW_WORKER_HTTP_${response.status}`);
    const encoded = response.headers.get("Content-Encoding");
    const declared = encoded && encoded !== "identity" ? 0 : Number(response.headers.get("Content-Length") || 0);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BYTES) throw new Error("PDF_PREVIEW_WORKER_SIZE");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("PDF_PREVIEW_WORKER_STREAM");
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("PDF_PREVIEW_WORKER_SIZE");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    if (!size || (declared && declared !== size)) throw new Error("PDF_PREVIEW_WORKER_SIZE");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    if (!/^[0-9a-f]{64}$/.test(expectedDigest || "") || digest !== expectedDigest)
      throw new Error("PDF_PREVIEW_WORKER_INTEGRITY");
    const source = makeFirstPageWorkerSource(new TextDecoder().decode(bytes));
    const blob = URL.createObjectURL(new Blob([source], {type:"text/javascript"}));
    try {
      const module = await import(blob);
      if (!module.WorkerMessageHandler) throw new Error("PDF_PREVIEW_WORKER_UNAVAILABLE");
      return module.WorkerMessageHandler;
    } finally { URL.revokeObjectURL(blob); }
  } finally { clearTimeout(timer); }
}
