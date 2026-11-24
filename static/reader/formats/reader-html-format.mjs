import { bindReaderScrollIntent } from "../core/reader-bindings.mjs";
import { CLEAN_WEB_HTML_STYLE, HTML_PROSE_STYLE, LEGACY_ARTICLE_HTML_STYLE, PHPWIND_HTML_STYLE, wrapEbookTables } from "../ui/reader-document-styles.mjs";

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
      const tagName = element.tagName.toLowerCase();
      const localName = tagName.slice(tagName.lastIndexOf(":") + 1);
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
      if (!SVG_ANIMATION_ELEMENTS.has(node.localName.toLowerCase())) continue;
      const target = (node.getAttribute("attributeName") ?? "").trim();
      if (/(?:^on|(?:^|:)href$)/i.test(target)) node.remove();
    }
    for (const link of doc.querySelectorAll("link")) {
      const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
      if (!rel.includes("stylesheet") || rel.includes("alternate") ||
          !/^blob:/i.test(link.getAttribute("href") ?? ""))
        link.remove();
    }
    for (const style of doc.querySelectorAll("style"))
      style.textContent = sanitizeCssReferences(style.textContent);
    for (const element of doc.querySelectorAll("*"))
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase(),
          value = attribute.value.trim(),
          // WHATWG URL parsing ignores ASCII whitespace/control characters
          // around and inside a scheme. Check a normalized copy, but retain
          // the original value for safe relative URLs.
          schemeValue = normalizeCssReference(value);
        // XHTML may bind the XLink namespace to any prefix (x:href), so match the
        // attribute's namespace and local name rather than its qualified name.
        const localName = attribute.localName.toLowerCase(),
          namespace = attribute.namespaceURI;
        const urlAttribute = (!namespace || namespace === XLINK_NAMESPACE) &&
          ["href", "src", "poster", "data"].includes(localName);
        if (
          /^(?:on|srcdoc$)/.test(name) ||
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
    return /^#[^\u0000-\u001f\u007f-\u009f]*$/.test(value ?? "");
  }

  /** @param {Element} node @param {{attrName: string, attrValue: string, keepAttr: boolean}} data */
  function restrictOfflineUrlAttribute(node, data) {
    if (data.attrName === "href" && node.localName === "a" && isLocalFragment(data.attrValue)) return;
    if (OFFLINE_URL_ATTRIBUTES.has(data.attrName) &&
        !OFFLINE_INLINE_IMAGE.test(normalizeCssReference(data.attrValue)))
      data.keepAttr = false;
  }

  /** @param {MouseEvent} event */
  function clickedLink(event) {
    return /** @type {HTMLAnchorElement | null | undefined} */ (/** @type {Element | null} */ (event.target)?.closest?.("a[href]"));
  }

  /** @param {string} fragment */
  function fragmentName(fragment) {
    const name = fragment.slice(1);
    try { return decodeURIComponent(name); } catch (_) { return name; }
  }

  /** @param {HTMLElement | Document} root @param {string} fragment @param {MouseEvent} event */
  function jumpWithoutHistory(root, fragment, event) {
    // Never let a nested document navigate, even for a missing fragment. A
    // child fragment traversal joins the tab's history and consumes its Back.
    event.preventDefault();
    const name = fragmentName(fragment);
    const target = [...root.querySelectorAll("[id]")].find(node => node.id === name) ||
      [...root.querySelectorAll("a[name]")].find(node => node.getAttribute("name") === name);
    if (!target && !/^(?:top)?$/i.test(name)) return;
    readerContext.beginReaderNavigation(event);
    if (target) {
      target.closest("details.reader-clean-web-reply")?.setAttribute("open", "");
      target.scrollIntoView({ block: "start" });
    } else {
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

  // CSS Syntax's name code points, whitespace, and non-printable characters.
  const cssNameChar = /[a-zA-Z0-9_\u0080-\uFFFF-]/;
  const cssWhitespace = /[ \t\n\r\f]/;
  const cssNonPrintable = /[\x00-\x08\x0b\x0e-\x1f\x7f]/;
  const cssNewline = /[\n\r\f]/;
  const cssQuote = /["']/;
  const cssAbsoluteReference = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;

  /** @param {string} value */
  function normalizeCssReference(value) {
    return value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  }

  // Resource policy: fragments, blob:, data: and same-origin relative paths only.
  // data: cannot fetch, blob: is an unguessable same-origin object, and any scheme
  // (https:, javascript:, file:...) or protocol-relative reference is rejected
  // after control/whitespace normalization, matching URL parser leniency.
  /** @param {string | null} raw @param {{strict?: boolean}} [options] */
  function safeCssReference(raw, { strict = false } = {}) {
    if (strict) return false;
    const value = normalizeCssReference(String(raw || ""));
    if (!value || value.startsWith("#") || /^(?:blob|data):/i.test(value)) return true;
    return !cssAbsoluteReference.test(value);
  }

  // Minimal CSS Syntax 3 scanner: decodes escapes and honours strings/comments
  // exactly where the browser does, so escaped names (`\75rl(`), comments
  // (`@import/**/"x"`) and quoted references cannot hide a remote fetch.
  // Unsafe url()/image-set()/image() become `none` ("" in strict mode), unsafe
  // custom-property URL strings become "", and unsafe
  // @import rules are removed. Everything else is copied byte-for-byte.
  /** @param {string | null} source @param {import('../../../typings/reader-html-format-strict').CssOptions} [options] */
  function sanitizeCssReferences(source, { strict = false } = {}) {
    const css = String(source || "");
    const length = css.length;
    /** @type {[number, number, string][]} */
    const edits = [];
    /** @type {{start: number, reference: boolean, unsafe: boolean}[]} */
    const stack = [];
    let i = 0, customValueDepth = -1;
    // Offline HTML historically deletes references; EPUB styles keep a valid
    // `none` so shorthand declarations stay parseable.
    const removed = strict ? "" : "none";
    /** @param {number} start */
    const removeReference = (start) => {
      edits.push([start, i, removed]);
      const parent = stack[stack.length - 1];
      if (parent?.reference) parent.unsafe = true;
    };

    const hexEscape = /([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?/iy;
    const readEscape = () => {
      // css[i] is a backslash that is not followed by a newline.
      hexEscape.lastIndex = ++i;
      const hex = hexEscape.exec(css);
      if (hex) {
        i = hexEscape.lastIndex;
        const code = parseInt(/** @type {string} */ (hex[1]), 16);
        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          ? "\ufffd" : String.fromCodePoint(code);
      }
      const char = String.fromCodePoint(css.codePointAt(i) ?? 0xfffd);
      i += char.length;
      return char;
    };
    /** @param {number} at */
    const validEscape = (at) => css[at] === "\\" && at + 1 < length && !cssNewline.test(css.charAt(at + 1));
    /** @param {number} at */
    const skipWhitespace = (at) => {
      while (cssWhitespace.test(css.charAt(at))) at++;
      return at;
    };
    /** @param {number} at */
    const stringAt = (at) => cssQuote.test(css.charAt(at));
    /** @param {number} at */
    const commentAt = (at) => css.startsWith("/*", at);
    /** @param {number} at */
    const nameAt = (at) => cssNameChar.test(css.charAt(at)) || validEscape(at);
    const readName = () => {
      let name = "";
      while (i < length) {
        if (cssNameChar.test(css.charAt(i))) name += css[i++];
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
        if (cssNewline.test(css.charAt(i))) return value; // bad-string
        if (char === "\\") {
          if (i + 1 >= length) { i++; continue; }
          if (css[i + 1] === "\r" && css[i + 2] === "\n") { i += 3; continue; }
          if (cssNewline.test(css.charAt(i + 1))) { i += 2; continue; }
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
        const char = css.charAt(i);
        if (char === ")") { i++; break; }
        if (cssWhitespace.test(char)) {
          i = skipWhitespace(i);
          if (/[^)]/.test(css.charAt(i))) bad = true;
          continue;
        }
        if (cssQuote.test(char) || char === "(" || cssNonPrintable.test(char)) {
          bad = true; i++; continue;
        }
        if (char === "\\") {
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
        const char = css.charAt(i);
        if (commentAt(i)) { skipComment(); continue; }
        if (cssQuote.test(char)) { readString(); continue; }
        if (char === "\\") { if (validEscape(i)) readEscape(); else i++; continue; }
        i++;
        if (/[([{]/.test(char)) depth++;
        else if (/[)\]]/.test(char)) depth = Math.max(0, depth - 1);
        else if (char === "}") { if (--depth <= 0) return; }
        else if (char === ";" && depth === 0) return;
      }
    };
    /** @param {number} start */
    const handleImport = (start) => {
      // `i` is just after "@import".
      let target = null, cursor;
      while (i < length) {
        i = skipWhitespace(i);
        if (!commentAt(i)) break;
        skipComment();
      }
      if (stringAt(i)) target = readString();
      else {
        cursor = i;
        const name = nameAt(i) ? readName() : "";
        if (name.toLowerCase() === "url" && css[i] === "(") {
          i = skipWhitespace(i + 1);
          if (stringAt(i)) {
            target = readString();
            i = skipWhitespace(i);
            if (css[i] === ")") i++; else target = null;
          } else target = readUrlToken();
        } else i = cursor;
      }
      skipAtRule();
      // Only non-empty same-origin relative sheets may be imported, never
      // fragments, absolute/protocol-relative URLs, or blob/data URLs.
      const value = normalizeCssReference(target ?? "");
      if (strict || !value || value.startsWith("#") || cssAbsoluteReference.test(value))
        edits.push([start, i, ""]);
    };

    while (i < length) {
      const char = css[i];
      if (commentAt(i)) { skipComment(); continue; }
      if (stringAt(i)) {
        const start = i, value = readString();
        const frame = stack[stack.length - 1];
        // Custom properties can later be substituted into image-set()/image();
        // treat absolute or protocol-relative strings there as references.
        const reference = frame?.reference || (customValueDepth >= 0 &&
          cssAbsoluteReference.test(normalizeCssReference(value)));
        if (reference && !safeCssReference(value, { strict })) {
          if (frame?.reference) frame.unsafe = true;
          else edits.push([start, i, "\"\""]);
        }
        continue;
      }
      if (char === "@" && nameAt(i + 1)) {
        const start = i;
        i++;
        const name = readName().toLowerCase();
        if (name === "import" && !stack.length) handleImport(start);
        continue;
      }
      // cssNameChar already accepts hyphens, including a lone '-'.
      if (nameAt(i)) {
        const start = i, name = readName().toLowerCase();
        if (css[i] === "(") {
          i++;
          if (name === "url") {
            const probe = skipWhitespace(i);
            if (!stringAt(probe)) {
              i = probe;
              const value = readUrlToken();
              if (value === null || !safeCssReference(value, { strict })) removeReference(start);
              continue;
            }
          }
          stack.push({ start, reference: CSS_REFERENCE_FUNCTIONS.has(name), unsafe: false });
          continue;
        }
        if (name.startsWith("--") && customValueDepth < 0) {
          const probe = skipWhitespace(i);
          if (css[probe] === ":") { customValueDepth = stack.length; i = probe + 1; }
        }
        continue;
      }
      if (char === "\\") { i++; continue; } // invalid escape
      if (char === "(") { stack.push({ start: i, reference: false, unsafe: false }); i++; continue; }
      if (char === ")") {
        const frame = stack.pop();
        i++;
        if (frame?.unsafe) removeReference(frame.start);
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

  /** @param {URL} url */
  function isPublicWebUrl(url) {
    return /^https?:$/.test(url.protocol) && !url.username && !url.password;
  }

  function originalDocumentUrl() {
    try { return new URL(readerContext.downloadUrl || readerContext.sourceUrl); }
    catch (_) { return null; }
  }

  const absoluteReference = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
  const invalidLinkCharacters = /[\u0000-\u001f\u007f-\u009f\\]/;

  /** @param {URL} url @param {URL | null} base */
  function readerMarkdownLink(url, base) {
    try {
      // The caller has already required an HTTP(S) URL without credentials.
      if (url.protocol !== "https:" || !["huggingface.co", "hf-mirror.com"].includes(url.hostname) ||
          url.port || url.search ||
          !/^\/datasets\/VoiceOfML\/[^/]+\/(?:resolve|raw)\/[^/]+\/.+/.test(url.pathname)) return null;
      const filename = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
      const ext = /\.[a-z0-9]+$/i.exec(filename)?.[0].slice(1).toLowerCase();
      if (!ext || VoiceOfMLReader.capability(ext).readerMode !== VoiceOfMLReader.ReaderMode.ORIGINAL) return null;
      const fragment = url.hash;
      if (fragment && !["md", "markdown"].includes(ext)) return null;
      url = new URL(url.href);
      url.hash = "";
      if (fragment && url.href === base?.href.split("#", 1)[0]) return fragment;
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
    const base = originalDocumentUrl();
    const readerLinks = new WeakSet();
    for (const link of article.querySelectorAll("a[href]")) {
      const value = (link.getAttribute("href") || "").trim();
      if (isLocalFragment(value)) continue;
      const relative = !absoluteReference.test(value);
      let destination = null;
      if (value && !invalidLinkCharacters.test(value)) {
        try {
          const url = new URL(value, base ?? undefined);
          if (isPublicWebUrl(url) && (!relative || url.origin === base?.origin)) destination = url;
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

  // Like Calibre's structure detection, use explicit chapter labels, not
  // paragraph length or visual boldness alone. Keep authored structure first.
  const numberedChapter = /^(?:第[ \u3000]*[\d０-９〇零一二三四五六七八九十百千万两]+[ \u3000]*[卷部篇章节回]|(?:chapter|book|part|section)\s+(?:\d+|[ivxlcdm]+))(?=$|[\s.．:：、—–-])/iu;

  /** @param {HTMLElement} article */
  function markdownTocEntries(article) {
    const authored = readerContext.headingTocEntries(article);
    const title = authored[0]?.target;
    if (authored.length > 1 || (title && title !== article.querySelector(":scope > h1:first-child"))) return authored;
    const candidates = [];
    for (const paragraph of article.children) {
      // Standalone prose blocks only: no code, tables, lists, block quotes,
      // inline links, or paragraphs that merely start with a bold chapter name.
      if (paragraph.localName !== "p") continue;
      const label = paragraph.textContent.trim();
      if (label.length > 72 || /[\r\n]|[。！？；!?]$/u.test(label) || !numberedChapter.test(label)) continue;
      if (paragraph.childElementCount) {
        const emphasis = paragraph.querySelector(":scope > :is(strong, b):only-child:not(:has(> *))");
        if (emphasis?.textContent.trim() !== label) continue;
      }
      candidates.push({ label, target: paragraph });
      if (candidates.length > 512) return authored;
    }
    if (candidates.length < 2) return authored;

    // A working in-book chapter list is already a directory. Do not create a
    // second inferred one just because its chapter destinations are not h-tags.
    const anchors = new Set([...article.querySelectorAll("[id], a[name]")].flatMap(node =>
      [node.id, node.localName === "a" ? node.getAttribute("name") : null]));
    if (anchors.size > 2) {
      /** @type {Map<string, string>} */
      const linked = new Map();
      const cleanLabel = (/** @type {string} */ label) => label.trim().replace(/\s+/gu, " ");
      for (const link of article.querySelectorAll('a[href^="#"]')) {
        const label = cleanLabel(link.textContent);
        if (!numberedChapter.test(label)) continue;
        const href = link.getAttribute("href");
        if (!href || href.length < 2) continue;
        const target = fragmentName(href);
        if (anchors.has(target)) linked.set(label, target);
      }
      const targets = candidates.map(({label}) => linked.get(cleanLabel(label)));
      if (targets.every(Boolean) && new Set(targets).size === candidates.length) return authored;
    }

    return [...authored, ...candidates.map(({ label, target }) => ({
      label, depth: title ? 1 : 0, target,
      activate: () => target.scrollIntoView({ block: "start" })
    }))];
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
      readerContext.setToc(markdownTocEntries(article));
    }
    readerContext.markReaderContentReady();
    readerContext.status.textContent = "已加载";
  }

  /** @param {string} text @param {boolean} [phpwind] @param {string} [reviewedView] @param {string} [archiveDigest] */
  function sanitizeOfflineHtml(text, phpwind = false, reviewedView = "", archiveDigest = "") {
    // A global ALLOWED_URI_REGEXP would also strip every non-allow-listed plain
    // attribute (colspan/rowspan/width), so scope the inline-image rule to URLs.
    // Use the original document URL, not the proxy, srcdoc, or a supplied <base>.
    const original = originalDocumentUrl();
    const base = original && isPublicWebUrl(original) ? original : null;
    if (base) base.hash = "";
    // Converted documents can link to hundreds of fragments in the same file.
    // Cache only the document match, with bounded keys and a fixed base per book.
    /** @type {Map<string, boolean>} */
    const documentMatches = new Map();
    /** @param {Element} node @param {{attrName: string, attrValue: string, keepAttr: boolean}} data */
    const restrict = (node, data) => {
      if (base && data.attrName === "href" && node.localName === "a") {
        const value = data.attrValue, hashIndex = value.indexOf("#");
        if (hashIndex > 0 && !absoluteReference.test(value) && !invalidLinkCharacters.test(value)) {
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
        FORBID_ATTR: ["action", "formaction", "srcdoc", "data-reader-phpwind", "data-reader-legacy-article", "data-reader-reviewed-thread", "data-reader-word-inset"]
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
      const value = /** @type {string} */ (element.getAttribute("style"));
      const cacheable = value.length <= 256;
      let stripped = cacheable ? inlineStyles.get(value) : undefined;
      if (stripped === undefined) {
        stripped = stripUrls(value);
        if (cacheable && inlineStyles.size < 128) inlineStyles.set(value, stripped);
      }
      if (stripped !== value) element.setAttribute("style", stripped);
    }
    // Scope the mobile fix to known Word HTML, a large authored absolute
    // indent and a short text-only line, never code or table cells.
    for (const line of template.content.querySelectorAll("p.MsoNormal[style]")) {
      if (!(line instanceof HTMLElement) || line.closest("table") || line.querySelector("br,img,pre,code") ||
          line.textContent.trim().length > 24) continue;
      const match = /^(\d+(?:\.\d+)?)(px|pt)$/.exec(line.style.textIndent);
      if (!match || Number(match[1]) * (match[2] === "pt" ? 4 / 3 : 1) < 240) continue;
      line.style.setProperty("--reader-word-indent", line.style.textIndent);
      line.setAttribute("data-reader-word-inset", "");
    }
    if (!phpwind && reviewedView === "article" && buildLegacyReadingArticle(template.content))
      return template.innerHTML + CLEAN_WEB_HTML_STYLE;
    const thread = phpwind ? findPhpwindThread(template.content) : null;
    if (thread) {
      if (reviewedView === "thread" && buildPhpwindReadingThread(template.content, thread, archiveDigest))
        return template.innerHTML + CLEAN_WEB_HTML_STYLE;
      reflowPhpwindArchive(template.content, thread);
      return template.innerHTML + PHPWIND_HTML_STYLE;
    }
    const layoutStyle = markLegacyArticleLayout(template.content) ? LEGACY_ARTICLE_HTML_STYLE : "";
    return template.innerHTML + layoutStyle;
  }

  const legacyArticleCell = "table.center_tdbgall > tbody > tr > td.main_tdbgall > table.tdbg_top_left_right > tbody > tr > td.main_tdbg_760";

  /** @param {DocumentFragment} root */
  function buildLegacyReadingArticle(root) {
    // Extract a known single-article CMS template, not an arbitrary element
    // whose id happens to include “article”. Preserve the full sanitized body.
    const bodies = root.querySelectorAll("#ArticleContent");
    const body = bodies[0];
    if (bodies.length !== 1 || !body?.matches(`${legacyArticleCell}#fontzoom > div`) ||
        !body.querySelector("p") || !body.textContent.trim()) return false;
    // The matched cell/row chain guarantees both ancestors and the table.
    const bodyCell = /** @type {HTMLTableCellElement} */ (body.parentElement);
    const bodyRow = /** @type {HTMLTableRowElement} */ (bodyCell.parentElement);
    const table = /** @type {HTMLTableElement} */ (bodyCell.closest("table"));
    const headline = table.querySelector("td#txt_title.main_ArticleTitle");
    if (!headline?.textContent.trim()) return false;
    const headlineRow = headline.closest("tr");
    if (headlineRow?.parentElement !== bodyRow.parentElement) return false;
    const rows = [...table.rows];
    const titleIndex = rows.indexOf(headlineRow);
    const bodyIndex = rows.indexOf(bodyRow);
    if (titleIndex < 0 || bodyIndex <= titleIndex) return false;
    const source = table.querySelector(".Article_tdbgall a#txt_info");
    const metadata = source?.closest("td.Article_tdbgall");
    // If this archive contains actual comments or other unrecognized addenda,
    // retain the existing view instead of silently discarding them.
    for (const row of rows.slice(bodyIndex + 1)) {
      const text = row.textContent.replace(/\s+/g, " ").trim();
      const commentsTitle = /^网友评论：\s*（只显示最新50条。评论内容只代表网友观点，与本站立场无关！）$/.test(text);
      const login = /^只有注册登录的用户才可以发表评论！\s*发表评论\s*请遵守《互联网电子公告服务管理规定》及中华人民共和国其他各项有关法律法规。 用户需对自己在使用本站服务过程中的行为承担法律责任（直接或间接导致的）。 评论内容只代表网友个人观点，与本网站立场无关。$/.test(text);
      if ([...row.querySelectorAll("img,video,audio,pre,blockquote,figure,[id],a[name]")].some(node =>
        !(commentsTitle && node.matches("img:not([id])") && !(node.getAttribute("alt") || "").trim()) &&
        !(login && node.matches("span#UserLogin")))) return false;
      if (text && !commentsTitle && !login && !/^(?:文章录入：.{0,60}责任编辑：.{0,60}|上一篇文章：.{0,180}下一篇文章：.{0,60}|【复制本文】.{0,160}【关闭窗口】)$/.test(text)) return false;
    }
    const targetIds = new Set([...body.querySelectorAll("[id],a[name]")].flatMap(node =>
      [node.id, node.getAttribute("name")].filter(Boolean)));
    targetIds.add(body.id);
    targetIds.add(headline.id);
    targetIds.add(bodyCell.id);
    for (const link of body.querySelectorAll('a[href^="#"]')) {
      const href = link.getAttribute("href");
      if (!href || href.length < 2) continue;
      const target = fragmentName(href);
      if (target.toLowerCase() !== "top" && !targetIds.has(target)) return false;
    }
    const doc = root.ownerDocument;
    const article = doc.createElement("article");
    article.id = bodyCell.id;
    article.className = "reader-clean-web";
    const heading = doc.createElement("h1");
    heading.id = headline.id;
    heading.append(...headline.childNodes);
    article.append(heading);
    if (metadata) {
      const text = metadata.textContent.replace(/\s+/g, " ").trim();
      const fields = /^作者：\s*(.*?)\s*文章发于：\s*(.*?)\s*点击数：.*?更新时间：\s*([0-9-]+)$/.exec(text);
      if (fields) {
        const line = doc.createElement("p");
        line.className = "reader-clean-web-byline";
        line.textContent = [fields[1], fields[2], fields[3] && `更新于 ${fields[3]}`].filter(Boolean).join(" · ");
        article.append(line);
      }
    }
    // Title and article nodes have already passed our existing URL sanitizer.
    // Ignore site typography classes and style sheets; retain authored inline
    // content, real tables, internal fragment IDs and the download unchanged.
    article.append(body);
    normalizeArticleImageTables(body);
    root.replaceChildren(article);
    return true;
  }

  /** @param {Element} body */
  function normalizeArticleImageTables(body) {
    // The common photo box is exactly a single image row plus a caption row.
    // Never flatten a data table, a nested table, or a fragment target.
    for (const table of body.querySelectorAll("table")) {
      if (table.querySelector("table,th,caption,thead,tfoot,colgroup") || table.closest("table table") || table.rows.length !== 2) continue;
      const photoRow = /** @type {HTMLTableRowElement} */ (table.rows.item(0));
      const captionRow = /** @type {HTMLTableRowElement} */ (table.rows.item(1));
      if (photoRow.cells.length !== 1 || captionRow.cells.length !== 1) continue;
      const photo = /** @type {HTMLTableCellElement} */ (photoRow.cells.item(0));
      const caption = /** @type {HTMLTableCellElement} */ (captionRow.cells.item(0));
      if (!photo.querySelector("img[src]") ||
          photo.querySelectorAll("img").length !== 1 || photo.textContent.trim() ||
          !caption.textContent.trim() || caption.querySelector("img,video,audio,pre,svg") ||
          [table, photoRow, captionRow, photo, caption].some(node => node.hasAttribute("id")) ||
          table.querySelector("tbody[id],a[name]")) continue;
      const figure = body.ownerDocument.createElement("figure");
      const label = body.ownerDocument.createElement("figcaption");
      label.append(...caption.childNodes);
      figure.append(...photo.childNodes, label);
      table.replaceWith(figure);
    }
  }

  /** @param {DocumentFragment} root */
  function markLegacyArticleLayout(root) {
    // Legacy Word exports: retain this conservative layout fallback when
    // there is no independently identified article body.
    const shell = legacyArticleCell;
    let marked = false;
    for (const cell of root.querySelectorAll(shell)) {
      const article = cell.querySelector(":scope > .Section1, :scope > div > .Section1");
      if (!article?.querySelector("p.MsoNormal")) continue;
      const outer = cell.closest("td.main_tdbgall")?.closest("table.center_tdbgall");
      if (!outer) continue;
      /** @type {Element | null} */
      let node = cell;
      for (; node && outer.contains(node); node = node.parentElement) {
        node.setAttribute("data-reader-legacy-article", "");
      }
      marked = true;
    }
    return marked;
  }

  /** @typedef {{post: Element, cell: HTMLElement, inner: HTMLElement, main: HTMLElement,
   * outer: HTMLElement, author: Element}} PhpwindPostLayout */
  /** @typedef {{layouts: PhpwindPostLayout[], shells: Set<Element>}} PhpwindThread */

  /** @param {DocumentFragment} root @returns {PhpwindThread | null} */
  function findPhpwindThread(root) {
    const posts = root.querySelectorAll(".tpc_content");
    if (posts.length < 2) return null;
    // Validate all posts before changing the DOM. These are two specific
    // nested layout tables, not a rule for the post's own content tables.
    /** @type {Set<Element>} */
    const shells = new Set();
    const layouts = [];
    for (const post of posts) {
      if (!post.matches("table > tbody > tr:only-child > td + td > table:only-child > tbody:only-child > tr:first-child > td:only-child > span.tpc_content"))
        return null;
      // The selector establishes the ancestor chain and single-cell rows.
      const cell = /** @type {HTMLElement} */ (post.parentElement);
      const row = /** @type {HTMLElement} */ (cell.parentElement);
      const group = /** @type {HTMLElement} */ (row.parentElement);
      const inner = /** @type {HTMLElement} */ (group.parentElement);
      const main = /** @type {HTMLElement} */ (inner.parentElement);
      const outerRow = /** @type {HTMLElement} */ (main.parentElement);
      const outerGroup = /** @type {HTMLElement} */ (outerRow.parentElement);
      const outer = /** @type {HTMLElement} */ (outerGroup.parentElement);
      const author = /** @type {Element} */ (outerRow.firstElementChild);
      // With two children, `td + td` also proves the first cell is a td.
      if (outerRow.childElementCount !== 2 ||
          group.childElementCount !== 3 || outer.childElementCount !== 1 ||
          outer.closest("table table") || shells.has(outer)) return null;
      shells.add(outer);
      layouts.push({ post, cell, inner, main, outer, author });
    }
    return { layouts, shells };
  }

  /** @param {DocumentFragment} root @param {PhpwindThread} thread @param {string} archiveDigest */
  function buildPhpwindReadingThread(root, { layouts }, archiveDigest) {
    // findPhpwindThread returns at least two validated layouts.
    const first = /** @type {PhpwindPostLayout} */ (layouts[0]);
    const title = first.cell.querySelector(":scope > .tpc_title")?.textContent.trim();
    // Without a definite thread title, preserve the existing layout (e.g.
    // print views or fixtures whose surrounding context may be content).
    if (title) {
      const doc = root.ownerDocument;
      const article = doc.createElement("article");
      article.className = "reader-clean-web";
      article.setAttribute("data-reader-reviewed-thread", archiveDigest);
      const heading = doc.createElement("h1");
      heading.textContent = title;
      article.append(heading);
      for (const [i,{ post, cell, outer }] of layouts.entries()) {
        const container = doc.createElement(i ? "details" : "section");
        if (i) {
          container.className = "reader-clean-web-reply";
          const toggle = doc.createElement("summary");
          const lead = cell.querySelector(":scope > .tpc_title")?.textContent.trim() ||
            post.firstChild?.textContent?.trim().split(/\s*\n\s*/)[0] || "";
          toggle.textContent = `${i} 楼${lead ? ` · ${lead.slice(0, 84)}${lead.length > 84 ? "…" : ""}` : ""}`;
          container.append(toggle);
        }
        // Keep links to pre-post named anchors and the table's own target,
        // leaving every node inside the actual post intact.
        const ids = new Set([...post.querySelectorAll("[id],a[name]")].flatMap(node =>
          [node.id, node.getAttribute("name")].filter(Boolean)));
        for (const anchor of [outer, ...cell.querySelectorAll(":scope > [id], :scope > a[name]")]) {
          if (anchor === post) continue;
          const id = anchor.id || anchor.getAttribute("name");
          if (!id || ids.has(id)) continue;
          const target = doc.createElement("span");
          target.id = id;
          container.append(target);
          ids.add(id);
        }
        container.append(post);
        article.append(container);
      }
      root.replaceChildren(article);
      return true;
    }
    return false;
  }

  /** @param {DocumentFragment} root @param {PhpwindThread} thread */
  function reflowPhpwindArchive(root, { layouts, shells }) {
    // Never hide a possible fragment target, live link, or non-text content.
    const keepVisible = "[id],a[name],a[href],img,video,audio,svg,math,input,button,select,textarea,[tabindex]";
    /** @param {Element} element */
    const canHide = (element) => !element.matches(keepVisible) && !element.querySelector(keepVisible);
    /** @param {Element} element @param {string} role */
    const mark = (element, role) => element.setAttribute("data-reader-phpwind", role);
    const toolbar = ["查看作者资料", "发送短消息", "发送邮件", "推荐此帖", "引用回复这个帖子"];
    for (const { post, cell, inner, main, outer, author } of layouts) {
      mark(outer, "shell");
      mark(main, "main");
      mark(inner, "inner");
      mark(post, "post");
      mark(author, canHide(author) ? "profile" : "profile-in-place");

      const lead = [...cell.children];
      if (toolbar.every((label, index) => {
        const control = lead[index];
        return control?.matches("a:not([href])") && control.textContent.trim() === label && canHide(control);
      })) {
        for (const control of lead.slice(0, toolbar.length)) mark(control, "inert");
        for (const next of lead.slice(toolbar.length, toolbar.length + 3)) {
          if (!next.matches("br,a:empty") || !canHide(next)) break;
          mark(next, "inert");
        }
      }
    }

    const navigation = ["控制面板", "短消息", "搜索", "会员", "帮助", "社区", "首页", "无图版"];
    for (const container of root.children) {
      if (container.querySelector('[data-reader-phpwind="shell"]') || shells.has(container)) break;
      if (!container.matches("div") || !container.querySelector(":scope > table")) continue;
      const links = [...container.querySelectorAll("a:not([href])")];
      const labels = links.map(link => link.textContent.trim()).filter(Boolean);
      // Suppress the navigation box only if its entire text is this inactive
      // menu, and leave adjacent topic information and real navigation alone.
      if (labels.length === navigation.length && labels.every((label, index) => label === navigation[index]) &&
          container.textContent.replace(/[\s|]/g, "") === navigation.join("") && canHide(container))
        mark(container, "inert");
      for (const link of links) {
        if (link.textContent.trim() === "加为IE收藏" && canHide(link)) mark(link, "inert");
      }
    }
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
      posts.forEach((post) => {
        const section = source.createElement("section");
        section.className = "reader-forum-post";
        section.innerHTML = post.innerHTML;
        article.appendChild(section);
      });
      return article.outerHTML;
    } catch (_) {
      return null;
    }
  }

  /** @param {string} text @param {boolean} [archiveView] @param {string} [reviewedView] @param {string} [archiveDigest] */
  function prepareHtmlDocument(text, archiveView = false, reviewedView = "", archiveDigest = "") {
    const discussion = buildDiscourseDocument(text);
    const discourse = !archiveView && discussion;
    // The sanitizer returns body content; check the actual title before it is
    // discarded, but recognize and annotate only the sanitized DOM.
    const phpwind = !discussion && /tpc_content/i.test(text) && /phpwind\.net/i.test(text) &&
      /\bpowered\s+by\s+phpwind\.net\s*$/i.test(new DOMParser().parseFromString(text, "text/html").title);
    const html = sanitizeOfflineHtml(discourse || text, phpwind, discussion ? "" : reviewedView, archiveDigest);
    return {
      html,
      discourse: !!discourse,
      discourseArchive: !!discussion,
      spreadsheet: !discussion && html.includes("reader-spreadsheet-sheet")
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

  const reviewedHtmlViews = new Map([
    ["c5c214029407e94ccb2ecb4047285077ac01e5b39ef2ad65ef724724136e4749", "article"],
    ["9ddff06d033c44900801a44937334194a4500103816aafda52b837f9f71765d9", "thread"]
  ]);

  /** @param {import('../../../typings/reader-html-format-strict').PreparedHtml} prepared */
  async function renderHtml(prepared) {
    const bytes = await readerContext.readPreparedBytes(prepared.response, prepared.engine);
    const text = new TextDecoder(detectHtmlEncoding(bytes, readerContext.documentState.title)).decode(bytes);
    readerContext.assertReaderActive();
    let reviewedView = "", archiveDigest = "";
    const openUrl = new URL(location.href);
    const view = openUrl.searchParams.get("view");
    const reading = view === "reading";
    // Restrict extraction to exactly reviewed bytes. A template match or
    // reused Reader ID alone cannot approve new content.
    if (globalThis.crypto?.subtle && /ArticleContent|tpc_content/.test(text)) {
      archiveDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
        value => value.toString(16).padStart(2, "0")).join("");
      reviewedView = reviewedHtmlViews.get(archiveDigest) ?? "";
      readerContext.assertReaderActive();
    }
    const archiveView = view === "archive";
    const documentData = prepareHtmlDocument(text, archiveView, reading ? reviewedView : "", archiveDigest);
    if (documentData.discourseArchive || reviewedView) {
      const archiveNext = documentData.discourseArchive ? !archiveView : reading;
      // The outer guard guarantees a reviewed view when this is not Discourse.
      if (archiveNext === documentData.discourseArchive)
        openUrl.searchParams.set("view", documentData.discourseArchive ? "archive" : "reading");
      else openUrl.searchParams.delete("view");
      const link = document.createElement("a");
      link.className = "text-action";
      link.textContent = archiveNext ? "存档视图" : documentData.discourseArchive ? "纯帖子" : "纯阅读";
      link.href = openUrl.href;
      link.addEventListener("click", event => {
        if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        readerContext.navigateReader(link.href);
      });
      document.querySelector("#history-panel > header")?.append(link);
      readerContext.trackReaderResource(() => { link.remove(); });
    }
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
           /** @param {Event} event */
           const replyToggle = (event) => {
             const target = /** @type {Element | null} */ (event.target);
             if (target?.matches("details.reader-clean-web-reply")) readerContext.handleReaderPositionChange(event);
           };
           doc.addEventListener("toggle", replyToggle, true);
           /** @param {MouseEvent} event */
           const jump = (event) => {
             const href = clickedLink(event)?.getAttribute("href")?.trim() || "";
             if (event.defaultPrevented) return;
             if (isLocalFragment(href)) jumpWithoutHistory(doc, href, event);
             else if (event.type === "click" && event.isTrusted &&
                 (/** @type {Element | null} */ (event.target))?.closest?.("details.reader-clean-web-reply > summary"))
               readerContext.beginReaderNavigation(event);
           };
           doc.addEventListener("click", jump);
           doc.addEventListener("auxclick", jump);
           doc.addEventListener("click", readerContext.handleReaderOutsideClick);
           readerContext.trackReaderResource(() => {
             doc.removeEventListener("click", jump);
             doc.removeEventListener("toggle", replyToggle, true);
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
            /(?:^|;)\s*charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i.exec(meta.getAttribute("content") ?? "")?.[1]);
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
    const frameWindow = frame.contentWindow;
    if (!doc?.body || !frameWindow) return;
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
        const color = element.style.color, priority = element.style.getPropertyPriority("color");
        element.style.setProperty("color", dark > 0.45 ? "#111" : "#f5f5f5", "important");
        repaired.set(element, [color, priority, element.style.color]);
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
