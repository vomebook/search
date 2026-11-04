(function (root) {
  "use strict";
  // The search document outlives an overlay. Its store can finish a progress
  // transaction after the Reader iframe has already been detached.
  /** @type {Promise<ReaderStoreApi> | null} */
  let progressStorePromise = null;
  /** @type {Map<string, ReaderStoreApi>} */
  const progressStores = new Map();
  /** @param {string} url @param {string | undefined} version @returns {Promise<ReaderStoreApi | undefined>} */
  function progressStore(url, version) {
    const key = (version || "unversioned") + "|" + url;
    if (progressStores.has(key)) return Promise.resolve(progressStores.get(key));
    if (root.VoiceOfMLReaderStore && (root.VoiceOfMLReaderStore.STORE_VERSION || "") === (version || ""))
      return Promise.resolve(root.VoiceOfMLReaderStore);
    if (progressStorePromise) return progressStorePromise.catch(() => null).then(() => progressStore(url, version));
    progressStorePromise = /** @type {Promise<ReaderStoreApi>} */ (new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      if (version) script.dataset.readerStoreVersion = version;
      script.onload = () => root.VoiceOfMLReaderStore ? resolve(root.VoiceOfMLReaderStore) : reject(new Error("Reader store unavailable"));
      script.onerror = () => reject(new Error("Reader store unavailable"));
      document.head.append(script);
    })).then(store => { progressStores.set(key, store); progressStorePromise = null; return store; },
      error => { progressStorePromise = null; throw error; });
    return progressStorePromise;
  }
  /** @param {string} readerPath @param {{resume?: (url: string) => void; close?: () => void}} [options] */
  function createNavigation(readerPath, options = {}) {
    /** @param {{url?: unknown; closeTime?: unknown} | null | undefined} progress */
    function persistProgress(progress) {
      if (!progress || typeof progress.url !== "string" || !progress.url) return;
      let readerStoreUrl;
      try {
        const script = frame?.contentDocument?.querySelector('script[src*="/reader/core/reader-store"]');
        readerStoreUrl = new URL(script?.getAttribute("src") || readerPath.replace(/reader\.html$/, "reader/core/reader-store.js"), location.origin);
        const prefix = readerPath.slice(0, -"reader.html".length) + "reader/core/";
        if (readerStoreUrl.origin !== location.origin || !readerStoreUrl.pathname.startsWith(prefix) ||
            !/^reader-store(?:\.[0-9a-f]{12})?\.js$/.test(readerStoreUrl.pathname.slice(prefix.length))) return;
      } catch (_) { return; }
      const { closeTime, ...snapshot } = progress;
      const entry = { ...snapshot, lastReadAt: Number.isFinite(closeTime) ? closeTime : Date.now() };
      const version = /^reader-store\.([0-9a-f]{12})\.js$/.exec(/** @type {string} */ (readerStoreUrl.pathname.split("/").pop()))?.[1];
      progressStore(readerStoreUrl.href, version).then(store => /** @type {ReaderStoreApi} */ (store).put(entry)).catch(error => console.warn("Reader progress was not saved", error));
    }
    /** @type {HTMLIFrameElement | null} */
    let frame = null;
    /** @type {HTMLElement | null} */
    let returnFocus = null;
    /** @type {{element: Element; inert: boolean; ariaHidden: string | null}[]} */
    let background = [];
    /** @type {HTMLDivElement | null} */
    let opening = null;
    /** @type {(() => void) | null} */
    let releaseOpening = null;
    // The outer search document owns the browser tab. Only the active Reader
    // may change its title; restore it on dismiss, including parked speech.
    /** @type {string | null} */
    let searchTitle = null;
    let titleDismissed = false;
    function restoreTitle() {
      if (searchTitle !== null) document.title = searchTitle;
      searchTitle = null;
    }
    /** @param {HTMLIFrameElement} target @param {unknown} title */
    function showTitle(target, title) {
      if (frame !== target || titleDismissed || typeof title !== "string" || !title.trim()) return;
      target.title = title;
      if (document.title === title) return;
      document.title = title;
    }
    /** @param {URL} url */
    function initialTitle(url) {
      const title = url.searchParams.get("title");
      return title && title.trim() ? title : "";
    }
    // A Reader closed while reading aloud stays alive, hidden, with a small
    // player on the search page; reopening the same book reuses it.
    /** @type {{frame: HTMLIFrameElement; bar: HTMLDivElement; focus: HTMLElement | null | undefined; key: string; timer: number} | null} */
    let parked = null;
    const sessionKey = "reader-navigation-current";
    /** @param {string} raw */
    function bookKey(raw) {
      try {
        const params = new URL(raw, location.origin).searchParams;
        return params.get("id") ? "id:" + params.get("id") : "url:" + params.get("url") + "|" + params.get("ext");
      } catch (_) {
        return "";
      }
    }
    /** @param {HTMLIFrameElement} target */
    function speech(target) {
      try {
        return target?.contentWindow?.CCRDSpeech?.state?.() || null;
      } catch (_) {
        return null;
      }
    }
    /** @param {HTMLIFrameElement} target */
    function dispose(target) {
      try {
        // Run lifecycle cleanup before detaching the browsing context.
        target.contentWindow?.dispatchEvent(new Event("voice-reader-dispose"));
        target.contentWindow?.postMessage({ type: "voice-reader-abort" }, location.origin);
      } catch (_) {}
      target.src = "about:blank";
      target.remove();
    }
    function releaseParked() {
      if (!parked) return null;
      const current = parked;
      parked = null;
      clearInterval(current.timer);
      current.bar.remove();
      return current;
    }
    function disposeParked() {
      const current = releaseParked();
      if (current) dispose(current.frame);
    }
    /** @param {HTMLIFrameElement} target @param {string} selector */
    function inFrame(target, selector) {
      try {
        return target.contentDocument?.querySelector(selector) || null;
      } catch (_) {
        return null;
      }
    }
    // `restartBy`: a Reader resumed after a page navigation is not reading yet;
    // keep it until then (bounded) instead of disposing it on the first check.
    /** @param {HTMLIFrameElement} target @param {HTMLElement | null | undefined} [focus] @param {number} [restartBy] */
    function park(target, focus, restartBy = 0) {
      disposeParked();
      target.classList.add("reader-overlay-parked");
      target.setAttribute("inert", "");
      target.setAttribute("aria-hidden", "true");
      const bar = document.createElement("div");
      bar.className = "reader-speech-mini";
      bar.setAttribute("role", "region");
      bar.setAttribute("aria-label", "后台朗读");
      const label = document.createElement("span");
      label.className = "reader-speech-mini-title";
      /** @param {string} text @param {() => void} action */
      const button = (text, action) => {
        const element = document.createElement("button");
        element.type = "button";
        element.textContent = text;
        element.addEventListener("click", action);
        return element;
      };
      const back = button("返回阅读", () => {
        const url = target.src;
        if (typeof options.resume === "function") options.resume(url);
        else root.dispatchEvent(new CustomEvent("voice-reader-resume", { detail: url }));
      });
      back.className = "reader-speech-mini-back";
      const play = button("暂停", () => /** @type {HTMLElement | null} */ (inFrame(target, "#speech-play"))?.click());
      const stop = button("停止", () => {
        /** @type {HTMLElement | null} */ (inFrame(target, "#speech-stop"))?.click();
        disposeParked();
      });
      stop.setAttribute("aria-label", "停止朗读并关闭阅读器");
      bar.append(label, back, play, stop);
      let started = !restartBy;
      const sync = () => {
        const state = speech(target);
        if (!state?.active) {
          if (!started && Date.now() < restartBy) {
            label.textContent = "正在恢复朗读…";
            return;
          }
          if (parked?.frame === target) disposeParked();
          return;
        }
        started = true;
        const title = inFrame(target, "#speech-title")?.textContent?.trim() || "朗读";
        const status = inFrame(target, "#speech-status")?.textContent?.trim() || "";
        label.textContent = status ? `${title} · ${status}` : title;
        play.textContent = inFrame(target, "#speech-play")?.textContent?.trim() || (state.playing ? "暂停" : "继续");
      };
      document.body.append(bar);
      parked = { frame: target, bar, focus, key: bookKey(target.src), timer: setInterval(sync, 1000) };
      sync();
    }
    /** @param {string | URL} raw */
    function parse(raw) {
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin || url.pathname !== readerPath)
        throw new Error("Invalid reader destination");
      return url;
    }
    /** @param {string | URL} rawTarget @param {URLSearchParams | string} source @param {{hashRoute?: boolean; keys?: readonly string[]}} [options] */
    function mergeSearchParams(rawTarget, source, { hashRoute = false, keys = [] } = {}) {
      const target = new URL(rawTarget, location.origin);
      const sourceParams = source instanceof URLSearchParams ? source : new URLSearchParams(source || "");
      const hashParts = hashRoute ? target.hash.split("?", 2) : null;
      const params = hashRoute ? new URLSearchParams(/** @type {string[]} */ (hashParts)[1] || "") : target.searchParams;
      for (const key of keys) {
        params.delete(key);
        for (const value of sourceParams.getAll(key)) params.append(key, value);
      }
      if (hashRoute)
        target.hash = /** @type {string[]} */ (hashParts)[0] + (params.toString() ? `?${params.toString()}` : "");
      return target;
    }
    /** @returns {unknown} */
    function saved() {
      try {
        return JSON.parse(sessionStorage.getItem(sessionKey) || "null");
      } catch (_) {
        return null;
      }
    }
    /** @param {URL} url */
    function clear(url) {
      try {
        const token = url.searchParams.get("nav");
        if (token) sessionStorage.removeItem("reader-return:" + token);
        if (/** @type {{readerUrl?: unknown} | null} */ (saved())?.readerUrl === url.href) sessionStorage.removeItem(sessionKey);
      } catch (_) {}
    }
    /** @param {string} raw @param {string} returnUrl */
    function prepare(raw, returnUrl) {
      const url = parse(raw);
      url.searchParams.set("return", returnUrl);
      try {
        const previous = /** @type {{readerUrl?: string} | null} */ (saved());
        if (previous?.readerUrl) clear(new URL(previous.readerUrl, location.origin));
        const token =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
                value.toString(16).padStart(8, "0")
              ).join("");
        sessionStorage.setItem("reader-return:" + token, new URL(returnUrl, location.origin).href);
        url.searchParams.set("nav", token);
      } catch (_) {}
      return url;
    }
    /** @param {URL} url @param {object} returnScroll @param {boolean} [replace] */
    function remember(url, returnScroll, replace = false) {
      const share = new URL(url.href);
      share.searchParams.delete("return");
      share.searchParams.delete("nav");
      try {
        sessionStorage.setItem(
          sessionKey,
          JSON.stringify({
            shareUrl: share.href,
            readerUrl: url.href,
            returnScroll
          })
        );
      } catch (_) {}
      history[replace ? "replaceState" : "pushState"](
        { voiceReaderOverlay: true, readerUrl: url.href },
        "",
        share.href
      );
    }
    /** @param {HTMLIFrameElement} current */
    function shade(current) {
      document.body.classList.add("reader-overlay-open");
      background = Array.from(document.body.children)
        .filter((element) => element !== current && element !== opening &&
          !element.classList.contains("reader-speech-mini"))
        .map((element) => {
          const state = {
            element,
            inert: element.hasAttribute("inert"),
            ariaHidden: element.getAttribute("aria-hidden")
          };
          element.setAttribute("inert", "");
          element.setAttribute("aria-hidden", "true");
          return state;
        });
    }
    /** @param {URL} url */
    function mount(url) {
      const key = bookKey(url.href);
      if (parked && key && parked.key === key) {
        // The same book: show the Reader that kept reading, at its reading position.
        if (frame && frame !== parked.frame) unmount(false);
        const { frame: kept } = /** @type {NonNullable<ReturnType<typeof releaseParked>>} */ (releaseParked());
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        frame = kept;
        searchTitle = document.title;
        titleDismissed = false;
        try { showTitle(kept, kept.contentDocument?.title); } catch (_) {}
        kept.classList.remove("reader-overlay-parked");
        kept.style.removeProperty("opacity");
        kept.style.removeProperty("pointer-events");
        kept.removeAttribute("inert");
        kept.removeAttribute("aria-hidden");
        shade(kept);
        kept.focus();
        // Show the sentence being read (not the "回到原位置" toggle of the panel button).
        try { /** @type {Window} */ (kept.contentWindow).CCRDSpeech?.reveal?.(); } catch (_) {}
        return kept;
      }
      // A foreground Reader that is reading aloud becomes the background
      // Reader. A different book's background speech is left running until
      // the new Reader starts its own reading or the listener stops it.
      if (frame) unmount(true);
      if (parked && !speech(parked.frame)?.active) disposeParked();
      searchTitle = document.title;
      titleDismissed = false;
      const next = document.createElement("iframe");
      next.className = "reader-overlay";
      next.title = "在线阅读";
      next.src = parse(url.href).href;
      next.classList.add("reader-overlay-pending");
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      frame = next;
      // The initial filename is known at the search click. Publish it before
      // creating the history entry, instead of waiting for the iframe lookup.
      showTitle(next, initialTitle(url));
      opening = document.createElement("div");
      opening.className = "reader-overlay-opening";
      const back = document.createElement("button");
      back.className = "icon-button";
      back.type = "button";
      back.setAttribute("aria-label", "返回搜索");
      back.textContent = "\u2190";
      back.addEventListener("click", () => {
        if (typeof options.close === "function") options.close();
        else history.back();
      });
      const status = document.createElement("span");
      status.setAttribute("role", "status");
      status.textContent = "正在打开阅读器...";
      opening.append(back, status);
      const reveal = () => {
        if (frame !== next || !opening) return;
        next.classList.remove("reader-overlay-pending");
        opening?.remove();
        opening = null;
        releaseOpening?.();
        next.focus();
      };
      /** @param {MessageEvent} event */
      const onShell = event => {
        if (event.origin === location.origin && event.source === next.contentWindow && event.data?.type === "voice-reader-shell") reveal();
      };
      window.addEventListener("message", onShell);
      releaseOpening = () => { window.removeEventListener("message", onShell); releaseOpening = null; };
      next.addEventListener(
        "load",
        () => {
          if (next.contentDocument?.URL === "about:blank") return;
          try {
            const title = next.contentDocument?.title;
            if (title && title !== "VoiceOfML Reader") showTitle(next, title);
          } catch (_) {}
          reveal();
        }
      );
      document.body.append(next, opening);
      back.focus();
      shade(next);
      return next;
    }
    function dismiss() {
      // Visually return immediately; history and resource cleanup still own
      // the actual close, including the stalled-history fallback.
      titleDismissed = true;
      restoreTitle();
      for (const target of [frame, opening]) if (target) {
        target.style.setProperty("opacity", "0", "important");
        target.style.setProperty("pointer-events", "none", "important");
      }
    }
    // `keepSpeech` parks a Reader that is reading aloud instead of disposing it.
    function unmount(keepSpeech = true) {
      if (!frame) return null;
      titleDismissed = true;
      restoreTitle();
      if (keepSpeech && opening === null && speech(frame)?.active) park(frame);
      else dispose(frame);
      frame = null;
      opening?.remove();
      opening = null;
      releaseOpening?.();
      for (const state of background) {
        if (!state.inert) state.element.removeAttribute("inert");
        if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
      background = [];
      document.body.classList.remove("reader-overlay-open");
      const focus = returnFocus;
      returnFocus = null;
      return focus;
    }
    /** @param {string} raw @param {object} returnScroll @returns {HTMLIFrameElement | null} */
    function replace(raw, returnScroll) {
      const next = parse(raw);
      const current = new URL(/** @type {HTMLIFrameElement} */ (frame).src);
      for (const key of ["return", "nav"])
        if (!next.searchParams.get(key) && current.searchParams.get(key))
          next.searchParams.set(key, /** @type {string} */ (current.searchParams.get(key)));
      remember(next, returnScroll, true);
      const focus = unmount(bookKey(next.href) !== bookKey(current.href));
      mount(next);
      returnFocus = focus;
      return frame;
    }
    // A standalone Reader that was reading aloud when the reader went back here
    // (reader-speech.mjs records it): keep reading in a background Reader.
    // Leaving the page cannot keep its audio; this restarts at that sentence.
    function resumeSpeech() {
      let handoff = null;
      try {
        handoff = JSON.parse(sessionStorage.getItem("reader-speech-handoff") || "null");
        sessionStorage.removeItem("reader-speech-handoff");
        // A Reader opened as the first page (or in another tab) has no prior
        // search document to hand the session to; localStorage survives that
        // first search-page load for the same short window.
        if (!handoff) handoff = JSON.parse(localStorage.getItem("reader-speech-handoff") || "null");
        localStorage.removeItem("reader-speech-handoff");
      } catch (_) {
        return;
      }
      if (!handoff || !(Date.now() - handoff.at < 300000) || frame || parked || !document.body) return;
      let url;
      try {
        url = parse(handoff.readerUrl);
      } catch (_) {
        return;
      }
      url.searchParams.delete("return");
      url.searchParams.delete("nav");
      const next = document.createElement("iframe");
      next.className = "reader-overlay reader-overlay-parked";
      next.title = "在线阅读";
      next.name = "reader-speech-resume:" + JSON.stringify(handoff.pending
        ? { pending: true }
        : { unit: handoff.unit, offset: handoff.offset });
      next.src = url.href;
      document.body.append(next);
      // A first load of the search page can take longer than the old 30 s
      // grace to boot the resumed Reader. Keep the bar until it is reading or
      // the listener stops it instead of silently dropping the session.
      park(next, null, Date.now() + 300000);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", resumeSpeech, { once: true });
    else setTimeout(resumeSpeech);
    // A search page restored from the back/forward cache runs no startup code.
    root.addEventListener?.("pageshow", (event) => { if (event.persisted) resumeSpeech(); });
    /** @param {MessageEvent} event */
    function accepts(event) {
      if (!frame || event.origin !== location.origin) return false;
      if (event.source === frame.contentWindow) return true;
      try {
        return !!event.source && /** @type {Window} */ (event.source).frameElement === frame;
      } catch (_) {
        return false;
      }
    }
    // Starting speech in another Reader takes over from the background one.
    root.addEventListener?.("message", (event) => {
      if (!accepts(event) || event.data?.type !== "voice-reader-speech-start") return;
      const background = parked?.frame;
      if (background && event.source !== background.contentWindow) disposeParked();
    });
    root.addEventListener?.("message", (event) => {
      if (accepts(event) && event.data?.type === "voice-reader-title") showTitle(/** @type {HTMLIFrameElement} */ (frame), event.data.title);
    });
    return Object.freeze({
      parse,
      mergeSearchParams,
      saved,
      clear,
      prepare,
      remember,
      mount,
      dismiss,
      unmount,
      persistProgress,
      replace,
      accepts,
      disposeBackground: disposeParked,
      get backgroundReader() {
        return parked?.frame || null;
      },
      get returnFocus() {
        return returnFocus;
      }
    });
  }
  root.VoiceOfMLReaderNavigation = Object.freeze({ createNavigation });
})(typeof self !== "undefined" ? self : globalThis);
