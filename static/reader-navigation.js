(function (root) {
  "use strict";
  function createNavigation(readerPath) {
    let frame = null;
    let returnFocus = null;
    let background = [];
    const sessionKey = "reader-navigation-current";
    function parse(raw) {
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin || url.pathname !== readerPath)
        throw new Error("Invalid reader destination");
      return url;
    }
    function mergeSearchParams(rawTarget, source, { hashRoute = false, keys = [] } = {}) {
      const target = new URL(rawTarget, location.origin);
      const sourceParams = source instanceof URLSearchParams ? source : new URLSearchParams(source || "");
      const hashParts = hashRoute ? target.hash.split("?", 2) : null;
      const params = hashRoute ? new URLSearchParams(hashParts[1] || "") : target.searchParams;
      for (const key of keys) {
        params.delete(key);
        for (const value of sourceParams.getAll(key)) params.append(key, value);
      }
      if (hashRoute)
        target.hash = hashParts[0] + (params.toString() ? `?${params.toString()}` : "");
      return target;
    }
    function saved() {
      try {
        return JSON.parse(sessionStorage.getItem(sessionKey) || "null");
      } catch (_) {
        return null;
      }
    }
    function clear(url) {
      try {
        const token = url.searchParams.get("nav");
        if (token) sessionStorage.removeItem("reader-return:" + token);
        if (saved()?.readerUrl === url.href) sessionStorage.removeItem(sessionKey);
      } catch (_) {}
    }
    function prepare(raw, returnUrl) {
      const url = parse(raw);
      url.searchParams.set("return", returnUrl);
      try {
        const previous = saved();
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
    function mount(url) {
      const next = document.createElement("iframe");
      next.className = "reader-overlay";
      next.title = "在线阅读";
      next.src = parse(url.href).href;
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      frame = next;
      document.body.classList.add("reader-overlay-open");
      document.body.appendChild(next);
      next.focus();
      background = Array.from(document.body.children)
        .filter((element) => element !== next)
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
      next.addEventListener(
        "load",
        () => {
          if (frame === next) next.focus();
        },
        { once: true }
      );
      return next;
    }
    function unmount() {
      if (!frame) return null;
      try {
        frame.contentWindow?.postMessage({ type: "voice-reader-abort" }, location.origin);
      } catch (_) {}
      frame.remove();
      frame = null;
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
    function replace(raw, returnScroll) {
      const next = parse(raw);
      const current = new URL(frame.src);
      for (const key of ["return", "nav"])
        if (!next.searchParams.get(key) && current.searchParams.get(key))
          next.searchParams.set(key, current.searchParams.get(key));
      remember(next, returnScroll, true);
      const focus = unmount();
      mount(next);
      returnFocus = focus;
      return frame;
    }
    function accepts(event) {
      if (!frame || event.origin !== location.origin) return false;
      if (event.source === frame.contentWindow) return true;
      try {
        return !!event.source && event.source.frameElement === frame;
      } catch (_) {
        return false;
      }
    }
    return Object.freeze({
      parse,
      mergeSearchParams,
      saved,
      clear,
      prepare,
      remember,
      mount,
      unmount,
      replace,
      accepts,
      get returnFocus() {
        return returnFocus;
      }
    });
  }
  root.VoiceOfMLReaderNavigation = Object.freeze({ createNavigation });
})(typeof self !== "undefined" ? self : globalThis);
