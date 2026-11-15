// Quotation owns its request, refresh and animation lifecycle.
(function () {
  /** @param {{element(): HTMLElement}} deps */
  function create(deps) {
    /** @type {VoiceOfMLQuotationState} */
    const hitokotoState = { timer: null, controller: null, lastAt: 0, animation: null, suspended: false };

    // Browsers accept null timer handles as a no-op.
    /** @param {ReturnType<typeof setTimeout> | null} timer */
    function clearTimeout(timer) { globalThis.clearTimeout(/** @type {number} */ (timer)); }

    function hitokotoVisible() { return !document.hidden && !hitokotoState.suspended; }

    function scheduleHitokoto() {
      clearTimeout(hitokotoState.timer);
      hitokotoState.timer = null;
      if (!hitokotoVisible() || hitokotoState.controller) return;
      hitokotoState.timer = setTimeout(fetchHitokoto, Math.max(0, 30000 - (Date.now() - hitokotoState.lastAt)));
    }

    async function fetchHitokoto() {
      if (!hitokotoVisible() || hitokotoState.controller) return;
      clearTimeout(hitokotoState.timer);
      hitokotoState.timer = null;
      const controller = new AbortController();
      hitokotoState.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const resp = await fetch("https://vomebook-hitokoto.hf.space/", { signal: controller.signal });
        if (!resp.ok) throw new Error("Hitokoto unavailable");
        const data = await resp.json();
        if (hitokotoState.controller !== controller || !hitokotoVisible() || controller.signal.aborted) return;
        const text = data.hitokoto || data.text || data.content || data.sentence || "";
        if (typeof text === "string" && text) typewriter(deps.element(), text);
      } catch (_) {
        // Keep the current quotation on transient failures.
      } finally {
        clearTimeout(timeout);
        if (hitokotoState.controller === controller) {
          hitokotoState.controller = null;
          hitokotoState.lastAt = Date.now();
          scheduleHitokoto();
        }
      }
    }

    function resumeHitokotoAnimation() {
      const animation = hitokotoState.animation;
      if (!animation || animation.timer || !hitokotoVisible()) return;
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        animation.el.textContent = animation.chars.join("");
        hitokotoState.animation = null;
        return;
      }
      animation.timer = setTimeout(() => {
        animation.timer = null;
        if (!hitokotoVisible()) return;
        animation.el.textContent = animation.chars.slice(0, ++animation.index).join("");
        if (animation.index >= animation.chars.length) hitokotoState.animation = null;
        else resumeHitokotoAnimation();
      }, animation.speed);
    }

    /** @param {HTMLElement} el @param {string} text @param {number} speed */
    function typewriter(el, text, speed = 60) {
      if (hitokotoState.animation) clearTimeout(hitokotoState.animation.timer);
      el.style.opacity = "0.55";
      el.textContent = "";
      hitokotoState.animation = { el, chars: Array.from(text), index: 0, speed, timer: null };
      resumeHitokotoAnimation();
    }

    function updateHitokotoVisibility() {
      if (hitokotoVisible()) {
        resumeHitokotoAnimation();
        scheduleHitokoto();
      } else {
        clearTimeout(hitokotoState.timer);
        hitokotoState.timer = null;
        if (hitokotoState.controller) hitokotoState.controller.abort();
        hitokotoState.controller = null;
        if (hitokotoState.animation) {
          clearTimeout(hitokotoState.animation.timer);
          hitokotoState.animation.timer = null;
        }
      }
    }

    function setupHitokoto() {
      document.addEventListener("visibilitychange", updateHitokotoVisibility);
      window.addEventListener("pagehide", () => { hitokotoState.suspended = true; updateHitokotoVisibility(); });
      window.addEventListener("pageshow", () => { hitokotoState.suspended = false; updateHitokotoVisibility(); });
      updateHitokotoVisibility();
    }

    return { setup: setupHitokoto };
  }
  globalThis.VoiceOfMLQuotation = { create };
})();
