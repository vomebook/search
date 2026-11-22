// Owns search-control drafts and the lifetimes of their delayed commits.
(function () {
  /** @param {VoiceOfMLInputDependencies['clock']} clock */
  function debounceSlot(clock) {
    /** @type {number | null} */
    let timer = null;
    let generation = 0;
    function cancel() {
      const token = ++generation;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      return token;
    }
    /** @param {number} token */
    const isCurrent = token => token === generation;
    /** @param {number} token @param {number} delay @param {() => void} run */
    function schedule(token, delay, run) {
      if (!isCurrent(token)) return;
      timer = clock.setTimeout(() => {
        if (!isCurrent(token) || timer === null) return;
        timer = null;
        run();
      }, delay);
    }
    return { get timer() { return timer; }, cancel, isCurrent, schedule };
  }

  /** @param {string} value @param {string} unit */
  function sizeInputToBytes(value, unit) {
    const number = parseFloat(value);
    if (isNaN(number) || number < 0) return null;
    const factors = /** @type {Record<string, number>} */ ({ B: 1, KB: 1024, MB: 1048576, GB: 1073741824 });
    return Math.round(number * (factors[unit] || 1));
  }

  /** @param {VoiceOfMLInputDependencies} deps @returns {VoiceOfMLInputController} */
  function create(deps) {
    const { input, navigation, ownership, clock, size } = deps;
    const query = debounceSlot(clock), filters = debounceSlot(clock), sizeEdit = debounceSlot(clock);
    /** @type {Pick<VoiceOfMLInputState, 'composing' | 'ready' | 'dirty'> & {generation: number, owner: VoiceOfMLInputDraftOwner | null}} */
    const state = { composing: false, generation: 0, ready: false, dirty: false, owner: null };
    let composition = ownership.visit(0, null);
    let mounted = false, disposed = false;
    const navigationEvents = ["popstate", "hashchange", "pagehide"];
    // Each notification is detached and contains only host presentation state.
    const publish = () => deps.onState({ timer: query.timer, filterTimer: filters.timer, sizeTimer: sizeEdit.timer,
      composing: state.composing, dirty: state.dirty, ready: state.ready });

    function cancelTimer() {
      const token = query.cancel();
      publish();
      return token;
    }

    function pendingQuery() {
      return query.timer !== null && !state.composing ? input.value.trim() : null;
    }

    function applySize() {
      size.commit(sizeInputToBytes(size.min.value, size.minUnit.value), sizeInputToBytes(size.max.value, size.maxUnit.value));
    }
    function flushSize() {
      if (sizeEdit.timer === null) return;
      sizeEdit.cancel();
      applySize();
      publish();
    }
    /** @param {boolean} [preserveDraft] */
    function syncSize(preserveDraft = false) {
      if (preserveDraft && sizeEdit.timer !== null) return;
      const [min, max] = size.read();
      const lower = size.format(min), upper = size.format(max);
      size.min.value = lower.value;
      size.minUnit.value = lower.unit;
      size.max.value = upper.value;
      size.maxUnit.value = upper.unit;
    }
    /** @param {boolean} [preserveQuery] */
    function cancelPending(preserveQuery = false) {
      filters.cancel();
      if (sizeEdit.timer !== null) {
        sizeEdit.cancel();
        // A discarded bound must not be picked up when the other bound is edited.
        syncSize();
      }
      if (preserveQuery) publish();
      else cancelTimer();
    }
    function cancelFilter() {
      filters.cancel();
      publish();
    }
    function scheduleFilter() {
      if (disposed) return;
      const token = filters.cancel();
      filters.schedule(token, 200, () => {
        publish();
        // Committed filters must settle even if a Reader overlay now covers the results.
        if (filters.isCurrent(token)) deps.filterSearch();
      });
      publish();
    }
    function scheduleSize() {
      if (disposed) return;
      const token = sizeEdit.cancel();
      sizeEdit.schedule(token, 500, () => {
        publish();
        if (!sizeEdit.isCurrent(token)) return;
        applySize();
        deps.filterSearch(true);
      });
      publish();
    }
    // A unit with an empty bound must not postpone an edit to the other bound.
    const changeMinUnit = () => { if (size.min.value !== "") scheduleSize(); };
    const changeMaxUnit = () => { if (size.max.value !== "") scheduleSize(); };

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
      if (disposed || state.composing || !state.ready || !deps.canSubmit()) return;
      const token = cancelTimer();
      // Publication may synchronously cancel, replace or dispose this operation.
      if (disposed || !query.isCurrent(token) || state.composing || !state.ready) return;
      const owner = ownership.visit(state.generation, null);
      query.schedule(token, 100, () => {
        publish();
        if (disposed || !query.isCurrent(token) || state.composing || !deps.canSubmit() ||
            !ownership.visitIsCurrent(owner, state.generation, null)) return;
        deps.submit(input.value.trim());
      });
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
      size.min.addEventListener("input", scheduleSize);
      size.max.addEventListener("input", scheduleSize);
      size.minUnit.addEventListener("change", changeMinUnit);
      size.maxUnit.addEventListener("change", changeMaxUnit);
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
      state.generation++;
      cancelPending();
      removeNavigationListeners();
      input.removeEventListener("input", onInput);
      input.removeEventListener("compositionstart", onStart);
      input.removeEventListener("compositionend", onEnd);
      size.min.removeEventListener("input", scheduleSize);
      size.max.removeEventListener("input", scheduleSize);
      size.minUnit.removeEventListener("change", changeMinUnit);
      size.maxUnit.removeEventListener("change", changeMaxUnit);
      state.composing = false;
      state.dirty = false;
      state.owner = null;
      publish();
    }
    return { mount, dispose, debounce, cancelTimer, invalidateVisit, captureDraft, cancelDraft, draftIsCurrent, finishStartup,
      pendingQuery, flushSize, syncSize, cancelPending, scheduleFilter, cancelFilter };
  }
  globalThis.VoiceOfMLSearchInput = { create };
})();
