import { bindReaderScrollIntent } from "../core/reader-bindings.mjs";
import { HTML_PROSE_STYLE, wrapEbookTables } from "../ui/reader-document-styles.mjs";

/** @param {string | null | undefined} markdown */
export function stripMarkdownFrontMatter(markdown) {
  // Marxists-Library Markdown carries YAML metadata for EPUB generation and
  // source provenance. It is not article text; remove only a leading, keyed
  // block so a body that starts with a horizontal rule is left untouched.
  const text = String(markdown ?? "").replace(/^\uFEFF/, "");
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match?.[1] || !/^[A-Za-z][\w-]*[ \t]*:/m.test(match[1])) return text;
  return text.slice(match[0].length);
}

/** @param {import('../../../typings/reader-html-format-strict').HtmlFormatContext} readerContext */
export function createReaderHtmlFormat(readerContext) {
  /** @param {Document} doc */
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

  /** @param {Document} doc */
  function sanitizeReaderDocument(doc) {
    const blocked = "script,iframe,object,embed,base,form";
    for (const node of doc.querySelectorAll(blocked)) node.remove();
    // SMIL can retarget a link's href after sanitizing; drop animations that do.
    for (const node of doc.querySelectorAll("*")) {
      if (!SVG_ANIMATION_ELEMENTS.has(String(node.localName || "").toLowerCase())) continue;
      const target = String(node.getAttribute("attributeName") || "").toLowerCase();
      if (/(?:^|:)href$/.test(target.trim()) || target.trim().startsWith("on")) node.remove();
    }
    for (const link of doc.querySelectorAll("link")) {
      const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
      if (!rel.includes("stylesheet") || rel.includes("alternate") ||
          !/^blob:/i.test(link.getAttribute("href") || ""))
        link.remove();
    }
    for (const style of doc.querySelectorAll("style"))
      style.textContent = sanitizeCssReferences(style.textContent || "");
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
  // Offline HTML may embed only inline images and link within its own document.
  // Ordinary attributes (colspan, width, lang...) keep DOMPurify defaults.
  const OFFLINE_URL_ATTRIBUTES = new Set([
    "href", "xlink:href", "src", "srcset", "poster", "action", "formaction", "background",
    "cite", "data", "longdesc", "ping", "usemap", "codebase", "manifest", "lowsrc", "dynsrc"
  ]);
  const OFFLINE_INLINE_IMAGE = /^data:image\/(?:gif|png|jpeg|webp|svg\+xml);/i;
  /** @param {string | null} value */
  function isLocalFragment(value) {
    return !!value && value.startsWith("#") && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
  }

  /** @param {Element} node @param {{attrName: string, attrValue: string, keepAttr: boolean}} data */
  function restrictOfflineUrlAttribute(node, data) {
    if (data.attrName === "href" && node.localName === "a" && isLocalFragment(data.attrValue)) return;
    if (OFFLINE_URL_ATTRIBUTES.has(data.attrName) &&
        !OFFLINE_INLINE_IMAGE.test(String(data.attrValue || "").replace(/[\u0000-\u0020\u007f-\u009f]/g, "")))
      data.keepAttr = false;
  }

  /** @param {MouseEvent} event */
  function clickedLink(event) {
    return /** @type {HTMLAnchorElement | null | undefined} */ (/** @type {Element | null} */ (event.target)?.closest?.("a[href]"));
  }

  /** @param {HTMLElement | Document} root @param {string} fragment @param {MouseEvent} event */
  function jumpWithoutHistory(root, fragment, event) {
    // Never let a nested document navigate, even for a missing fragment. A
    // child fragment traversal joins the tab's history and consumes its Back.
    event.preventDefault();
    let name = fragment.slice(1);
    try { name = decodeURIComponent(name); } catch (_) {}
    const target = [...root.querySelectorAll("[id]")].find(node => node.id === name) ||
      [...root.querySelectorAll("a[name]")].find(node => node.getAttribute("name") === name);
    if (target) {
      readerContext.beginReaderNavigation(event);
      target.scrollIntoView({ block: "start" });
    } else if (!name || name.toLowerCase() === "top") {
      readerContext.beginReaderNavigation(event);
      if ("scrollingElement" in root) root.defaultView?.scrollTo(0, 0);
      else root.scrollIntoView({ block: "start" });
    }
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

  /** @param {number} code */
  function cssNameChar(code) {
    return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x5f || code >= 0x80;
  }

  /** @param {number} code */
  function cssWhitespace(code) {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
  }

  // Resource policy: fragments, blob:, data: and same-origin relative paths only.
  // data: cannot fetch, blob: is an unguessable same-origin object, and any scheme
  // (https:, javascript:, file:...) or protocol-relative reference is rejected
  // after control/whitespace normalization, matching URL parser leniency.
  /** @param {string | null} raw @param {{strict?: boolean}} [options] */
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
  /** @param {string | null} source @param {import('../../../typings/reader-html-format-strict').CssOptions} [options] */
  function scanCss(source, { strict = false } = {}) {
    const css = String(source || "");
    const length = css.length;
    /** @type {[number, number, string][]} */
    const edits = [];
    /** @type {{start: number, name: string, reference: boolean, unsafe: boolean}[]} */
    const stack = [];
    let i = 0, customValueDepth = -1;
    // Offline HTML historically deletes references; EPUB styles keep a valid
    // `none` so shorthand declarations stay parseable.
    const removed = strict ? "" : "none";

    const readEscape = () => {
      // css[i] is a backslash that is not followed by a newline.
      i++;
      if (i >= length) return "\ufffd";
      let hex = "";
      while (hex.length < 6 && i < length && /[0-9a-f]/i.test(css.charAt(i))) hex += css[i++];
      if (hex) {
        if (i < length && css[i] === "\r" && css[i + 1] === "\n") i += 2;
        else if (i < length && cssWhitespace(css.charCodeAt(i))) i++;
        const code = parseInt(hex, 16);
        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          ? "\ufffd" : String.fromCodePoint(code);
      }
      const char = String.fromCodePoint(css.codePointAt(i) ?? 0xfffd);
      i += char.length;
      return char;
    };
    /** @param {number} at */
    const validEscape = (at) => css[at] === "\\" && at + 1 < length && !/[\n\r\f]/.test(css.charAt(at + 1));
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
          if (/[\n\r\f]/.test(css.charAt(i + 1))) { i += 2; continue; }
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
    /** @param {number} start */
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
      skipAtRule();
      const value = target === null ? "" : target.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
      // Only same-origin relative sheets may be imported in non-strict mode.
      const relative = !!value && !/^(?:blob|data):/i.test(value) && !value.startsWith("#") &&
        safeCssReference(value);
      if (strict || !relative) edits.push([start, i, ""]);
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

  /** @param {string | null} css @param {import('../../../typings/reader-html-format-strict').CssOptions} [options] */
  function sanitizeCssReferences(css, options = {}) {
    return scanCss(css, options);
  }

  /** @param {Document} doc */
  function sanitizeEpubDocument(doc) {
    return sanitizeReaderDocument(normalizeEpubDocument(doc));
  }

  /** @param {string} text */
  function parseChapterDocument(text) {
    // Parse generated XHTML before HTML's void-element rules can swallow children
    // of prefixed elements such as <html:meta/> (including the following title).
    const xml = new DOMParser().parseFromString(text, "application/xhtml+xml");
    if (!xml.querySelector("parsererror"))
      text = new XMLSerializer().serializeToString(normalizeEpubDocument(xml));
    return sanitizeEpubDocument(new DOMParser().parseFromString(text, "text/html"));
  }

  /** @param {URL} url @param {URL | null} base */
  function readerMarkdownLink(url, base) {
    try {
      if (url.protocol !== "https:" || !["huggingface.co", "hf-mirror.com"].includes(url.hostname) ||
          url.username || url.password || url.port || url.search ||
          !/^\/datasets\/VoiceOfML\/[^/]+\/(?:resolve|raw)\/[^/]+\/.+/.test(url.pathname)) return null;
      const filename = decodeURIComponent(url.pathname.split("/").pop() || "");
      const match = /\.([a-z0-9]+)$/i.exec(filename);
      const ext = match?.[1]?.toLowerCase();
      if (!ext || VoiceOfMLReader.capability(ext).readerMode !== VoiceOfMLReader.ReaderMode.ORIGINAL) return null;
      const fragment = url.hash;
      if (fragment && !["md", "markdown"].includes(ext)) return null;
      url = new URL(url.href);
      url.hash = "";
      if (base) {
        const baseFile = new URL(base.href);
        baseFile.hash = "";
        if (fragment && url.href === baseFile.href) return fragment;
      }
      const reader = new URL(location.pathname, location.origin);
      reader.searchParams.set("url", url.href);
      reader.searchParams.set("ext", ext);
      reader.hash = fragment;
      return reader.href;
    } catch (_) {
      return null;
    }
  }

  /** @param {HTMLElement} article */
  function prepareMarkdownLinks(article) {
    // Cache-backed text still resolves relative links against the original file.
    /** @type {URL | null} */
    let base = null;
    try { base = new URL(readerContext.downloadUrl || readerContext.sourceUrl); } catch (_) {}
    const readerLinks = new WeakSet();
    for (const link of article.querySelectorAll("a[href]")) {
      const value = (link.getAttribute("href") || "").trim();
      if (isLocalFragment(value)) continue;
      const relative = !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
      let destination = null;
      if (value && !/[\u0000-\u001f\u007f-\u009f\\]/.test(value)) {
        try {
          const url = base ? new URL(value, base) : new URL(value);
          if (/^https?:$/.test(url.protocol) && !url.username && !url.password &&
              (!relative || url.origin === base?.origin)) destination = url;
        } catch (_) {}
      }
      const target = destination && !link.hasAttribute("download") ? readerMarkdownLink(destination, base) : null;
      if (target) {
        link.setAttribute("href", target);
        if (!target.startsWith("#")) readerLinks.add(link);
      } else if (relative) {
        if (destination) link.setAttribute("href", destination.href);
        else link.removeAttribute("href");
      }
    }
    article.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = clickedLink(event);
      if (!link || !article.contains(link) || link.hasAttribute("download") ||
          (link.target && link.target.toLowerCase() !== "_self") || !readerContext.isReaderOverlayFrame()) return;
      const href = (link.getAttribute("href") || "").trim();
      if (isLocalFragment(href)) {
        jumpWithoutHistory(article, href, event);
        return;
      }
      if (!readerLinks.has(link)) return;
      try {
        const target = new URL(link.href);
        if (target.origin !== location.origin || target.pathname !== location.pathname || !target.searchParams.has("url")) return;
        // The overlay host replaces the child Reader and updates its own URL.
        event.preventDefault();
        readerContext.navigateReader(target.href);
      } catch (_) {}
    });
  }

  /** @param {HTMLElement} article */
  function wrapMarkdownSpacing(article) {
    // Some prose transcriptions use runs of ideographic spaces as table
    // alignment. Expose wrap points for those runs without changing the text,
    // soft breaks elsewhere, or the whitespace of actual code and tables.
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node; (node = /** @type {Text | null} */ (walker.nextNode()));) {
      if (!/\u3000{4}/u.test(node.data) || node.parentElement?.closest("pre,code,table,style,textarea,svg,math")) continue;
      const fragment = document.createDocumentFragment();
      let start = 0;
      for (const match of node.data.matchAll(/\u3000{4,}/gu)) {
        fragment.append(node.data.slice(start, match.index));
        const run = document.createElement("span");
        run.className = "reader-markdown-spacing";
        run.textContent = match[0];
        fragment.append(run);
        start = match.index + match[0].length;
      }
      const tail = document.createTextNode(node.data.slice(start));
      fragment.append(tail);
      node.replaceWith(fragment);
      walker.currentNode = tail;
    }
  }

  /** @param {boolean} markdown @param {import('../../../typings/reader-html-format-strict').PreparedText} prepared */
  async function renderText(markdown, prepared) {
    let response = await prepared.response;
    if (!response.ok) response = await readerContext.fetchReaderResponse();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!markdown) {
      await readerContext.renderPlainText(response);
    } else {
      const bytes = await readerContext.readPreparedBytes(response, prepared.engines);
      const text = new TextDecoder(readerContext.detectTextEncoding(bytes, readerContext.documentState.title)).decode(bytes);
      const article = document.createElement("article");
      article.className = "reader-markdown";
      // Reuse the sanitized nodes instead of serializing them and reparsing
      // the entire article before the first paint.
      article.appendChild(DOMPurify.sanitize(marked.parse(stripMarkdownFrontMatter(text)), {
        USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true
      }));
      if (/\u3000{4}/u.test(text)) wrapMarkdownSpacing(article);
      prepareMarkdownLinks(article);
      wrapEbookTables(article);
      readerContext.content.appendChild(article);
      readerContext.setToc(readerContext.headingTocEntries(article));
    }
    readerContext.markReaderContentReady();
    readerContext.status.textContent = "已加载";
  }

  /** @param {string} text */
  function sanitizeOfflineHtml(text) {
    // A global ALLOWED_URI_REGEXP would also strip every non-allow-listed plain
    // attribute (colspan/rowspan/width), so scope the inline-image rule to URLs.
    // Use the original document URL, not the proxy, srcdoc, or a supplied <base>.
    /** @type {URL | null} */
    let base = null;
    try {
      const original = new URL(readerContext.downloadUrl || readerContext.sourceUrl);
      if (/^https?:$/.test(original.protocol) && !original.username && !original.password) {
        original.hash = "";
        base = original;
      }
    } catch (_) {}
    // Converted documents can link to hundreds of fragments in the same file.
    // Cache only the document match, with bounded keys and a fixed base per book.
    /** @type {Map<string, boolean>} */
    const documentMatches = new Map();
    /** @param {Element} node @param {{attrName: string, attrValue: string, keepAttr: boolean}} data */
    const restrict = (node, data) => {
      if (base && data.attrName === "href" && node.localName === "a") {
        const value = data.attrValue, hashIndex = value.indexOf("#");
        if (hashIndex > 0 && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value) &&
            !/[\u0000-\u001f\u007f-\u009f\\]/.test(value)) {
          const key = hashIndex <= 256 ? value.slice(0, hashIndex) : null;
          let matches = key === null ? undefined : documentMatches.get(key);
          if (matches === undefined) {
            matches = false;
            try {
              // Resolve with the fragment present: otherwise trailing spaces in
              // the path/query could be trimmed before comparing the full URL.
              const target = new URL(value, base);
              target.hash = "";
              matches = target.href === base.href;
            } catch (_) {}
            if (key !== null && documentMatches.size < 128) documentMatches.set(key, matches);
          }
          if (matches) data.attrValue = value.slice(hashIndex);
        }
      }
      restrictOfflineUrlAttribute(node, data);
    };
    DOMPurify.addHook("uponSanitizeAttribute", restrict);
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
      DOMPurify.removeHook("uponSanitizeAttribute", restrict);
    }
    const template = document.createElement("template");
    template.content.appendChild(clean);
    /** @param {string | null} value */
    const stripUrls = (value) => sanitizeCssReferences(value, { strict: true });
    for (const style of template.content.querySelectorAll("style")) {
      const value = style.textContent, stripped = stripUrls(value);
      if (stripped !== value) style.textContent = stripped;
    }
    // Converted tables and documents repeat inline declarations. Strict CSS
    // stripping depends only on the exact attribute text, not the element.
    // Bound both the entry count and the size of cached declarations per document.
    /** @type {Map<string, string>} */
    const inlineStyles = new Map();
    for (const element of template.content.querySelectorAll("[style]")) {
      const value = element.getAttribute("style") || "";
      const cacheable = value.length <= 256;
      let stripped = cacheable ? inlineStyles.get(value) : undefined;
      if (stripped === undefined) {
        stripped = stripUrls(value);
        if (cacheable && inlineStyles.size < 128) inlineStyles.set(value, stripped);
      }
      if (stripped !== value) element.setAttribute("style", stripped);
    }
    return template.innerHTML;
  }

  /** @param {string} text */
  function buildDiscourseDocument(text) {
    // The class may be case-insensitive in quirks mode or contain numeric
    // character references. Let the HTML parser decide either case.
    if (!/post-stream/i.test(text) && !text.includes("&#")) return null;
    try {
      const source = new DOMParser().parseFromString(text, "text/html");
      if (!source.querySelector(".post-stream")) return null;
      const posts = [...source.querySelectorAll(readerContext.DISCOURSE_POST_SELECTOR)];
      if (!posts.length) return null;
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

  /** @param {string} text */
  function prepareHtmlDocument(text) {
    const discourse = buildDiscourseDocument(text);
    const html = sanitizeOfflineHtml(discourse || text);
    return {
      html,
      discourse: !!discourse,
      spreadsheet: !discourse && html.includes("reader-spreadsheet-sheet")
    };
  }

  /** @param {import('../../../typings/reader-html-format-strict').HtmlDocumentData} documentData */
  function buildHtmlFrameSource(documentData) {
    // A CSP <meta> only applies as a <head> child, so it must precede any body
    // content; the remaining frame styles keep their later cascade position.
    const frameStyle = readerContext.HTML_FRAME_STYLE;
    const policyEnd = frameStyle.startsWith('<meta http-equiv="Content-Security-Policy"') ? frameStyle.indexOf(">") + 1 : 0;
    return frameStyle.slice(0, policyEnd) + documentData.html +
      (documentData.discourse ? readerContext.DISCOURSE_HTML_STYLE : "") +
      (documentData.spreadsheet ? frameStyle.slice(policyEnd) + readerContext.SPREADSHEET_HTML_STYLE : HTML_PROSE_STYLE);
  }

  /** @param {HTMLIFrameElement} frame */
  async function waitForSpreadsheetImages(frame) {
    if (frame.contentDocument)
      await readerContext.settleReaderImages(frame.contentDocument, 30000);
  }

  /** @param {import('../../../typings/reader-html-format-strict').PreparedHtml} prepared */
  async function renderHtml(prepared) {
    const bytes = await readerContext.readPreparedBytes(prepared.response, prepared.engine);
    const text = new TextDecoder(detectHtmlEncoding(bytes, readerContext.documentState.title)).decode(bytes);
    readerContext.assertReaderActive();
    const documentData = prepareHtmlDocument(text);
    const frame = document.createElement("iframe");
    readerContext.htmlFrame = frame;
    frame.className = "html-frame";
    readerContext.content.classList.toggle("reader-content--spreadsheet", documentData.spreadsheet);
    if (documentData.spreadsheet) frame.classList.add("spreadsheet-html-frame");
    frame.title = `${readerContext.documentState.title} 正文`;
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("referrerpolicy", "no-referrer");
    if (documentData.spreadsheet) frame.style.colorScheme = "only light";
    const frameLoaded = /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
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
          const doc = frame.contentDocument;
          if (!documentData.spreadsheet) {
            doc.documentElement.dataset.readerTheme = document.documentElement.dataset.theme || "dark";
            wrapEbookTables(doc.body);
            normalizeHtmlIndent(doc);
          }
          readerContext.repairHtmlContrast(frame);
          doc.documentElement.style.zoom = String(readerContext.documentState.zoom);
          /** @type {Window} */ (frame.contentWindow).addEventListener("scroll", readerContext.handleReaderPositionChange, {
            passive: true
          });
           doc.addEventListener("keydown", readerContext.handleReaderKeydown);
           /** @param {MouseEvent} event */
           const jump = (event) => {
             const href = clickedLink(event)?.getAttribute("href")?.trim() || "";
             if (!event.defaultPrevented && isLocalFragment(href)) jumpWithoutHistory(doc, href, event);
           };
           doc.addEventListener("click", jump);
           doc.addEventListener("auxclick", jump);
           doc.addEventListener("click", readerContext.handleReaderOutsideClick);
           readerContext.trackReaderResource(() => {
             doc.removeEventListener("click", jump);
             doc.removeEventListener("auxclick", jump);
             doc.removeEventListener("click", readerContext.handleReaderOutsideClick);
           });
          readerContext.installReaderTapSelectionClear(frame.contentDocument.body, frame.contentDocument);
          // Input in the srcdoc does not bubble into the Reader viewport.
          bindReaderScrollIntent(doc.documentElement, event => readerContext.beginReaderNavigation(event));
          readerContext.setToc(readerContext.headingTocEntries(frame.contentDocument));
          if (documentData.spreadsheet) {
            // The sanitized cells are already readable. Let them take the
            // loading indicator's space before charts have finished decoding.
            // The full startup/restore path still waits for stable geometry.
            readerContext.markReaderContentReady();
            await waitForSpreadsheetImages(frame);
          }
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
    }));
    frame.srcdoc = buildHtmlFrameSource(documentData);
    readerContext.content.appendChild(frame);
    await frameLoaded;
    readerContext.markReaderContentReady();
     readerContext.status.textContent = documentData.spreadsheet ? "表格" : "HTML";
  }

  /** @param {Document} doc */
  function normalizeHtmlIndent(doc) {
    // Legacy exports use literal full-width spaces to indent lines after BR.
    // Never touch runs in the middle of prose, preformatted code, or tables.
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const blocks = /^(?:body|p|div|section|article|li|blockquote|h[1-6])$/;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      const value = node.nodeValue || "";
      const indent = /^[\t\r\n ]*(?:\u3000[ \t]*){3,}(?=\S)/.exec(value);
      if (!indent || parent?.closest("pre,code,kbd,samp,table,style,textarea")) continue;
      // Ascend through wrappers only while at their first visible child.
      let leading = false;
      for (let sibling = node; sibling.parentElement; sibling = sibling.parentElement) {
        let previous = sibling.previousSibling;
        while (previous?.nodeType === Node.COMMENT_NODE ||
               (previous?.nodeType === Node.TEXT_NODE && !previous.textContent?.trim())) previous = previous.previousSibling;
        if (previous) {
          leading = previous.nodeName === "BR";
          break;
        }
        if (blocks.test(sibling.parentElement.localName)) {
          leading = true;
          break;
        }
      }
      if (leading) node.nodeValue = "\u3000\u3000" + value.slice(indent[0].length);
    }
  }

  /** @param {Uint8Array} bytes @param {string} [hint] */
  function detectHtmlEncoding(bytes, hint = "") {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
    const probe = String.fromCharCode(...bytes.subarray(0, 8192));
    if (/<meta\b/i.test(probe)) {
      // Parse only the bounded probe in inert template contents. Comments,
      // ordinary attributes and raw script/style text are not declarations.
      const template = document.createElement("template");
      template.innerHTML = probe;
      for (const meta of template.content.querySelectorAll("meta")) {
        if (meta.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
        const declared = meta.getAttribute("charset") ||
          (meta.getAttribute("http-equiv")?.trim().toLowerCase() === "content-type" &&
            /(?:^|;)\s*charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i.exec(meta.getAttribute("content") || "")?.[1]);
        if (!declared) continue;
        const value = declared.trim().toLowerCase();
        try {
          return new TextDecoder(/^(?:gb2312|gb-2312|gbk|x-gbk)$/.test(value) ? "gb18030" : value).encoding;
        } catch (_) {}
      }
    }
    return readerContext.detectTextEncoding(bytes, hint);
  }

  /** @type {WeakMap<Document, Map<HTMLElement, [string, string, string]>>} */
  const contrastEdits = new WeakMap();

  /** @param {HTMLIFrameElement} frame */
  function repairHtmlContrast(frame) {
    const doc = frame.contentDocument;
    if (!doc || !doc.body || !frame.contentWindow) return;
    const frameWindow = frame.contentWindow;
    /** @param {string} value @returns {[number, number, number, number] | null} */
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
    /** @param {[number, number, number, number]} color */
    const luminance = (color) => {
      const channels = color.slice(0, 3).map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      const [red = 0, green = 0, blue = 0] = channels;
      return red * 0.2126 + green * 0.7152 + blue * 0.0722;
    };
    // Undo only the preceding pass's edits, then recompute against the new paper.
    let repaired = contrastEdits.get(doc);
    if (repaired) for (const [element, [value, priority, replacement]] of repaired) {
      if (element.style.color === replacement && element.style.getPropertyPriority("color") === "important")
        element.style.setProperty("color", value, priority);
    }
    repaired = new Map();
    contrastEdits.set(doc, repaired);
    // Repeated computed color strings (e.g. inherited prose colors) have the
    // same metrics even after a repair changes which strings CSS returns.
    /** @type {Map<string, {light: number, alpha: number, rgb: [number, number, number, number]} | null>} */
    const colors = new Map();
    /** @param {string} value */
    const colorMetrics = (value) => {
      const cached = colors.get(value);
      if (cached !== undefined) return cached;
      const color = parseColor(value);
      const metrics = color && { light: luminance(color), alpha: color[3], rgb: color };
      if (colors.size < 128) colors.set(value, metrics);
      return metrics;
    };
    /** @type {Map<Element, {rgb: [number, number, number, number], light: number}>} */
    const backgrounds = new Map();
    /** @param {HTMLElement} element @param {CSSStyleDeclaration} style */
    const background = (element, style) => {
      const pending = [];
      /** @type {{rgb: [number, number, number, number], light: number}} */
      let resolved = { rgb: [255, 255, 255, 1], light: 1 };
      for (let current = /** @type {HTMLElement | null} */ (element); current; current = current.parentElement) {
        const cached = backgrounds.get(current);
        if (cached !== undefined) {
          resolved = cached;
          break;
        }
        const color = colorMetrics((current === element ? style :
          frameWindow.getComputedStyle(current)).backgroundColor);
        if (color?.alpha === 1) {
          resolved = color;
          backgrounds.set(current, resolved);
          break;
        }
        pending.push({ current, color });
      }
      for (let entry = pending.pop(); entry; entry = pending.pop()) {
        const { current, color } = entry;
        if (color && color.alpha > 0) {
          const { alpha, rgb: [r, g, b] } = color;
          const [br, bg, bb] = resolved.rgb;
          /** @type {[number, number, number, number]} */
          const rgb = [r * alpha + br * (1 - alpha), g * alpha + bg * (1 - alpha), b * alpha + bb * (1 - alpha), 1];
          resolved = { rgb, light: luminance(rgb) };
        }
        backgrounds.set(current, resolved);
      }
      return resolved.light;
    };
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    /** @type {Set<HTMLElement>} */
    const elements = new Set();
    while (walker.nextNode() && elements.size < 10000) {
      const node = walker.currentNode;
      if (node.textContent?.trim() && node.parentElement) elements.add(node.parentElement);
    }
    for (const element of elements) {
      const style = frameWindow.getComputedStyle(element);
      const foreground = colorMetrics(style.color);
      const dark = background(element, style);
      if (!foreground || foreground.alpha === 0) continue;
      const light = foreground.light;
      const contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
      if (contrast < 3) {
        const original = [element.style.color, element.style.getPropertyPriority("color")];
        element.style.setProperty("color", dark > 0.45 ? "#111" : "#f5f5f5", "important");
        repaired.set(element, [original[0] || "", original[1] || "", element.style.color]);
        // Inherited color and currentColor backgrounds can change after a repair.
        backgrounds.clear();
      }
    }
  }

  return {
    sanitizeCssReferences,
    parseChapterDocument,
    renderText,
    renderHtml,
    repairHtmlContrast
  };
}
