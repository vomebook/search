// Owns result-window feedback markup. Layout values and retry actions come
// from the host, so this view does not read scroll state or commit results.
(function () {
  /** @param {VoiceOfMLWindowStatusOptions} options */
  function update(options) {
    const window = options.window;
    let status = document.getElementById("search-window-status");
    if (!status && window && (window.invalid || window.failures.size)) {
      status = document.createElement("div");
      status.id = "search-window-status";
      status.setAttribute("role", "status");
      status.innerHTML = '<span></span> <button type="button" class="text-btn-sm"></button>';
      /** @type {HTMLButtonElement} */ (status.querySelector("button")).onclick = options.retry;
      const host = options.getHost();
      if (!host) return;
      host.appendChild(status);
    }
    if (status) {
      status.hidden = !window || (!window.invalid && !window.failures.size);
      /** @type {HTMLSpanElement} */ (status.querySelector("span")).textContent = window?.invalid ? "搜索数据已更新" : "部分结果暂时无法加载";
      /** @type {HTMLButtonElement} */ (status.querySelector("button")).textContent = window?.invalid ? "重新定位" : "重试加载";
    }
  }

  /** @param {VoiceOfMLWindowPlaceholderOptions} options */
  function createPlaceholder(options) {
    const {index, page, contentVersion, height, invalid, failed} = options;
    const row = document.createElement("div");
    row.className = "result-item result-window-placeholder";
    row.dataset.index = String(index);
    row.dataset.contentVersion = String(contentVersion);
    row.style.height = height + "px";
    if (invalid || failed) {
      const button = document.createElement("button");
      button.className = "text-btn-sm"; button.dataset.windowPage = String(page);
      button.textContent = invalid ? "数据已更新，点击重新定位" : "加载失败，点击重试";
      row.appendChild(button);
    } else {
      row.setAttribute("aria-label", "正在加载结果");
      row.innerHTML = '<div class="window-placeholder-lines" aria-hidden="true"><i></i><i></i></div>';
    }
    return row;
  }
  globalThis.VoiceOfMLResultWindowStatus = { update, createPlaceholder };
})();
