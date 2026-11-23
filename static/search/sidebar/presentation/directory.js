// Directory browsing: explicit view and effect ports, owned lifecycle.
(function () {
  /** @param {VoiceOfMLSidebarDirectoryViewDependencies} deps */
  function create(deps) {
/** @param {VoiceOfMLFilterCount[]} repos */
function renderRepoListItems(repos) {
  const previousKey = deps.scroll.activeKey;
  deps.scroll.activate("global");
  if (previousKey === "global") deps.scroll.remember();
  const focused = deps.content.contains(document.activeElement) ? document.activeElement?.closest('.repo-list-item') : null;
  var ordered = (repos || []).slice().sort(function(a, b) {
    return (a.count || 0) - (b.count || 0) ||
      String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
  });
  var html = "";
  for (var i = 0; i < ordered.length; i++) {
    var repo = /** @type {VoiceOfMLFilterCount} */ (ordered[i]);
    var short = repo.name.split("/").pop();
    var label = deps.escape(short);
    html += '<button type="button" class="repo-list-item" aria-label="打开仓库：' + label + '" data-repo="' + deps.escape(short) + '">';
    html += '<svg class="repo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
    html += '<span class="repo-name">' + label + '</span>';
    html += '<span class="repo-count">' + (repo.count || 0).toLocaleString() + '</span>';
    html += '</button>';
  }
  deps.content.innerHTML = html;
  deps.content.querySelectorAll('svg').forEach(node => node.setAttribute('aria-hidden', 'true'));
  if (focused) (Array.from(deps.content.querySelectorAll(/** @type {'button'} */ ('.repo-list-item')))
    .find(node => node.dataset.repo === /** @type {HTMLElement} */ (focused).dataset.repo) || deps.sidebar).focus({ preventScroll: true });
  deps.scroll.restore();
  deps.updateHeader();
}

/** @param {HTMLElement} list @param {VoiceOfMLSidebarEntries} data @param {string} currentRepo @param {string} path */
function renderBrowserListItems(list, data, currentRepo, path) {
  list.innerHTML = VoiceOfMLSearchSidebarRender.browserMarkup(data, currentRepo, path, deps.markup);
  deps.scroll.restore();
}

/** @param {string} path */
function createSidebarBreadcrumb(path) {
  const breadcrumb = document.createElement("div");
  breadcrumb.className = "sidebar-breadcrumb";
  breadcrumb.setAttribute("aria-label", "当前路径");
  const parts = path ? path.split("/") : [];
  let html = '<button type="button" class="crumb-item' + (!path ? ' current' : '') + '" ' + (!path ? 'aria-current="location"' : '') + ' data-path="">根目录</button>';
  let partPath = "";
  for (const [index, part] of parts.entries()) {
    partPath += (index ? "/" : "") + part;
    const current = index === parts.length - 1;
    html += '<span class="crumb-sep" aria-hidden="true">/</span>';
    html += '<button type="button" class="crumb-item' + (current ? ' current' : '') + '" ' + (current ? 'aria-current="location"' : '') + ' data-path="' + deps.escape(partPath) + '">' + deps.escape(part) + '</button>';
  }
  breadcrumb.innerHTML = html;
  breadcrumb.querySelectorAll(".crumb-item").forEach(function(item) {
    item.addEventListener("click", function() {
      if (!item.classList.contains("current")) deps.navigate(/** @type {HTMLElement} */ (item).dataset.path);
    });
  });
  return breadcrumb;
}
/** @param {string} path @param {() => string} readRepo */
function begin(path, readRepo) {
  const restoreFocus = deps.content.contains(document.activeElement);
  deps.setPath(path);
  deps.content.innerHTML = "";
  const currentRepo = readRepo();
  deps.content.appendChild(createSidebarBreadcrumb(path));
  if (restoreFocus) /** @type {HTMLElement} */ (deps.content.querySelector('.crumb-item.current')).focus({ preventScroll: true });
  const list = document.createElement("div");
  list.className = "browser-list";
  list.innerHTML = '<div class="sidebar-loading">加载中...</div>';
  deps.content.appendChild(list);
  return {list, currentRepo};
}
/** @param {string} html */
function message(html) { deps.content.innerHTML = html; }

    return { repos: renderRepoListItems, items: renderBrowserListItems, breadcrumb: createSidebarBreadcrumb, begin, message };
  }
  /** @type {typeof globalThis & {VoiceOfMLSidebarDirectoryView: typeof VoiceOfMLSidebarDirectoryView}} */
  const globals = globalThis;
  globals.VoiceOfMLSidebarDirectoryView = {create};
})();
