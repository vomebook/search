export function createReaderDocxFormat(readerContext) {
  async function renderDocx(prepared) {
    const bytes = await readerContext.readPreparedBytes(prepared.response, prepared.engines);
    readerContext.assertReaderActive();
    VoiceOfMLReaderSecurity.inspectZip(bytes, {
      ...VoiceOfMLReaderSecurity.LIMITS,
      archiveCompressedBytes: VoiceOfMLReaderSecurity.LIMITS.documentBytes
    });
    const styles = document.createElement("div");
    styles.className = "docx-styles";
    const body = document.createElement("div");
    body.className = "docx-body";
    readerContext.content.append(styles, body);
    const options = {
      className: "reader-docx",
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      useBase64URL: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderChanges: false,
      renderComments: false,
      renderAltChunks: false,
      debug: false
    };
    const docxDocument = await readerContext.awaitReader(docx.parseAsync(bytes, options));
    readerContext.assertReaderActive();
    const urls = new Set(), urlsByPath = new Map(), contentTypes = docxDocument.contentTypes || [];
    let released = false;
    const release = () => {
      released = true;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      urlsByPath.clear();
    };
    const untrack = readerContext.trackReaderResource(release);
    readerContext.memoizeDocxAssets(docxDocument, () => released);
    // Own this parsed document's images, fonts and numbering assets only.
    docxDocument.blobToURL = (blob, path) => {
      if (released || !blob) return null;
      if (path && urlsByPath.has(path)) return urlsByPath.get(path);
      const type = path && contentTypes.find(entry => entry.partName === path ||
        (entry.extension && path.endsWith(`.${entry.extension}`)));
      const url = URL.createObjectURL(type ? new Blob([blob], {type:type.contentType}) : blob);
      if (typeof url === "string" && url.startsWith("blob:")) {
        urls.add(url);
        if (path) urlsByPath.set(path, url);
      }
      return url;
    };
    try {
      const nodes = await readerContext.awaitReader(docx.renderDocument(docxDocument, options));
      readerContext.assertReaderActive();
      for (const node of nodes) (node.nodeName === "STYLE" ? styles : body).appendChild(node);
    } catch (error) {
      release();
      untrack();
      throw error;
    }
    readerContext.assertReaderActive();
    body.classList.toggle("reader-document-dark", readerContext.readerTheme === "dark");
    if (!(body.textContent || "").trim() && !body.querySelector("img, table, svg, canvas")) {
      release();
      untrack();
      throw new Error("DOCX rendered no supported content");
    }
    const pages = [...body.querySelectorAll(":scope > .reader-docx-wrapper > section.reader-docx")];
    readerContext.docxPageNodes = pages;
    if (pages.length) {
      readerContext.updateDocumentState({ pageCount: pages.length });
      readerContext.pageInput.max = String(readerContext.documentState.pageCount);
      document.querySelector("#page-total").textContent = `/ ${readerContext.documentState.pageCount}`;
      document.querySelector(".page-controls").hidden = false;
      pages.forEach((page, index) => {
        page.classList.add("reader-docx-page");
        page.dataset.page = String(index + 1);
        page.style.setProperty("--reader-docx-height", page.style.minHeight || page.style.height || "1123px");
      });
      readerContext.setToc(readerContext.headingTocEntries(body));
    }
    for (const link of body.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") || "";
      if (!href.startsWith("#") && !/^https?:\/\//i.test(href)) link.removeAttribute("href");
      else if (!href.startsWith("#")) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    }
    readerContext.markReaderContentReady();
    readerContext.status.textContent = readerContext.documentState.pageCount ? `${readerContext.documentState.pageCount} 页` : "DOCX";
  }

  function memoizeDocxResource(load, keyFor, isReleased) {
    const pending = new Map();
    return (...args) => {
      if (isReleased()) return Promise.resolve(null);
      const key = keyFor(...args);
      if (!key) return load(...args);
      if (!pending.has(key)) {
        const task = Promise.resolve().then(() => isReleased() ? null : load(...args));
        pending.set(key, task);
        task.catch(() => { if (pending.get(key) === task) pending.delete(key); });
      }
      return pending.get(key);
    };
  }

  function memoizeDocxAssets(doc, isReleased) {
    if (typeof doc.getPathById !== "function") return;
    for (const [name, part] of [["loadDocumentImage", "documentPart"],
      ["loadNumberingImage", "numberingPart"], ["loadFont", "fontTablePart"]]) {
      if (typeof doc[name] !== "function") continue;
      const original = doc[name].bind(doc);
      doc[name] = readerContext.memoizeDocxResource(original, (id, parameter) => {
        const path = doc.getPathById(name === "loadDocumentImage" ? parameter || doc[part] : doc[part], id);
        return path ? (name === "loadFont" ? `${path}\u0000${parameter}` : path) : null;
      }, isReleased);
    }
  }

  return {
    renderDocx,
    memoizeDocxResource,
    memoizeDocxAssets
  };
}
