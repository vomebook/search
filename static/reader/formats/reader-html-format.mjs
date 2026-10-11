export function createReaderHtmlFormat(readerContext) {
  function normalizeEpubDocument(doc) {
    // Legacy CHM conversions can use an XHTML prefix even in HTML content.
    for (const element of [...doc.querySelectorAll("*")]) {
      const tagName = String(element.tagName || "").toLowerCase();
      const localName = tagName.includes(":") ? tagName.slice(tagName.lastIndexOf(":") + 1) : tagName;
      if (tagName === localName || !readerContext.EPUB_HTML_TAGS.has(localName)) continue;
      const replacement = doc.createElementNS("http://www.w3.org/1999/xhtml", localName);
      for (const attribute of [...element.attributes]) {
        if (!attribute.name.toLowerCase().startsWith("xmlns:"))
          replacement.setAttribute(attribute.name, attribute.value);
      }
      // HTML parsing treats prefixed void tags as containers. Keep the following
      // content as siblings: serializing real <br>/<hr>/<img> drops their children.
      // Move the existing text nodes so Foliate's source/CFI mapping stays intact.
      const fragment = doc.createDocumentFragment();
      fragment.appendChild(replacement);
      if (readerContext.EPUB_HTML_VOID_TAGS.has(localName)) {
        while (element.firstChild) fragment.appendChild(element.firstChild);
      } else {
        while (element.firstChild) replacement.appendChild(element.firstChild);
      }
      element.replaceWith(fragment);
    }
    return doc;
  }

  function sanitizeReaderDocument(doc, { preserveEpubStyles = false } = {}) {
    const blocked = preserveEpubStyles
      ? "script,iframe,object,embed,base,form"
      : "script,iframe,object,embed,base,form,link,style";
    for (const node of doc.querySelectorAll(blocked)) node.remove();
    if (preserveEpubStyles) {
      for (const link of doc.querySelectorAll("link")) {
        const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
        if (!rel.includes("stylesheet") || !/^blob:/i.test(link.getAttribute("href") || ""))
          link.remove();
      }
      for (const style of doc.querySelectorAll("style")) {
        if (
          /(?:@import\s+|url\s*\(\s*[\"']?)(?:https?:|\/\/|javascript:)/i.test(
            style.textContent || ""
          )
        )
          style.remove();
      }
    }
    for (const element of doc.querySelectorAll("*"))
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase(),
          value = String(attribute.value || "").trim();
        if (
          name.startsWith("on") ||
          name === "srcdoc" ||
          ((name === "href" || name === "xlink:href" || name === "src") &&
            /^javascript:/i.test(value))
        )
          element.removeAttribute(attribute.name);
      }
    return doc;
  }

  function sanitizeEpubDocument(doc) {
    return readerContext.sanitizeReaderDocument(readerContext.normalizeEpubDocument(doc), { preserveEpubStyles: true });
  }

  function parseChapterDocument(text) {
    // Parse generated XHTML before HTML's void-element rules can swallow children
    // of prefixed elements such as <html:meta/> (including the following title).
    const xml = new DOMParser().parseFromString(text, "application/xhtml+xml");
    if (!xml.querySelector("parsererror"))
      text = new XMLSerializer().serializeToString(readerContext.normalizeEpubDocument(xml));
    return readerContext.sanitizeEpubDocument(new DOMParser().parseFromString(text, "text/html"));
  }

  function epubContentBody(doc) {
    const nestedBody = [...doc.querySelectorAll("body")].find((body) => body !== doc.body);
    return nestedBody || doc.body || doc.documentElement;
  }

  async function renderText(markdown, prepared) {
    let response = await prepared.response;
    if (!response.ok) response = await readerContext.fetchReaderResponse();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!markdown) await readerContext.renderPlainText(response);
    else {
      const bytes = await readerContext.readPreparedBytes(response, prepared.engines);
      const text = new TextDecoder(readerContext.detectTextEncoding(bytes, readerContext.documentState.title)).decode(bytes);
      const article = document.createElement("article");
      article.className = "reader-markdown";
      article.innerHTML = DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true } });
      readerContext.content.appendChild(article);
      readerContext.setToc(readerContext.headingTocEntries(article));
    }
    readerContext.markReaderContentReady();
    readerContext.status.textContent = "已加载";
  }

  function sanitizeOfflineHtml(text) {
    const clean = DOMPurify.sanitize(text, {
      USE_PROFILES: { html: true },
      ADD_TAGS: ["style"],
      FORBID_TAGS: ["base", "embed", "form", "iframe", "object", "script"],
      FORBID_ATTR: ["action", "formaction", "srcdoc"],
       ALLOWED_URI_REGEXP: /^data:image\/(?:gif|png|jpeg|webp|svg\+xml);/i
    });
    const template = document.createElement("template");
    template.innerHTML = clean;
    const stripUrls = (value) => value.replace(/@import[^;]+;|url\s*\([^)]*\)/gi, "");
    for (const style of template.content.querySelectorAll("style"))
      style.textContent = stripUrls(style.textContent);
    for (const element of template.content.querySelectorAll("[style]"))
      element.setAttribute("style", stripUrls(element.getAttribute("style")));
    return template.innerHTML;
  }

  function buildDiscourseDocument(text) {
    try {
      const source = new DOMParser().parseFromString(text, "text/html");
      const posts = [...source.querySelectorAll(readerContext.DISCOURSE_POST_SELECTOR)];
      if (!source.querySelector(".post-stream") || !posts.length) return null;
      const article = source.createElement("article");
      article.className = "reader-forum-document";
      const titleNode = source.querySelector(readerContext.DISCOURSE_TITLE_SELECTOR);
      const title = titleNode?.textContent?.trim();
      if (title) {
        const heading = source.createElement("h1");
        heading.textContent = title;
        article.appendChild(heading);
      }
      posts.forEach((post, index) => {
        const section = source.createElement("section");
        section.className = "reader-forum-post";
        section.dataset.post = String(index + 1);
        section.innerHTML = post.innerHTML;
        article.appendChild(section);
      });
      return article.outerHTML;
    } catch (_) {
      return null;
    }
  }

  function prepareHtmlDocument(text) {
    const discourse = readerContext.buildDiscourseDocument(text);
    const html = readerContext.sanitizeOfflineHtml(discourse || text);
    return {
      html,
      discourse: !!discourse,
      spreadsheet: !discourse && html.includes("reader-spreadsheet-sheet")
    };
  }

  function buildHtmlFrameSource(documentData) {
    return documentData.html + readerContext.HTML_FRAME_STYLE +
      (documentData.discourse ? readerContext.DISCOURSE_HTML_STYLE : "") +
      (documentData.spreadsheet ? readerContext.SPREADSHEET_HTML_STYLE : "");
  }

  async function waitForSpreadsheetImages(frame) {
    if (frame.contentDocument)
      await readerContext.settleReaderImages(frame.contentDocument, 30000);
  }

  async function renderHtml(prepared) {
    const bytes = await readerContext.readPreparedBytes(prepared.response, prepared.engine);
    const text = new TextDecoder(readerContext.detectHtmlEncoding(bytes, readerContext.documentState.title)).decode(bytes);
    readerContext.assertReaderActive();
    const documentData = readerContext.prepareHtmlDocument(text);
    const frame = document.createElement("iframe");
    readerContext.htmlFrame = frame;
    frame.className = "html-frame";
    readerContext.content.classList.toggle("reader-content--spreadsheet", documentData.spreadsheet);
    if (documentData.spreadsheet) frame.classList.add("spreadsheet-html-frame");
    frame.title = `${readerContext.documentState.title} 正文`;
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.style.colorScheme = "only light";
    const frameLoaded = new Promise((resolve, reject) => {
      let untrack = () => {}, frameTimer = 0, deadline = 0, started = false;
      const cleanup = () => {
        clearTimeout(frameTimer);
        clearTimeout(deadline);
        frame.removeEventListener("load", loaded);
        untrack();
      };
      const loaded = async () => {
        if (started || frame.contentDocument?.URL !== "about:srcdoc" || frame.contentDocument.readyState === "loading") return;
        started = true;
        cleanup();
        try {
          readerContext.assertReaderActive();
          readerContext.repairHtmlContrast(frame);
          frame.contentDocument.documentElement.style.zoom = String(readerContext.documentState.zoom);
          frame.contentWindow.addEventListener("scroll", readerContext.handleReaderPositionChange, {
            passive: true
          });
          frame.contentDocument.addEventListener("keydown", readerContext.handleReaderKeydown);
          readerContext.installReaderTapSelectionClear(frame.contentDocument.body, frame.contentDocument);
          for (const type of ["wheel", "touchstart", "pointerdown"])
            frame.contentDocument.addEventListener(type, readerContext.beginReaderNavigation, { passive: true });
          readerContext.setToc(readerContext.headingTocEntries(frame.contentDocument));
          if (documentData.spreadsheet) await readerContext.waitForSpreadsheetImages(frame);
          readerContext.assertReaderActive();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      untrack = readerContext.trackReaderResource(() => {
        cleanup();
        reject(readerContext.readerAbortError());
      });
      const poll = () => {
        if (started) return;
        loaded();
        if (!started) frameTimer = setTimeout(poll, 16);
      };
      frameTimer = setTimeout(poll, 0);
      deadline = setTimeout(() => { cleanup(); reject(new Error("HTML document initialization timeout")); }, 20000);
      frame.addEventListener("load", loaded);
    });
    frame.srcdoc = readerContext.buildHtmlFrameSource(documentData);
    readerContext.content.appendChild(frame);
    await frameLoaded;
    readerContext.markReaderContentReady();
     readerContext.status.textContent = documentData.spreadsheet ? "表格" : "HTML";
  }

  function detectHtmlEncoding(bytes, hint = "") {
    const probe = String.fromCharCode(...bytes.subarray(0, 8192));
    const match = probe.match(/charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i);
    if (match) {
      const label =
        { gb2312: "gb18030", "gb-2312": "gb18030", gbk: "gb18030", "x-gbk": "gb18030" }[
          match[1].toLowerCase()
        ] || match[1];
      try {
        new TextDecoder(label);
        return label;
      } catch (_) {}
    }
    return readerContext.detectTextEncoding(bytes, hint);
  }

  function repairHtmlContrast(frame) {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    const parseColor = (value) => {
      const parts = String(value).match(/[\d.]+/g);
      return parts && parts.length >= 3
        ? [
            Number(parts[0]),
            Number(parts[1]),
            Number(parts[2]),
            parts[3] === undefined ? 1 : Number(parts[3])
          ]
        : null;
    };
    const luminance = (color) => {
      const channels = color.slice(0, 3).map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const backgrounds = new Map();
    const background = (element, style) => {
      const pending = [];
      let light = 1;
      for (let current = element; current; current = current.parentElement) {
        if (backgrounds.has(current)) {
          light = backgrounds.get(current);
          break;
        }
        pending.push(current);
        const color = parseColor((current === element ? style :
          frame.contentWindow.getComputedStyle(current)).backgroundColor);
        if (color && color[3] > 0.1) {
          light = luminance(color);
          break;
        }
      }
      for (const current of pending) backgrounds.set(current, light);
      return light;
    };
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const elements = new Set();
    while (walker.nextNode() && elements.size < 10000)
      if (walker.currentNode.data.trim()) elements.add(walker.currentNode.parentElement);
    for (const element of elements) {
      const style = frame.contentWindow.getComputedStyle(element);
      const foreground = parseColor(style.color);
      const dark = background(element, style);
      if (!foreground) continue;
      const light = luminance(foreground);
      const contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
      if (contrast < 3) {
        element.style.setProperty("color", dark > 0.45 ? "#111" : "#f5f5f5", "important");
        // Inherited color and currentColor backgrounds can change after a repair.
        backgrounds.clear();
      }
    }
  }

  return {
    normalizeEpubDocument,
    sanitizeReaderDocument,
    sanitizeEpubDocument,
    parseChapterDocument,
    epubContentBody,
    renderText,
    sanitizeOfflineHtml,
    buildDiscourseDocument,
    prepareHtmlDocument,
    buildHtmlFrameSource,
    waitForSpreadsheetImages,
    renderHtml,
    detectHtmlEncoding,
    repairHtmlContrast
  };
}
