// Sidebar feature: owns its rendering lifecycle; the host supplies a bounded view and effects.
(function () {
  /** @param {VoiceOfMLFilterListDependencies} deps */
  function create(deps) {
    let otherCollapsed = true;
/** @param {HTMLElement} container @param {VoiceOfMLFilterItem[]} items @param {VoiceOfMLFilterCount[]} rest @param {string[]} selected @param {(values: string[]) => void} onChange */
function renderExtensionTree(container, items, rest, selected, onChange) {
  if (items.length === 0 && rest.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--on-surface-variant);opacity:0.6;padding:4px 0">暂无</div>';
    return;
  }
  const selectedSet = new Set(selected);
  /** @param {Set<string>} selection */
  function otherState(selection) {
    let count = 0;
    for (const {name} of rest) if (selection.has(name)) count++;
    return { checked: count === rest.length, indeterminate: count > 0 && count < rest.length };
  }
  const initialOther = otherState(selectedSet);
  var html = [];
  for (const item of items) {
    html.push('<label class="filter-checkbox-item"><input type="checkbox" value="' + deps.escape(item.key) + '" ' + (selectedSet.has(item.key) ? 'checked' : '') + '><span>' + deps.escape(item.label) + '</span><span class="checkbox-count">' + (item.count || 0).toLocaleString() + '</span></label>');
  }
  if (rest.length > 0) {
    const total = rest.reduce((sum, item) => sum + (item.count || 0), 0);
    const collapsed = otherCollapsed;
    html.push('<div class="filter-folder-item ext-other-row" style="--fdepth:0"><input type="checkbox" value="__OTHER__" ' + (initialOther.checked ? 'checked' : '') + '><span class="ext-other-spacer" aria-hidden="true"></span><button type="button" class="ext-other-toggle" aria-expanded="' + (collapsed ? 'false' : 'true') + '">其他 (' + rest.length + '种)<span class="folder-count">' + total.toLocaleString() + '</span></button></div>');
    html.push('<div class="tree-children ext-other-children" style="display:' + (collapsed ? 'none' : 'block') + '">');
    var restSorted = rest.slice().sort(function(a, b) { return a.name.localeCompare(b.name); });
    for (const child of restSorted) {
      html.push('<label class="filter-folder-item" style="--fdepth:1"><span class="tree-toggle-placeholder"></span><input type="checkbox" value="' + deps.escape(child.name) + '" ' + (selectedSet.has(child.name) ? 'checked' : '') + '><span class="folder-name">.' + deps.escape(child.name) + '</span><span class="folder-count">' + (child.count || 0).toLocaleString() + '</span></label>');
    }
    html.push('</div>');
  }
  container.innerHTML = html.join("");
  const parent = /** @type {HTMLInputElement | null} */ (container.querySelector('input[value="__OTHER__"]'));
  if (parent) {
    parent.setAttribute('aria-label', '选择其他文件类型');
    parent.indeterminate = initialOther.indeterminate;
  }
  container.querySelectorAll(/** @type {'input'} */ ('input[type="checkbox"]')).forEach(function(cb) {
    cb.addEventListener("change", function() {
      const nextSet = new Set(deps.readSelection());
      if (cb.value === "__OTHER__") {
        for (const item of rest) {
          if (cb.checked) nextSet.add(item.name);
          else nextSet.delete(item.name);
        }
      } else if (cb.checked) nextSet.add(cb.value);
      else nextSet.delete(cb.value);
      container.querySelectorAll(/** @type {'input'} */ ('input[type="checkbox"]')).forEach(function(input) {
        if (input.value !== "__OTHER__") input.checked = nextSet.has(input.value);
      });
      if (parent) Object.assign(parent, otherState(nextSet));
      onChange(Array.from(nextSet));
    });
  });
  const toggleButton = container.querySelector(/** @type {"button"} */ (".ext-other-toggle"));
  if (toggleButton) {
    const children = /** @type {HTMLElement} */ (container.querySelector('.ext-other-children'));
    children.id = 'ext-other-children';
    children.inert = otherCollapsed;
    toggleButton.setAttribute('aria-controls', children.id);
    toggleButton.addEventListener("click", () => toggleExtensionOther(toggleButton));
  }
}

/** @param {HTMLElement} button */
function toggleExtensionOther(button) {
  const children = /** @type {HTMLElement | null} */ (button.parentElement && button.parentElement.nextElementSibling);
  if (!children || !children.classList.contains("ext-other-children")) return;
  const expanding = otherCollapsed;
  otherCollapsed = !expanding;
  button.setAttribute("aria-expanded", expanding ? "true" : "false");
  if (!expanding && children.contains(document.activeElement)) button.focus({ preventScroll: true });
  children.inert = !expanding;
  children.getAnimations().forEach(function(animation) { animation.cancel(); });
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    children.style.display = expanding ? 'block' : 'none';
    return;
  }
  if (expanding) {
    children.style.display = "block";
    children.animate([
      { height: "0px", opacity: 0, transform: "translateY(-4px)", overflow: "hidden" },
      { height: children.scrollHeight + "px", opacity: 1, transform: "translateY(0)", overflow: "hidden" },
    ], { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  } else {
    var animation = children.animate([
      { height: children.scrollHeight + "px", opacity: 1, transform: "translateY(0)", overflow: "hidden" },
      { height: "0px", opacity: 0, transform: "translateY(-4px)", overflow: "hidden" },
    ], { duration: 150, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    animation.addEventListener("finish", function() {
      if (otherCollapsed) children.style.display = "none";
    }, { once: true });
  }
}


/** @param {VoiceOfMLCheckboxContainer} container @param {VoiceOfMLFilterItem[]} items @param {string[]} selected @param {(values: string[]) => void} onChange */
function renderCheckboxList(container, items, selected, onChange) {
  if (items.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--on-surface-variant);opacity:0.6;padding:4px 0">暂无</div>';
    container._itemsKey = '';
    return;
  }
  const itemsKey = items.map(i => i.key).join(',') + '|' + items.map(i => i.count || 0).join(',');
  if (container._itemsKey !== itemsKey) {
    container.innerHTML = items.map(function(item) {
      return '<label class="filter-checkbox-item"><input type="checkbox" value="' + deps.escape(item.key) + '" ' + (selected.indexOf(item.key) >= 0 ? 'checked' : '') + '><span>' + deps.escape(item.label) + '</span>' + (item.count !== undefined ? '<span class="checkbox-count">' + item.count.toLocaleString() + '</span>' : '') + '</label>';
    }).join("");
    container._itemsKey = itemsKey;
    if (!container._hasDelegate) {
      container.addEventListener("change", function() {
        if (container._updating) return;
        container._onChange?.(Array.from(container.querySelectorAll(/** @type {"input"} */ ("input:checked"))).map(function(c) { return c.value; }));
      });
      container._hasDelegate = true;
    }
  } else {
    container._updating = true;
    container.querySelectorAll("input").forEach(function(cb) {
      cb.checked = selected.indexOf(cb.value) >= 0;
    });
    container._updating = false;
  }
  container._onChange = onChange;
}


    return { renderExtensionTree, renderCheckboxList };
  }
  globalThis.VoiceOfMLSidebarFilterList = { create };
})();
