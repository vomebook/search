// Owns the input listeners, startup handoff, IME visit and debounce lifetime.
(function () {
  /** @param {VoiceOfMLInputDependencies} deps @returns {VoiceOfMLInputController} */
  function create(deps) {
    const { input, navigation, ownership, clock } = deps;
    /** @type {VoiceOfMLInputState & {generation: number, owner: VoiceOfMLInputDraftOwner | null}} */
    const state = { timer: null, composing: false, generation: 0, ready: false, dirty: false, owner: null };
    let composition = ownership.visit(0, null);
    let mounted = false, disposed = false, timerGeneration = 0;
    const navigationEvents = ["popstate", "hashchange", "pagehide"];
    // Each notification is detached and contains only host presentation state.
    const publish = () => deps.onState({ timer: state.timer, composing: state.composing, dirty: state.dirty, ready: state.ready });

    function cancelTimer() {
      const token = ++timerGeneration;
      if (state.timer !== null) clock.clearTimeout(state.timer);
      state.timer = null;
      publish();
      return token;
    }
    function invalidateVisit() { state.generation++; cancelTimer(); }
    function captureDraft(renew = false) {
      if (disposed || state.ready) return;
      state.dirty = true;
      if (renew || !state.owner) state.owner = ownership.draft(deps.getHref(), deps.getEntryKey());
      publish();
    }
    function cancelDraft() { if (state.owner) state.owner.cancelled = true; }
    function draftIsCurrent() {
      return ownership.draftIsCurrent(state.owner, deps.getHref(), deps.getEntryKey());
    }
    function debounce() {
      if (disposed || state.composing || !state.ready) return;
      const token = cancelTimer();
      // Publication may synchronously cancel, replace or dispose this operation.
      if (disposed || token !== timerGeneration || state.composing || !state.ready) return;
      const owner = ownership.visit(state.generation, null);
      state.timer = clock.setTimeout(() => {
        // A cancelled callback must neither submit nor clear its replacement timer.
        if (disposed || token !== timerGeneration) return;
        state.timer = null;
        publish();
        if (disposed || token !== timerGeneration || state.composing ||
            !ownership.visitIsCurrent(owner, state.generation, null)) return;
        deps.submit(input.value.trim());
      }, 100);
      publish();
    }
    /** @param {Event} event */
    function onInput(event) {
      const edit = /** @type {InputEvent} */ (event);
      const compositionInput = edit.isComposing || edit.inputType === "insertCompositionText" || edit.inputType === "insertFromComposition";
      captureDraft(!state.composing && !compositionInput);
      deps.syncInput();
      if (!compositionInput) debounce();
    }
    function onStart() {
      if (disposed) return;
      captureDraft(true);
      if (disposed) return;
      cancelTimer();
      if (disposed) return;
      state.composing = true;
      composition = ownership.visit(state.generation, deps.getViewKey());
      publish();
    }
    function onEnd() {
      state.composing = false;
      publish();
      // Keep the visible draft; completion from an old visit cannot submit it.
      if (ownership.visitIsCurrent(composition, state.generation, deps.getViewKey())) debounce();
    }
    function removeNavigationListeners() {
      for (const type of navigationEvents) navigation.removeEventListener(type, cancelDraft, true);
    }
    function mount() {
      if (mounted || disposed) return;
      mounted = true;
      for (const type of navigationEvents) navigation.addEventListener(type, cancelDraft, true);
      input.addEventListener("input", onInput);
      input.addEventListener("compositionstart", onStart);
      input.addEventListener("compositionend", onEnd);
      // The inline producer remains active until these listeners are installed.
      const early = input._earlySearchInput;
      if (early) {
        state.dirty = early.dirty;
        state.owner = early.owner;
        state.composing = early.composing;
        composition = ownership.visit(state.generation, null);
        early.dispose();
      }
      publish();
    }
    /** @param {boolean} current */
    function finishStartup(current) {
      if (disposed || state.ready) return;
      removeNavigationListeners();
      state.ready = true;
      if (!current) invalidateVisit();
      const dirty = state.dirty;
      state.dirty = false;
      state.owner = null;
      publish();
      if (dirty && current) debounce();
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      cancelDraft();
      invalidateVisit();
      removeNavigationListeners();
      input.removeEventListener("input", onInput);
      input.removeEventListener("compositionstart", onStart);
      input.removeEventListener("compositionend", onEnd);
      state.composing = false;
      state.dirty = false;
      state.owner = null;
      publish();
    }
    return { mount, dispose, debounce, cancelTimer, invalidateVisit, captureDraft, cancelDraft, draftIsCurrent, finishStartup };
  }
  globalThis.VoiceOfMLSearchInput = { create };
})();
