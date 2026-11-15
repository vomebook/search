// Pure ownership rules shared by startup drafts, IME completion and debounce.
(function () {
  /** @param {string} href @param {string | undefined} key @returns {VoiceOfMLInputDraftOwner} */
  function draft(href, key) { return { href, key, cancelled: false }; }

  /** @param {VoiceOfMLInputDraftOwner | null} owner @param {string} href @param {string | undefined} key */
  function draftIsCurrent(owner, href, key) {
    return !owner || (!owner.cancelled && owner.href === href && (owner.key === undefined || owner.key === key));
  }

  /** @param {number} generation @param {string | null} viewKey @returns {VoiceOfMLInputVisitOwner} */
  function visit(generation, viewKey) { return { generation, viewKey }; }

  /** @param {VoiceOfMLInputVisitOwner} owner @param {number} generation @param {string | null} viewKey */
  function visitIsCurrent(owner, generation, viewKey) {
    return owner.generation === generation && (owner.viewKey === null || owner.viewKey === viewKey);
  }

  globalThis.VoiceOfMLSearchInputOwnership = { draft, draftIsCurrent, visit, visitIsCurrent };
})();
