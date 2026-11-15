// Sidebar feature: owns its rendering lifecycle; the host supplies a bounded view and effects.
(function () {
  /** @param {VoiceOfMLFolderTreeDependencies} deps */
  function create(deps) {
    /** @param {string[]} a @param {string[]} b */
    const sameValues = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** @param {boolean} [loading] */
function updateFolderTreeControls(loading = false) {
  const enabled = !loading && deps.readView().mode === "repo" &&
    (deps.readView().tree || []).some(node => node.children && node.children.length);
  const button = deps.toggleAll;
  if (!button) return;
  // A closed root hides even descendants whose individual open state is kept.
  const expanded = Boolean(enabled && deps.readView().tree.some(node =>
    node.children && node.children.length && !deps.readView().collapsed[node.path]));
  button.disabled = !enabled;
  button.textContent = expanded ? "收起" : "展开";
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-label", expanded ? "收起所有子目录" : "展开所有子目录");
  button.title = button.getAttribute("aria-label") || "";
}

/** @param {boolean} collapsed */
function setAllFoldersCollapsed(collapsed) {
  if (!deps.toggleAll || deps.toggleAll.disabled) return;
  const stack = [...deps.readView().tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node || !node.children || !node.children.length) continue;
    deps.setCollapsed(node.path, collapsed);
    for (const child of node.children) stack.push(child);
  }
  if (deps.container.contains(document.activeElement)) {
    deps.toggleAll.focus({ preventScroll: true });
  }
  // Use the owned, time-sliced tree renderer. Superseding bulk actions and
  // route changes cancel old batches; selections/search state stay untouched.
  renderFilterFolderTree();
}

function renderFilterFolderTree() {
  cancelFolderTreeRendering();
  folderSelectionMemo = null;
  setupFolderTreeEvents();
  updateFolderTreeControls();
  deps.container.innerHTML = "";
  if (!deps.readView().tree || deps.readView().tree.length === 0) {
    deps.container.innerHTML = '<div style="font-size:12px;color:var(--on-surface-variant);opacity:0.6">暂无目录</div>';
    return;
  }
  renderFilterTreeNodes(deps.container, deps.readView().tree, 0);
}

function refreshFilterFolderSelectionState() {
  if (!deps.container || !deps.readView().tree || deps.readView().tree.length === 0) return;
  const subtreeSet = getFolderSubtreeSet();
  const selfSet = getFolderSelfSet();
  const lookup = getFolderSelectionLookup(subtreeSet, selfSet);
  /** @type {NodeListOf<VoiceOfMLFolderElement>} */ (deps.container.querySelectorAll(".filter-folder-item")).forEach(function(row) {
    const node = row._folderNode;
    if (node) deps.selection.applyFolderSelectionToNode(node, row, subtreeSet, selfSet, lookup);
  });
}

function setupFolderTreeEvents() {
  const tree = deps.container;
  if (tree._eventsReady) return;
  tree._eventsReady = true;
  tree.addEventListener("change", event => {
    const row = /** @type {VoiceOfMLFolderElement | null} */ (/** @type {HTMLElement} */ (event.target).closest(".filter-folder-item"));
    if (row?._folderNode && /** @type {HTMLElement} */ (event.target).matches('input[type="checkbox"]')) handleFolderCheckboxChange(row._folderNode);
  });
  tree.addEventListener("click", event => {
    const row = /** @type {VoiceOfMLFolderElement | null} */ (/** @type {HTMLElement} */ (event.target).closest(".filter-folder-item"));
    if (!row?._folderNode) return;
    const node = row._folderNode;
    if (/** @type {HTMLElement} */ (event.target).closest(".folder-self-toggle")) {
      event.preventDefault();
      handleFolderSelfToggle(node);
    } else {
      const toggle = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest(".tree-toggle"));
      if (!toggle) return;
      const children = /** @type {VoiceOfMLFolderElement} */ (row.nextElementSibling);
      const expanding = !!deps.readView().collapsed[node.path];
      deps.setCollapsed(node.path, !expanding);
      updateFolderTreeControls();
      if (!expanding) cancelFolderTreeRendering(children);
      if (expanding && !children._childrenRendered) {
        children.style.display = "block";
        renderFilterTreeNodes(children, node.children || [], Number(row.style.getPropertyValue("--fdepth")) + 1);
      } else if (expanding) resumeFolderTreeRendering(children);
      toggle?.setAttribute("aria-expanded", String(expanding));
      toggle?.setAttribute('aria-label', (expanding ? '收起子文件夹：' : '展开子文件夹：') + node.path);
      toggle.title = expanding ? '收起' : '展开';
      toggleFolderChildrenAnimated(children, toggle, expanding);
    }
  });
}

/** @param {VoiceOfMLFolderElement} childContainer @param {HTMLElement} toggle @param {boolean} expanding */
function toggleFolderChildrenAnimated(childContainer, toggle, expanding) {
  if (!childContainer || !toggle) return;
  childContainer.getAnimations().forEach(function(animation) { animation.cancel(); });
  toggle.getAnimations().forEach(function(animation) { animation.cancel(); });
  const glyph = toggle.querySelector(".tree-toggle-glyph");
  if (glyph) glyph.getAnimations().forEach(function(animation) { animation.cancel(); });
  const resetChildStyles = function() {
    ["height", "opacity", "transform", "overflow", "transition"].forEach(key => { childContainer.style.removeProperty(key); });
  };
  const stopTransition = function() {
    if (childContainer._transitionCleanup) {
      childContainer.removeEventListener("transitionend", childContainer._transitionCleanup);
      childContainer._transitionCleanup = null;
    }
    if (childContainer._transitionTimer) {
      clearTimeout(childContainer._transitionTimer);
      childContainer._transitionTimer = null;
    }
  };
  stopTransition();
  resetChildStyles();
  if (!expanding && childContainer.contains(document.activeElement)) toggle.focus({ preventScroll: true });
  childContainer.inert = !expanding;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    childContainer.style.display = expanding ? 'block' : 'none';
    toggle.classList.toggle('expanded', expanding);
    return;
  }
  const duration = expanding ? 220 : 190;
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
  childContainer.style.display = "block";
  const height = childContainer.scrollHeight + "px";
  const setFrame = (/** @type {boolean} */ open) => {
    childContainer.style.height = open ? height : "0px";
    childContainer.style.opacity = open ? "1" : "0";
    childContainer.style.transform = open ? "translateY(0)" : "translateY(-6px)";
  };
  setFrame(!expanding);
  childContainer.style.overflow = "hidden";
  void childContainer.offsetHeight;
  childContainer.style.transition = ["height", "opacity", "transform"].map(key => `${key} ${duration}ms ${easing}`).join(", ");
  setFrame(expanding);
  childContainer._transitionCleanup = function(event) {
    if (event.target !== childContainer || event.propertyName !== "height") return;
    stopTransition();
    resetChildStyles();
    childContainer.style.display = expanding ? "block" : "none";
  };
  childContainer.addEventListener("transitionend", childContainer._transitionCleanup);
  childContainer._transitionTimer = setTimeout(function() {
    if (childContainer._transitionCleanup) childContainer._transitionCleanup({ target: childContainer, propertyName: "height" });
  }, duration + 40);
  toggle.classList.toggle("expanded", expanding);
  if (glyph) {
    glyph.animate([
      { transform: expanding ? "rotate(-45deg)" : "rotate(45deg)" },
      { transform: expanding ? "rotate(45deg)" : "rotate(-45deg)" },
    ], { duration, easing, fill: "forwards" });
  }
}

function getFolderSubtreeSet() {
  return new Set(deps.readView().subtrees || []);
}

/** @param {VoiceOfMLFilterFolder[] | null | undefined} nodes */
function initializeFolderTreeCollapsed(nodes) {
  for (const node of nodes || []) {
    if (node.path && !(node.path in deps.readView().collapsed)) deps.setCollapsed(node.path, false);
    if (node.children && node.children.length > 0) initializeFolderTreeCollapsed(node.children);
  }
}

function getFolderSelfSet() {
  return new Set(deps.readView().selfs || []);
}

/** @type {{tree: VoiceOfMLFilterFolder[], subtrees: string[], selfs: string[], lookup: Map<VoiceOfMLFolderSelectionNode, VoiceOfMLFolderSelectionState>} | null} */
let folderSelectionMemo = null;

/** @param {Set<string>} subtreeSet @param {Set<string>} selfSet */
function getFolderSelectionLookup(subtreeSet, selfSet) {
  if (!folderSelectionMemo || folderSelectionMemo.tree !== deps.readView().tree
      || !sameValues(deps.readView().subtrees, folderSelectionMemo.subtrees)
      || !sameValues(deps.readView().selfs, folderSelectionMemo.selfs)) {
    folderSelectionMemo = { tree: deps.readView().tree, subtrees: deps.readView().subtrees.slice(),
      selfs: deps.readView().selfs.slice(), lookup: deps.selection.createFolderSelectionLookup(deps.readView().tree, subtreeSet, selfSet) };
  }
  return folderSelectionMemo.lookup;
}

// Split covering ancestors before removing a branch or its direct files.
/** @param {string} path @param {Set<string>} subtreeSet @param {Set<string>} selfSet @param {boolean} [includeSelf] @param {VoiceOfMLFilterFolder[] | null | undefined} [nodes] */
function splitFolderSelection(path, subtreeSet, selfSet, includeSelf = false, nodes = deps.readView().tree) {
  for (const node of nodes || []) {
    if (!node.isRoot && node.path !== path && !path.startsWith(node.path + "/")) continue;
    if (subtreeSet.has(node.path) && (includeSelf || node.path !== path)) {
      subtreeSet.delete(node.path);
      if (node.hasDirectFiles) selfSet.add(node.path);
      for (const child of node.children || []) subtreeSet.add(child.path);
    }
    if (node.path !== path) splitFolderSelection(path, subtreeSet, selfSet, includeSelf, node.children);
  }
}

/** @param {VoiceOfMLFilterFolder} node @param {boolean} enabled @param {Set<string>} subtreeSet @param {Set<string>} selfSet */
function setNodeSubtreeSelection(node, enabled, subtreeSet, selfSet) {
  if (!node) return;
  if (!enabled) splitFolderSelection(node.path, subtreeSet, selfSet);
  const contains = (/** @type {string} */ path) => node.isRoot || path === node.path || path.startsWith(node.path + "/");
  for (const path of subtreeSet) if (contains(path)) subtreeSet.delete(path);
  for (const path of selfSet) if (contains(path)) selfSet.delete(path);
  if (!enabled) return;
  if (!node.isRoot) subtreeSet.add(node.path);
  else {
    if (node.hasDirectFiles) selfSet.add(node.path);
    for (const child of node.children || []) subtreeSet.add(child.path);
  }
}

/** @param {Set<string>} subtreeSet @param {Set<string>} selfSet */
function normalizeFolderSelection(subtreeSet, selfSet) {
  const lookup = deps.selection.createFolderSelectionLookup(deps.readView().tree, subtreeSet, selfSet);
  for (const [node, state] of lookup) if (!node.isRoot && state.full) subtreeSet.add(node.path);
  for (const path of subtreeSet) {
    const slash = path.lastIndexOf("/");
    if (slash >= 0 && deps.selection.folderPathCovered(path.slice(0, slash), subtreeSet)) subtreeSet.delete(path);
  }
  for (const path of selfSet) if (deps.selection.folderPathCovered(path, subtreeSet)) selfSet.delete(path);
}

/** @param {Set<string>} subtreeSet @param {Set<string>} selfSet */
function persistFolderSelection(subtreeSet, selfSet) {
  normalizeFolderSelection(subtreeSet, selfSet);
  if (subtreeSet.size > 10000 || selfSet.size > 10000) {
    deps.notify("目录筛选最多支持 10000 项，请缩小选择范围");
    return;
  }
  deps.commitSelection(Array.from(subtreeSet), Array.from(selfSet));
}

/** @param {VoiceOfMLFilterFolder[]} nodes @param {string[]} subtreePaths @param {string[]} selfPaths */
function collectFolderNodePaths(nodes, subtreePaths, selfPaths) {
  for (const node of nodes) {
    if (!node.isRoot && node.path) subtreePaths.push(node.path);
    if (node.hasDirectFiles) selfPaths.push(node.path);
    if (node.children && node.children.length > 0) {
      collectFolderNodePaths(node.children, subtreePaths, selfPaths);
    }
  }
}

/** @type {VoiceOfMLFolderRenderTask[]} */
let folderTreeRenderQueue = [];
let folderTreeControlId = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let folderTreeRenderTimer = null;
let folderTreeRenderActive = false;

/** @param {HTMLElement | null} [root] */
function cancelFolderTreeRendering(root = null) {
  folderTreeRenderQueue = folderTreeRenderQueue.filter(task => {
    if (root && !root.contains(task.container)) return true;
    task.container._renderTask = null;
    return false;
  });
  if (!folderTreeRenderQueue.length) { if (folderTreeRenderTimer !== null) clearTimeout(folderTreeRenderTimer); folderTreeRenderTimer = null; }
}

/** @param {VoiceOfMLFolderElement} root */
function resumeFolderTreeRendering(root) {
  for (const container of /** @type {NodeListOf<VoiceOfMLFolderElement>} */ (root.querySelectorAll(".tree-children"))) {
    if (!container.isConnected || container._childrenRendered || container._renderTask || !container._folderNode) continue;
    let visible = true;
    for (let parent = /** @type {VoiceOfMLFolderElement | null} */ (container); parent && parent !== deps.container; parent = /** @type {VoiceOfMLFolderElement | null} */ (parent.parentElement)) {
      if (parent._folderNode && deps.readView().collapsed[parent._folderNode.path]) { visible = false; break; }
    }
    if (visible) renderFilterTreeNodes(container, container._folderNode.children || [], container._folderDepth || 0);
  }
}

function drainFolderTreeRendering() {
  if (folderTreeRenderActive) return;
  folderTreeRenderActive = true;
  if (folderTreeRenderTimer !== null) clearTimeout(folderTreeRenderTimer); folderTreeRenderTimer = null;
  const changed = new Set(/** @type {VoiceOfMLFolderElement[]} */ ([]));
  const subtreeSet = getFolderSubtreeSet();
  const selfSet = getFolderSelfSet();
  const lookup = getFolderSelectionLookup(subtreeSet, selfSet);
  const started = performance.now();
  try {
    for (let count = 0; folderTreeRenderQueue.length && count < 32 && performance.now() - started < 4; ) {
      const task = folderTreeRenderQueue[0];
      if (!task) break;
      if (!task.container.isConnected || task.tree !== deps.readView().tree || task.route !== deps.readView().routeId) {
        task.container._renderTask = null; folderTreeRenderQueue.shift(); continue;
      }
      if (task.index === task.nodes.length) {
        task.container._childrenRendered = true; task.container._renderTask = null;
        folderTreeRenderQueue.shift(); continue;
      }
      const node = task.nodes[task.index++];
      if (!node) continue;
      appendFilterTreeNode(task.container, node, task.depth, subtreeSet, selfSet, lookup);
      changed.add(task.container); count++;
    }
    for (const container of changed) if (container._transitionCleanup && !deps.readView().collapsed[container._folderPath || ""]) {
      container.style.height = container.scrollHeight + "px";
    }
  } finally { folderTreeRenderActive = false; }
  if (folderTreeRenderQueue.length) folderTreeRenderTimer = setTimeout(drainFolderTreeRendering, 0);
}

/** @param {VoiceOfMLFolderElement} container @param {VoiceOfMLFilterFolder[]} nodes @param {number} depth */
function renderFilterTreeNodes(container, nodes, depth) {
  if (container._renderTask) return;
  container.replaceChildren(); container._childrenRendered = false;
  const task = { container, nodes, depth, index: 0, tree: deps.readView().tree, route: deps.readView().routeId };
  container._renderTask = task; folderTreeRenderQueue.push(task);
  if (!folderTreeRenderActive) drainFolderTreeRendering();
}

/** @param {VoiceOfMLFolderElement} container @param {VoiceOfMLFilterFolder} node @param {number} depth @param {Set<string>} subtreeSet @param {Set<string>} selfSet @param {Map<VoiceOfMLFolderSelectionNode, VoiceOfMLFolderSelectionState>} lookup */
function appendFilterTreeNode(container, node, depth, subtreeSet, selfSet, lookup) {
    const has = node.children && node.children.length > 0;
    const row = /** @type {VoiceOfMLFolderElement} */ (document.createElement("div"));
    row.className = "filter-folder-item";
    row.style.setProperty("--fdepth", String(depth));
    row.dataset.path = node.path;
    row._folderNode = node;
    var collapsed = !!deps.readView().collapsed[node.path];
    row.innerHTML = (has ? ('<button type="button" class="tree-toggle' + (collapsed ? '' : ' expanded') + '" aria-label="' + (collapsed ? '展开子文件夹' : '收起子文件夹') + '" title="' + (collapsed ? '展开' : '收起') + '"><span class="tree-toggle-glyph" aria-hidden="true"></span></button>') : '<span class="tree-toggle-placeholder"></span>') +
      '<input type="checkbox" value="' + deps.escape(node.path) + '">' +
      '<span class="folder-name" title="' + deps.escape(node.name) + '">' + deps.escape(node.name) + '</span>' +
      (node.showSelfToggle ? '<button type="button" class="folder-self-toggle" data-path="' + deps.escape(node.path) + '">本层文件</button>' : '') +
      '<span class="folder-count">' + (node.count || 0).toLocaleString() + '</span>';
    const toggle = row.querySelector(/** @type {"button"} */ (".tree-toggle"));
    row.querySelector('input')?.setAttribute('aria-label', '选择文件夹：' + node.path);
    row.querySelector('.folder-self-toggle')?.setAttribute('aria-label', '本层文件：' + node.path);
    toggle?.setAttribute('aria-label', (collapsed ? '展开子文件夹：' : '收起子文件夹：') + node.path);
    deps.selection.applyFolderSelectionToNode(node, row, subtreeSet, selfSet, lookup);
    container.appendChild(row);
    if (has) {
      const childDiv = /** @type {VoiceOfMLFolderElement} */ (document.createElement("div"));
      childDiv.className = "tree-children";
      childDiv.id = 'filter-folder-children-' + ++folderTreeControlId;
      childDiv.inert = collapsed;
      toggle?.setAttribute('aria-controls', childDiv.id);
      childDiv._folderPath = node.path;
      childDiv._folderNode = node; childDiv._folderDepth = depth + 1;
      if (collapsed) childDiv.style.display = "none";
      childDiv._childrenRendered = false;
      toggle?.setAttribute("aria-expanded", String(!collapsed));
      container.appendChild(childDiv);
      if (!collapsed) renderFilterTreeNodes(childDiv, node.children || [], depth + 1);
    }
}

/** @param {VoiceOfMLFilterFolder} node */
function handleFolderCheckboxChange(node) {
  const subtreeSet = getFolderSubtreeSet();
  const selfSet = getFolderSelfSet();
  const { full } = deps.selection.folderSelectionState(node, subtreeSet, selfSet);
  setNodeSubtreeSelection(node, !full, subtreeSet, selfSet);
  persistFolderSelection(subtreeSet, selfSet);
  refreshFilterFolderSelectionState();
}

/** @param {VoiceOfMLFilterFolder} node */
function handleFolderSelfToggle(node) {
  const subtreeSet = getFolderSubtreeSet();
  const selfSet = getFolderSelfSet();
  splitFolderSelection(node.path, subtreeSet, selfSet, true);
  if (selfSet.has(node.path)) selfSet.delete(node.path);
  else selfSet.add(node.path);
  persistFolderSelection(subtreeSet, selfSet);
  refreshFilterFolderSelectionState();
}

function selectAll() {
    if (!deps.readView().tree || deps.readView().tree.length === 0) return;
    var subtreeSet = new Set(/** @type {string[]} */ ([]));
    var selfSet = new Set(/** @type {string[]} */ ([]));
    var currentSubtreeSet = getFolderSubtreeSet();
    var currentSelfSet = getFolderSelfSet();
    var allSelected = deps.readView().tree.every(function(node) { return deps.selection.folderSelectionState(node, currentSubtreeSet, currentSelfSet).full; });
    if (allSelected) {
      persistFolderSelection(subtreeSet, selfSet);
      refreshFilterFolderSelectionState();
      return;
    }
    for (const node of deps.readView().tree) {
      setNodeSubtreeSelection(node, true, subtreeSet, selfSet);
    }
    persistFolderSelection(subtreeSet, selfSet);
    refreshFilterFolderSelectionState();
}
function invertSelection() {
    if (!deps.readView().tree || deps.readView().tree.length === 0) return;
    var subtreeSet = getFolderSubtreeSet();
    var selfSet = getFolderSelfSet();
    var allSubtreePaths = /** @type {string[]} */ ([]);
    var allSelfPaths = /** @type {string[]} */ ([]);
    collectFolderNodePaths(deps.readView().tree, allSubtreePaths, allSelfPaths);
    var nextSubtreeSet = new Set(/** @type {string[]} */ ([]));
    var nextSelfSet = new Set();
    for (const path of allSelfPaths) {
      if (!selfSet.has(path) && !deps.selection.folderPathCovered(path, subtreeSet)) nextSelfSet.add(path);
    }
    persistFolderSelection(nextSubtreeSet, nextSelfSet);
    refreshFilterFolderSelectionState();
}

/** @param {number} routeId */
function retain(routeId) { for (const task of folderTreeRenderQueue) task.route = routeId; }

    return { render: renderFilterFolderTree, refresh: refreshFilterFolderSelectionState, updateControls: updateFolderTreeControls, initialize: initializeFolderTreeCollapsed, setAllCollapsed: setAllFoldersCollapsed, persistSelection: persistFolderSelection, selectAll, invertSelection, retain, cancel: cancelFolderTreeRendering, animate: toggleFolderChildrenAnimated, pending: () => folderTreeRenderQueue.length };
  }
  globalThis.VoiceOfMLSidebarFolderTree = { create };
})();
