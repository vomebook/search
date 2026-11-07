// Folder filter selection projection shared by both search sites. Every input is
// passed explicitly; the host keeps the tree, memo, persistence and rendering state.
// Statements mirror the original inline functions so property reads stay identical.
// The IIFE keeps the helpers out of the classic-script global scope (no Annex B leak).
(function () {
  /**
   * @param {string} path
   * @param {ReadonlySet<string>} subtreeSet
   * @returns {boolean}
   */
  function folderPathCovered(path, subtreeSet) {
    for (let prefix = path; prefix; ) {
      if (subtreeSet.has(prefix)) return true;
      const slash = prefix.lastIndexOf("/");
      prefix = slash < 0 ? "" : prefix.slice(0, slash);
    }
    return false;
  }

  /**
   * @param {readonly VoiceOfMLFolderSelectionNode[] | null | undefined} nodes
   * @param {ReadonlySet<string>} subtreeSet
   * @param {ReadonlySet<string>} selfSet
   * @returns {Map<VoiceOfMLFolderSelectionNode, VoiceOfMLFolderSelectionState>}
   */
  function createFolderSelectionLookup(nodes, subtreeSet, selfSet) {
    /** @type {Map<VoiceOfMLFolderSelectionNode, VoiceOfMLFolderSelectionState>} */
    const lookup = new Map();
    /** @type {{node: VoiceOfMLFolderSelectionNode, covered: boolean, exit: boolean}[]} */
    const stack = (nodes || []).map(node => ({ node, covered: folderPathCovered(node.path, subtreeSet), exit: false }));
    /** @param {VoiceOfMLFolderSelectionNode} child */
    const stateOf = child => /** @type {VoiceOfMLFolderSelectionState} */ (lookup.get(child));
    while (stack.length) {
      const entry = /** @type {{node: VoiceOfMLFolderSelectionNode, covered: boolean, exit: boolean}} */ (stack.pop()), node = entry.node;
      if (!entry.exit) {
        const covered = entry.covered || !!node.path && subtreeSet.has(node.path);
        stack.push({ node, covered, exit: true });
        for (let i = (node.children || []).length - 1; i >= 0; i--) {
          stack.push({ node: /** @type {VoiceOfMLFolderSelectionNode} */ (/** @type {VoiceOfMLFolderSelectionNode[]} */ (node.children)[i]), covered, exit: false });
        }
        continue;
      }
      const direct = selfSet.has(node.path), children = node.children || [];
      let full;
      if (entry.covered) full = true;
      else if (node.isRoot) full = (!node.hasDirectFiles || direct) && (children.length ? children.every(child => stateOf(child).full) : !!node.hasDirectFiles);
      else if (node.showSelfToggle && !direct) full = false;
      else if (!node.hasChildren) full = !!node.hasDirectFiles && direct || subtreeSet.has(node.path);
      else full = children.every(child => stateOf(child).full) && (!node.hasDirectFiles || direct);
      lookup.set(node, { full, partial: !full && (direct || subtreeSet.has(node.path) || children.some(child => {
        const state = stateOf(child); return state.full || state.partial;
      })) });
    }
    return lookup;
  }

  /**
   * @param {VoiceOfMLFolderSelectionNode | null | undefined} node
   * @param {ReadonlySet<string>} subtreeSet
   * @param {ReadonlySet<string>} selfSet
   * @param {Map<VoiceOfMLFolderSelectionNode, VoiceOfMLFolderSelectionState> | null} [lookup]
   * @returns {VoiceOfMLFolderSelectionState}
   */
  function folderSelectionState(node, subtreeSet, selfSet, lookup = null) {
    if (!node) return { full: false, partial: false };
    return /** @type {VoiceOfMLFolderSelectionState} */ ((lookup || createFolderSelectionLookup([node], subtreeSet, selfSet)).get(node));
  }

  /**
   * @param {VoiceOfMLFolderSelectionNode} node
   * @param {Pick<ParentNode, "querySelector">} row
   * @param {ReadonlySet<string>} subtreeSet
   * @param {ReadonlySet<string>} selfSet
   * @param {Map<VoiceOfMLFolderSelectionNode, VoiceOfMLFolderSelectionState> | null} [lookup]
   * @returns {void}
   */
  function applyFolderSelectionToNode(node, row, subtreeSet, selfSet, lookup = null) {
    const cb = /** @type {HTMLInputElement | null} */ (row.querySelector("input[type='checkbox']"));
    if (!cb) return;
    const { full, partial } = folderSelectionState(node, subtreeSet, selfSet, lookup);
    cb.checked = full;
    cb.indeterminate = !full && partial;
    const selfBtn = row.querySelector(".folder-self-toggle");
    if (selfBtn) {
      const selfOn = selfSet.has(node.path) || folderPathCovered(node.path, subtreeSet);
      selfBtn.classList.toggle("active", selfOn);
      selfBtn.setAttribute("aria-pressed", selfOn ? "true" : "false");
    }
  }

  /** @type {typeof globalThis & {VoiceOfMLSearchFolderSelection: typeof VoiceOfMLSearchFolderSelection}} */
  const globals = globalThis;
  globals.VoiceOfMLSearchFolderSelection = {folderPathCovered, createFolderSelectionLookup, folderSelectionState, applyFolderSelectionToNode};
})();
