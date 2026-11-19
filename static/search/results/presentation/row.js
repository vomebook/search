// Row markup and clones; cache invalidation and virtual geometry stay in the host.
(function () {
  /** @param {VoiceOfMLResultRowDependencies} deps */
  function create(deps) {
    const { escapeHTML, highlightText, getFileIconType, formatSize, getRecordLink,
      getCopyableLink, getRecordPath, getPreviewLink, readerAction, icons } = deps;
    /** @param {VoiceOfMLResultRecord} rec @param {number} idx */
    function buildHTML(rec, idx) {
      const view = deps.readView();
      const fileName = escapeHTML(rec.File + (rec.Extension ? '.' + rec.Extension : ''));
      const iconType = /** @type {string} */ (getFileIconType(rec.Extension));
      const titleHTML = highlightText(rec.File, view.query);
      const repoShort = escapeHTML((rec.Repo || "").split("/").pop());
      const sizeStr = formatSize(rec.Size);
      const recordLink = getRecordLink(rec);
      const action = readerAction(rec, recordLink);
      const readerActionUrl = action.url;
      const folders = rec.Folder || [], pathSeparator = '<span class="path-sep">/</span>';
      let prefix = "", breadcrumb = "";
      for (const [index, folder] of folders.entries()) {
        prefix += (index ? "/" : "") + (folder ?? "");
        if (!(index in folders)) continue;
        const path = escapeHTML(prefix);
        const folderDisplay = view.searchFolders ? highlightText(folder, view.query) : escapeHTML(folder);
        const separator = index < folders.length - 1 ? pathSeparator : "";
        breadcrumb += `<span role="button" tabindex="0" class="path-folder" aria-label="筛选路径：${path}" data-folder="${path}" data-repo="${repoShort}">${folderDisplay}${separator}</span>`;
      }
      const repoSeparator = folders.length ? pathSeparator : "";
      return (
        '<input type="checkbox" class="result-checkbox" aria-label="选择文件：' + fileName + '" data-index="' + idx + '">' +
        '<div class="result-file-icon" aria-hidden="true">' + (icons[iconType] || icons.file) + '</div>' +
        '<div class="result-info">' +
          '<div class="result-title">' + titleHTML +
            (rec.Extension ? '<span style="opacity:0.5;font-size:12px">.' + escapeHTML(rec.Extension) + '</span>' : '') +
          '</div>' +
          '<div class="result-path"><span role="button" tabindex="0" class="path-folder" aria-label="筛选仓库路径：' + repoShort + '" data-folder="" data-repo="' + repoShort + '">' + repoShort + repoSeparator + '</span>' + breadcrumb + '</div>' +
          '<div class="result-meta">' +
            (view.mode === "global" ? '<button type="button" class="result-repo-tag" aria-label="打开仓库：' + repoShort + '" data-repo="' + repoShort + '">' + repoShort + '</button>' : '') +
            (sizeStr ? '<span class="result-size">' + sizeStr + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="result-actions">' +
          '<button class="result-action-btn" aria-label="复制链接：' + fileName + '" data-action="copy" data-link="' + escapeHTML(getCopyableLink(recordLink)) + '">复制链接</button>' +
          '<button class="result-action-btn primary" aria-label="下载：' + fileName + '" data-action="download" data-filename="' + fileName + '" data-link="' + escapeHTML(recordLink) + '">下载</button>' +
          '<a href="' + escapeHTML(getPreviewLink(getRecordPath(rec))) + '" aria-label="仓库查看：' + fileName + '（新窗口）" class="result-action-btn" target="_blank" rel="noopener noreferrer">仓库查看</a>' +
          (readerActionUrl ? '<button class="result-action-btn" aria-label="' + action.label + '：' + fileName + '" data-action="read" data-reader-url="' + escapeHTML(readerActionUrl) + '">' + action.label + '</button>' : '') +
        '</div>'
      );
    }
    /** @param {VoiceOfMLResultRecord | null | undefined} rec @param {number} idx */
    function createRow(rec, idx) {
      if (!rec) return deps.placeholder(idx);
      const cache = deps.templates;
      let template = cache.get(idx);
      if (!template) {
        template = document.createElement("div");
        template.className = "result-item" + (idx % 2 === 1 ? " is-alt" : "");
        template.dataset.index = String(idx);
        template.dataset.contentVersion = String(deps.contentVersion());
        template.innerHTML = buildHTML(rec, idx);
        cache.set(idx, template);
        if (cache.size > 240) cache.delete(/** @type {number} */ (cache.keys().next().value));
      } else {
        cache.delete(idx);
        cache.set(idx, template);
      }
      const row = /** @type {HTMLDivElement} */ (template.cloneNode(true));
      row.tabIndex = -1;
      row.setAttribute('role', 'listitem');
      row.setAttribute('aria-label', rec.File + (rec.Extension ? '.' + rec.Extension : ''));
      deps.bindRecord(row, rec);
      return row;
    }
    return { buildHTML, createRow };
  }
  globalThis.VoiceOfMLResultRows = { create };
})();
