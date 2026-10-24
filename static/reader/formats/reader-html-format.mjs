export function stripMarkdownFrontMatter(markdown) {
  // Marxists-Library Markdown carries YAML metadata for EPUB generation and
  // source provenance. It is not article text; remove only a leading, keyed
  // block so a body that starts with a horizontal rule is left untouched.
  const text = String(markdown ?? "").replace(/^\uFEFF/, "");
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match || !/^[A-Za-z][\w-]*[ \t]*:/m.test(match[1])) return text;
  return text.slice(match[0].length);
}

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

  function sanitizeReaderDocument(doc, { preserveEpubStyles = false, keepBlobImports = false } = {}) {
    const blocked = preserveEpubStyles
      ? "script,iframe,object,embed,base,form"
      : "script,iframe,object,embed,base,form,link,style";
    for (const node of doc.querySelectorAll(blocked)) node.remove();
    // SMIL can retarget a link's href after sanitizing; drop animations that do.
    for (const node of doc.querySelectorAll("*")) {
      if (!SVG_ANIMATION_ELEMENTS.has(String(node.localName || "").toLowerCase())) continue;
      const target = String(node.getAttribute("attributeName") || "").toLowerCase();
      if (/(?:^|:)href$/.test(target.trim()) || target.trim().startsWith("on")) node.remove();
    }
    if (preserveEpubStyles) {
      for (const link of doc.querySelectorAll("link")) {
        const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
        if (!rel.includes("stylesheet") || rel.includes("alternate") ||
            !/^blob:/i.test(link.getAttribute("href") || ""))
          link.remove();
      }
      for (const style of doc.querySelectorAll("style"))
        style.textContent = sanitizeCssReferences(style.textContent || "", { keepBlobImports });
    }
    for (const element of doc.querySelectorAll("*"))
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase(),
          value = String(attribute.value || "").trim(),
          // WHATWG URL parsing ignores ASCII whitespace/control characters
          // around and inside a scheme. Check a normalized copy, but retain
          // the original value for safe relative URLs.
          schemeValue = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
        // XHTML may bind the XLink namespace to any prefix (x:href), so match the
        // attribute's namespace and local name rather than its qualified name.
        const localName = String(attribute.localName || name).toLowerCase(),
          namespace = attribute.namespaceURI;
        const urlAttribute = (!namespace || namespace === XLINK_NAMESPACE) &&
          ["href", "src", "poster", "data"].includes(localName);
        if (
          name.startsWith("on") ||
          name === "srcdoc" ||
          (urlAttribute && /^(?:javascript|vbscript):/i.test(schemeValue))
        )
          element.removeAttributeNode(attribute);
        else if (CSS_VALUE_ATTRIBUTES.has(name)) {
          const clean = sanitizeCssReferences(attribute.value);
          if (clean !== attribute.value) element.setAttribute(attribute.name, clean);
        }
        // Legacy table/body background images fetch like url(); same policy.
        else if (name === "background" && !namespace && !safeCssReference(value))
          element.removeAttributeNode(attribute);
      }
    return doc;
  }

  const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
  const SVG_ANIMATION_ELEMENTS = new Set(["animate", "animatemotion", "animatetransform", "set", "discard"]);
  // Offline HTML may embed only inline images. Restrict URL-bearing attributes to
  // that rule; ordinary attributes (colspan, width, lang...) keep DOMPurify defaults.
  const OFFLINE_URL_ATTRIBUTES = new Set([
    "href", "xlink:href", "src", "srcset", "poster", "action", "formaction", "background",
    "cite", "data", "longdesc", "ping", "usemap", "codebase", "manifest", "lowsrc", "dynsrc"
  ]);
  const OFFLINE_INLINE_IMAGE = /^data:image\/(?:gif|png|jpeg|webp|svg\+xml);/i;
  function restrictOfflineUrlAttribute(_node, data) {
    if (OFFLINE_URL_ATTRIBUTES.has(data.attrName) &&
        !OFFLINE_INLINE_IMAGE.test(String(data.attrValue || "").replace(/[\u0000-\u0020\u007f-\u009f]/g, "")))
      data.keepAttr = false;
  }

  // Style attributes and SVG presentation attributes that accept CSS url().
  const CSS_VALUE_ATTRIBUTES = new Set([
    "style", "fill", "stroke", "filter", "mask", "clip-path",
    "marker-start", "marker-mid", "marker-end", "cursor"
  ]);
  // Functions whose string arguments are resource URLs (CSS Images 4/Fonts 4).
  const CSS_REFERENCE_FUNCTIONS = new Set([
    "url", "src", "image", "image-set", "-webkit-image-set", "cross-fade", "-webkit-cross-fade"
  ]);
  const CSS_BLOB_STYLESHEET_MAX_BYTES = 4 * 1024 * 1024;
  const CSS_IMPORT_MAX_DEPTH = 4;
  const CSS_IMPORT_MAX_PER_SHEET = 32;

  function cssNameChar(code) {
    return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x5f || code >= 0x80;
  }

  function cssWhitespace(code) {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
  }

  // Resource policy: fragments, blob:, data: and same-origin relative paths only.
  // data: cannot fetch, blob: is an unguessable same-origin object, and any scheme
  // (https:, javascript:, file:...) or protocol-relative reference is rejected
  // after control/whitespace normalization, matching URL parser leniency.
  function safeCssReference(raw, { strict = false } = {}) {
    if (strict) return false;
    const value = String(raw || "").replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
    if (!value || value.startsWith("#") || /^(?:blob|data):/i.test(value)) return true;
    if (/^[\\/]{2}/.test(value)) return false;
    return !/^[a-z][a-z0-9+.-]*:/i.test(value);
  }

  // Minimal CSS Syntax 3 scanner: decodes escapes and honours strings/comments
  // exactly where the browser does, so escaped names (`\75rl(`), comments
  // (`@import/**/"x"`) and quoted references cannot hide a remote fetch.
  // Unsafe url()/image-set()/image() become `none` ("" in strict mode), unsafe
  // custom-property URL strings become "", and unsafe
  // @import rules are removed. Everything else is copied byte-for-byte.
  function scanCss(source, { strict = false, keepBlobImports = false, blobImports = null, nonce = "" } = {}) {
    const css = String(source || "");
    const length = css.length;
    const edits = [];
    const stack = [];
    let i = 0, customValueDepth = -1, imports = 0;
    // Offline HTML historically deletes references; EPUB styles keep a valid
    // `none` so shorthand declarations stay parseable.
    const removed = strict ? "" : "none";

    const readEscape = () => {
      // css[i] is a backslash that is not followed by a newline.
      i++;
      if (i >= length) return "\ufffd";
      let hex = "";
      while (hex.length < 6 && i < length && /[0-9a-f]/i.test(css[i])) hex += css[i++];
      if (hex) {
        if (i < length && css[i] === "\r" && css[i + 1] === "\n") i += 2;
        else if (i < length && cssWhitespace(css.charCodeAt(i))) i++;
        const code = parseInt(hex, 16);
        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          ? "\ufffd" : String.fromCodePoint(code);
      }
      const char = String.fromCodePoint(css.codePointAt(i));
      i += char.length;
      return char;
    };
    const validEscape = (at) => css[at] === "\\" && at + 1 < length && !/[\n\r\f]/.test(css[at + 1]);
    const readName = () => {
      let name = "";
      while (i < length) {
        if (cssNameChar(css.charCodeAt(i))) name += css[i++];
        else if (validEscape(i)) name += readEscape();
        else break;
      }
      return name;
    };
    const readString = () => {
      const quote = css[i++];
      let value = "";
      while (i < length) {
        const char = css[i];
        if (char === quote) { i++; return value; }
        if (char === "\n" || char === "\r" || char === "\f") return value; // bad-string
        if (char === "\\") {
          if (i + 1 >= length) { i++; continue; }
          if (css[i + 1] === "\r" && css[i + 2] === "\n") { i += 3; continue; }
          if (/[\n\r\f]/.test(css[i + 1])) { i += 2; continue; }
          value += readEscape();
          continue;
        }
        value += char;
        i++;
      }
      return value;
    };
    const skipComment = () => {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? length : end + 2;
    };
    // Unquoted url( token; `i` is just after "(". Returns null for bad-url.
    const readUrlToken = () => {
      let value = "", bad = false;
      while (i < length) {
        const code = css.charCodeAt(i);
        if (css[i] === ")") { i++; return bad ? null : value; }
        if (cssWhitespace(code)) {
          while (i < length && cssWhitespace(css.charCodeAt(i))) i++;
          if (css[i] !== ")" && i < length) bad = true;
          continue;
        }
        if (css[i] === "\"" || css[i] === "'" || css[i] === "(" || code <= 0x08 ||
            code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
          bad = true; i++; continue;
        }
        if (css[i] === "\\") {
          if (validEscape(i)) value += readEscape();
          else { bad = true; i++; }
          continue;
        }
        value += css[i++];
      }
      return bad ? null : value;
    };
    // Skip to the end of an @import prelude (`;`) or past a stray `{...}` block.
    const skipAtRule = () => {
      let depth = 0;
      while (i < length) {
        const char = css[i];
        if (char === "/" && css[i + 1] === "*") { skipComment(); continue; }
        if (char === "\"" || char === "'") { readString(); continue; }
        if (char === "\\") { if (validEscape(i)) readEscape(); else i++; continue; }
        i++;
        if (char === "(" || char === "[" || char === "{") depth++;
        else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
        else if (char === "}") { if (--depth <= 0) return; }
        else if (char === ";" && depth === 0) return;
      }
    };
    const handleImport = (start) => {
      // `i` is just after "@import".
      let target = null, cursor;
      while (i < length) {
        if (cssWhitespace(css.charCodeAt(i))) { i++; continue; }
        if (css[i] === "/" && css[i + 1] === "*") { skipComment(); continue; }
        break;
      }
      if (css[i] === "\"" || css[i] === "'") target = readString();
      else {
        cursor = i;
        const name = cssNameChar(css.charCodeAt(i)) || validEscape(i) ? readName() : "";
        if (name.toLowerCase() === "url" && css[i] === "(") {
          i++;
          while (i < length && cssWhitespace(css.charCodeAt(i))) i++;
          if (css[i] === "\"" || css[i] === "'") {
            target = readString();
            while (i < length && cssWhitespace(css.charCodeAt(i))) i++;
            if (css[i] === ")") i++; else target = null;
          } else target = readUrlToken();
        } else i = cursor;
      }
      const conditionStart = i;
      skipAtRule();
      const end = i;
      const condition = css.slice(conditionStart, end).replace(/;\s*$/, "").trim();
      const value = target === null ? "" : target.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
      const blob = /^blob:/i.test(value);
      // Same-origin relative sheets are allowed; data: CSS is never imported.
      const relative = !!value && !blob && !/^data:/i.test(value) && !value.startsWith("#") &&
        safeCssReference(value);
      if (!strict && blob && blobImports && imports < CSS_IMPORT_MAX_PER_SHEET &&
          /^[\w\s(),:.\-]*$/.test(condition) && !/^(?:layer|supports)\b/i.test(condition)) {
        blobImports.push({ url: value, media: condition });
        edits.push([start, end, `/*${nonce}:${blobImports.length - 1}*/`]);
        imports++;
      } else if (strict || target === null || !(relative || (blob && keepBlobImports && !blobImports)))
        edits.push([start, end, ""]);
    };

    while (i < length) {
      const char = css[i], code = css.charCodeAt(i);
      if (char === "/" && css[i + 1] === "*") { skipComment(); continue; }
      if (char === "\"" || char === "'") {
        const start = i, value = readString();
        const frame = stack[stack.length - 1];
        // Custom properties can later be substituted into image-set()/image();
        // treat absolute or protocol-relative strings there as references.
        const reference = frame?.reference || (customValueDepth >= 0 &&
          /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "")));
        if (reference && !safeCssReference(value, { strict })) {
          if (frame?.reference) frame.unsafe = true;
          else edits.push([start, i, "\"\""]);
        }
        continue;
      }
      if (char === "@" && (cssNameChar(css.charCodeAt(i + 1)) || validEscape(i + 1))) {
        const start = i;
        i++;
        const name = readName().toLowerCase();
        if (name === "import" && !stack.length) handleImport(start);
        continue;
      }
      if (cssNameChar(code) || validEscape(i) ||
          (char === "-" && (cssNameChar(css.charCodeAt(i + 1)) || validEscape(i + 1)))) {
        const start = i, name = readName().toLowerCase();
        if (css[i] === "(") {
          i++;
          if (name === "url") {
            let probe = i;
            while (probe < length && cssWhitespace(css.charCodeAt(probe))) probe++;
            if (css[probe] !== "\"" && css[probe] !== "'") {
              i = probe;
              const value = readUrlToken();
              if (value === null || !safeCssReference(value, { strict })) {
                edits.push([start, i, removed]);
                const parent = stack[stack.length - 1];
                if (parent?.reference) parent.unsafe = true;
              }
              continue;
            }
          }
          stack.push({ start, name, reference: CSS_REFERENCE_FUNCTIONS.has(name), unsafe: false });
          continue;
        }
        if (name.startsWith("--") && customValueDepth < 0) {
          let probe = i;
          while (probe < length && cssWhitespace(css.charCodeAt(probe))) probe++;
          if (css[probe] === ":") { customValueDepth = stack.length; i = probe + 1; }
        }
        continue;
      }
      if (char === "\\") { i++; continue; } // invalid escape
      if (char === "(") { stack.push({ start: i, name: "", reference: false, unsafe: false }); i++; continue; }
      if (char === ")") {
        const frame = stack.pop();
        i++;
        if (frame?.unsafe) {
          edits.push([frame.start, i, removed]);
          const parent = stack[stack.length - 1];
          if (parent?.reference) parent.unsafe = true;
        }
        continue;
      }
      if ((char === ";" || char === "}") && customValueDepth >= 0 && stack.length <= customValueDepth) customValueDepth = -1;
      if (char === "{" || char === "}") stack.length = 0;
      i++;
    }
    for (const frame of stack) if (frame.unsafe) edits.push([frame.start, length, removed]);
    if (!edits.length) return css;
    edits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let output = "", cursor = 0;
    for (const [start, end, replacement] of edits) {
      if (start < cursor) continue; // nested inside an earlier replacement
      output += css.slice(cursor, start) + replacement;
      cursor = end;
    }
    return output + css.slice(cursor);
  }

  function sanitizeCssReferences(css, options = {}) {
    return scanCss(css, options);
  }

  async function readBlobStylesheet(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > CSS_BLOB_STYLESHEET_MAX_BYTES) return null;
      const blob = await response.blob();
      return blob.size > CSS_BLOB_STYLESHEET_MAX_BYTES ? null : await blob.text();
    } catch (_) {
      return null;
    }
  }

  // Replace blob @imports with their sanitized contents, preserving cascade
  // position and media conditions. Cycles, excessive depth and unreadable
  // sheets are dropped rather than loaded unsanitized.
  async function inlineCssImports(css, depth = 0, ancestors = new Set()) {
    const blobImports = [];
    const nonce = `reader-import-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const sanitized = scanCss(css, { blobImports, nonce });
    if (!blobImports.length) return sanitized;
    const bodies = await Promise.all(blobImports.map(async ({ url, media }) => {
      if (depth >= CSS_IMPORT_MAX_DEPTH || ancestors.has(url)) return "";
      const text = await readBlobStylesheet(url);
      if (text === null) return "";
      const body = (await inlineCssImports(text, depth + 1, new Set([...ancestors, url])))
        .replace(/^\ufeff/, "").replace(/^\s*@charset\s+"[^"]*"\s*;/i, "");
      return media && !/^all$/i.test(media) ? `@media ${media} {\n${body}\n}` : body;
    }));
    return sanitized.replace(new RegExp(`/\\*${nonce}:(\\d+)\\*/`, "g"), (_, index) => bodies[Number(index)] ?? "");
  }

  // Foliate rewrites chapter stylesheets to blob: URLs. Load them as sanitized
  // inline styles so remote references inside packaged CSS cannot escape the
  // archive-only resource policy. Results are cached per blob URL.
  const foliateStyleCache = new Map();
  const FOLIATE_STYLE_CACHE_MAX = 64;

  async function sanitizeFoliateStyles(nodes) {
    const output = [];
    for (const node of nodes) {
      if (node.localName === "link") {
        const href = node.getAttribute("href") || "";
        if (!/^blob:/i.test(href)) continue;
        let pending = foliateStyleCache.get(href);
        if (!pending) {
          pending = readBlobStylesheet(href).then(text => text === null ? null : inlineCssImports(text, 0, new Set([href])));
          pending.then(text => { if (text === null) foliateStyleCache.delete(href); });
          foliateStyleCache.set(href, pending);
          while (foliateStyleCache.size > FOLIATE_STYLE_CACHE_MAX)
            foliateStyleCache.delete(foliateStyleCache.keys().next().value);
        }
        const text = await pending;
        if (text === null) continue;
        const style = document.createElement("style");
        const media = node.getAttribute("media");
        if (media) style.setAttribute("media", media);
        style.textContent = text;
        output.push(style);
      } else {
        const style = node.cloneNode(false);
        style.textContent = await inlineCssImports(node.textContent || "");
        output.push(style);
      }
    }
    return output;
  }

  function sanitizeEpubDocument(doc, options = {}) {
    return readerContext.sanitizeReaderDocument(readerContext.normalizeEpubDocument(doc), { ...options, preserveEpubStyles: true });
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
      article.innerHTML = DOMPurify.sanitize(marked.parse(stripMarkdownFrontMatter(text)), { USE_PROFILES: { html: true } });
      readerContext.content.appendChild(article);
      readerContext.setToc(readerContext.headingTocEntries(article));
    }
    readerContext.markReaderContentReady();
    readerContext.status.textContent = "已加载";
  }

  function sanitizeOfflineHtml(text) {
    // A global ALLOWED_URI_REGEXP would also strip every non-allow-listed plain
    // attribute (colspan/rowspan/width), so scope the inline-image rule to URLs.
    DOMPurify.addHook("uponSanitizeAttribute", restrictOfflineUrlAttribute);
    let clean;
    try {
      clean = DOMPurify.sanitize(text, {
        USE_PROFILES: { html: true },
        RETURN_DOM_FRAGMENT: true,
        ADD_TAGS: ["style"],
        FORBID_TAGS: ["base", "embed", "form", "iframe", "object", "script"],
        FORBID_ATTR: ["action", "formaction", "srcdoc"]
      });
    } finally {
      DOMPurify.removeHook("uponSanitizeAttribute", restrictOfflineUrlAttribute);
    }
    const template = document.createElement("template");
    template.content.appendChild(clean);
    const stripUrls = (value) => sanitizeCssReferences(value, { strict: true });
    for (const style of template.content.querySelectorAll("style")) {
      const value = style.textContent, stripped = stripUrls(value);
      if (stripped !== value) style.textContent = stripped;
    }
    for (const element of template.content.querySelectorAll("[style]")) {
      const value = element.getAttribute("style"), stripped = stripUrls(value);
      if (stripped !== value) element.setAttribute("style", stripped);
    }
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
    // A CSP <meta> only applies as a <head> child, so it must precede any body
    // content; the remaining frame styles keep their later cascade position.
    const frameStyle = readerContext.HTML_FRAME_STYLE;
    const policyEnd = frameStyle.startsWith('<meta http-equiv="Content-Security-Policy"') ? frameStyle.indexOf(">") + 1 : 0;
    return frameStyle.slice(0, policyEnd) + documentData.html + frameStyle.slice(policyEnd) +
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
           const doc = frame.contentDocument;
           doc.addEventListener("click", readerContext.handleReaderOutsideClick);
           readerContext.trackReaderResource(() => doc.removeEventListener("click", readerContext.handleReaderOutsideClick));
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
    sanitizeCssReferences,
    sanitizeFoliateStyles,
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
