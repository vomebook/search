/// <reference path="../../../typings/reader-search-controller-strict.d.ts" />

// Shared search presentation and task ownership; format matching stays in Reader.
/** @param {ReaderSearchController.Options} options */
export function createReaderSearchController({
  document, runtime, signal, nextGeneration, isCurrent, updateSearch,
  backend, navigation, panel
}) {
  const search = /** @type {{query: string, results: ReaderSearchController.Result[], index: number}} */ (runtime.state.search);
  /** @type {ReaderSearchController.State} */
  const state = {
    page: null, failedPage: null, complete: false, pageLoader: null
  };
  /** @type {{generation: number, mode: string | null} | null} */
  let initialSearch = null;
  /** @type {number | null} */
  let resultNavigation = null;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let inputTimer = 0;
  let disposed = false, confirmedNoText = false;
  let searchViewActive = false;
  /** @type {ReaderSearchController.Result[]} */
  let renderedResults = [];
  let renderedOffset = -1;
  /** @type {(() => void)[]} */
  const listeners = [];
  const active = () => !disposed && !signal.aborted;
  /** @param {number} generation */
  const current = generation => active() && isCurrent(generation);
  const busy = () => initialSearch !== null && current(initialSearch.generation);

  const view = document.createElement("section");
  view.id = "full-search-view";
  view.className = "reader-panel-view full-search-view";
  view.dataset.panelView = "full-search";
  view.setAttribute("role", "region");
  view.setAttribute("aria-label", "全文搜索");
  view.hidden = true;
  view.innerHTML =
    '<div class="full-search-bar"><input id="full-search-input" class="full-search-input" type="search" placeholder="搜索正文" aria-label="搜索正文"><button id="full-search-clear" class="icon-button" type="button" aria-label="清除全文搜索" title="清除">×</button></div><div id="full-search-status" class="full-search-status" role="status">输入关键词搜索正文</div><div class="full-search-nav"><button id="full-search-prev" type="button" disabled>上一个</button><button id="full-search-next" type="button" disabled>下一个</button></div><div id="full-search-results" class="full-search-results"></div>';
  /** @type {HTMLElement} */ (document.querySelector("#history-panel")).insertBefore(view, document.querySelector(".reader-panel-tabs"));
  const button = /** @type {HTMLButtonElement} */ (document.querySelector("#full-search-toggle"));
  button.textContent = "全文搜索";
  button.setAttribute("aria-label", "全文搜索");
  button.setAttribute("aria-controls", view.id);
  button.setAttribute("aria-expanded", "false");
  const input = /** @type {HTMLInputElement} */ (view.querySelector("#full-search-input"));
  const status = /** @type {HTMLElement} */ (view.querySelector("#full-search-status"));
  status.setAttribute("aria-atomic", "true");
  input.setAttribute("aria-describedby", status.id);
  const results = /** @type {HTMLElement} */ (view.querySelector("#full-search-results"));
  const clear = /** @type {HTMLButtonElement} */ (view.querySelector("#full-search-clear"));
  clear.hidden = true;
  const pagination = document.createElement("div");
  pagination.className = "full-search-pagination";
  pagination.hidden = true;
  pagination.innerHTML =
    '<button id="full-search-page-prev" type="button">上一页</button><label>第 <input id="full-search-page" type="number" min="1" value="1" aria-label="搜索结果页码"> 页 <span id="full-search-pages"></span></label><button id="full-search-page-next" type="button">下一页</button>';
  results.before(pagination);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "full-search-cancel";
  cancel.className = "text-action";
  cancel.textContent = "取消搜索";
  cancel.hidden = true;
  status.after(cancel);
  const retry = document.createElement("button");
  retry.type = "button";
  retry.id = "full-search-retry";
  retry.className = "text-action";
  retry.textContent = "重试搜索";
  retry.hidden = true;
  cancel.after(retry);

  /** @param {EventTarget} target @param {string} type @param {EventListener} callback */
  function listen(target, type, callback) {
    target.addEventListener(type, callback);
    listeners.push(() => target.removeEventListener(type, callback));
  }
  function clearInputTimer() {
    clearTimeout(inputTimer);
    inputTimer = 0;
  }
  /** @param {boolean} open */
  function updateButton(open) {
    button.textContent = open ? "关闭全文搜索" : "全文搜索";
    button.setAttribute("aria-label", button.textContent);
    button.setAttribute("aria-expanded", String(open));
  }
  function updateClear() {
    clear.hidden = !input.value;
  }
  /** @param {number} step */
  const nextResultIndex = step => search.index < 0 ? (step > 0 ? 0 : -1) : search.index + step;
  function updateNavigation() {
    const lockPage = !!state.page && busy();
    for (const [selector, step] of /** @type {const} */ ([["#full-search-prev", -1], ["#full-search-next", 1]])) {
      const next = nextResultIndex(step);
      /** @type {HTMLButtonElement} */ (view.querySelector(selector)).disabled = !search.results.length ||
        (lockPage && (next < 0 || next >= search.results.length));
    }
  }
  function updatePagination() {
    const page = state.page;
    pagination.hidden = !page || !page.total;
    if (!page) return;
    const pages = Math.ceil(page.total / page.pageSize);
    const pageInput = /** @type {HTMLInputElement} */ (pagination.querySelector("#full-search-page"));
    pageInput.value = String(Math.floor(page.offset / page.pageSize) + 1);
    pageInput.max = String(Math.max(1, pages));
    pageInput.style.setProperty("--page-width", `${pageInput.max.length}ch`);
    /** @type {HTMLElement} */ (pagination.querySelector("#full-search-pages")).textContent = `/ ${pages}`;
    /** @type {HTMLButtonElement} */ (pagination.querySelector("#full-search-page-prev")).disabled = busy() || page.offset === 0;
    /** @type {HTMLButtonElement} */ (pagination.querySelector("#full-search-page-next")).disabled = busy() || page.offset + page.pageSize >= page.total;
    pageInput.disabled = busy();
  }
  /** @param {ReaderSearchController.Snippet} snippet */
  function snippetDom(snippet) {
    const node = document.createElement("span");
    node.className = "full-search-snippet";
    if (snippet.prefix) node.append(snippet.prefix);
    node.append(snippet.text.slice(0, snippet.matchStart));
    const mark = document.createElement("mark");
    mark.className = "search-match";
    mark.textContent = snippet.text.slice(snippet.matchStart, snippet.matchStart + snippet.matchLength);
    node.append(mark, snippet.text.slice(snippet.matchStart + snippet.matchLength));
    if (snippet.suffix) node.append(snippet.suffix);
    return node;
  }
  function render() {
    updatePagination();
    updateNavigation();
    const offset = state.page?.offset || 0;
    if (renderedOffset === offset && results.childElementCount === search.results.length &&
        renderedResults.length === search.results.length &&
        search.results.every((result, index) => result === renderedResults[index])) return;
    const fragment = document.createDocumentFragment();
    for (const [index, result] of search.results.entries()) {
      const row = document.createElement("button");
      const location = document.createElement("small");
      row.type = "button";
      row.className = "full-search-result";
      location.className = "full-search-location";
      location.textContent = result.location;
      const rank = document.createElement("span");
      rank.className = "full-search-rank";
      rank.textContent = `${offset + index + 1}.`;
      row.append(rank, location, snippetDom(result.snippet));
      row.addEventListener("click", () => activate(index));
      fragment.appendChild(row);
    }
    results.replaceChildren(fragment);
    renderedResults = search.results.slice();
    renderedOffset = offset;
  }
  function resetResults(query = search.query) {
    state.complete = false;
    initialSearch = null;
    state.page = state.failedPage = state.pageLoader = null;
    updateSearch({ query, results: [], index: -1 });
    render();
  }
  function supersedeSearchNavigation(hasQuery = false) {
    // Blank input must leave restoration and other navigation alone, but may
    // still cancel an unfinished jump to a result that is being cleared.
    if (hasQuery || (resultNavigation !== null && navigation.current(resultNavigation))) navigation.begin();
  }
  function cancelPending(hasQuery = false) {
    clearInputTimer();
    nextGeneration();
    supersedeSearchNavigation(hasQuery);
    backend.chapterClient()?.cancel();
    backend.pdfClient()?.cancel();
    resetResults();
  }
  function close() {
    const restoreFocus = view.contains(document.activeElement);
    const closingButtonFocused = document.activeElement === button;
    clearInputTimer();
    const interrupted = busy();
    const mode = initialSearch?.mode;
    nextGeneration();
    initialSearch = null;
    if (interrupted) {
      if (mode === "epub-chapters") backend.chapterClient()?.cancel();
      else if (mode === "pdf" || mode === "pdf-pages") backend.pdfClient()?.cancel();
      resetResults();
    }
    cancel.hidden = retry.hidden = true;
    panel.hide();
    updateButton(false);
    const hiding = confirmedNoText || button.hidden;
    if ((restoreFocus || (hiding && closingButtonFocused)) && panel.isOpen())
      (hiding ? /** @type {HTMLElement} */ (document.querySelector("#history")) : button).focus({ preventScroll: true });
    if (confirmedNoText) button.hidden = true;
  }
  function resetAvailability() {
    confirmedNoText = false;
  }
  async function run() {
    if (!active()) return;
    clearInputTimer();
    const query = input.value.trim();
    const generation = nextGeneration();
    backend.pdfClient()?.cancel();
    supersedeSearchNavigation(!!query);
    backend.clearMarks();
    resetResults(query);
    retry.hidden = true;
    retry.textContent = "重试搜索";
    cancel.hidden = !query;
    if (!query) {
      backend.chapterClient()?.cancel();
      status.textContent = "输入关键词搜索正文";
      return;
    }
    const owner = { generation, mode: backend.mode() };
    initialSearch = owner;
    const ownsSearch = () => initialSearch === owner && current(generation);
    status.textContent = "正在搜索正文…";
    try {
      await backend.search(query, generation);
      if (!ownsSearch()) return;
      state.complete = true;
      render();
      const total = state.page?.total ?? search.results.length;
      status.textContent = total ? `${total}${!state.page && total === 100 ? "+" : ""} 个结果` : "未找到正文匹配";
    } catch (error) {
      if (ownsSearch()) {
        const failure = /** @type {{code?: string, message?: string} | null | undefined} */ (error);
        const noText = failure?.code === "READER_NO_SEARCHABLE_TEXT";
        status.textContent = noText ? "此文件没有可搜索文字" : (failure?.message || "正文搜索不可用");
        retry.hidden = noText;
        if (noText) {
          confirmedNoText = true;
          if (!panel.isOpen() || view.hidden) button.hidden = true;
        }
      }
    } finally {
      if (ownsSearch()) {
        initialSearch = null;
        updatePagination();
        cancel.hidden = true;
        updateNavigation();
      }
    }
  }
  /** @param {ReaderSearchController.Page<ReaderSearchController.ChapterResult>} page */
  function applyChapterPage(page) {
    state.page = page;
    updateSearch({ results: page.results.map(backend.chapterResult), index: -1 });
  }
  /** @param {number} offset @param {boolean | null} [selectLast] */
  async function loadPage(offset, selectLast = null) {
    if (!active()) return;
    if (busy()) { updatePagination(); return; }
    if (!state.page || (!backend.chapterClient() && !state.pageLoader)) return;
    state.failedPage = null;
    const generation = nextGeneration();
    navigation.begin();
    if (backend.mode() !== "epub-chapters") cancel.hidden = false;
    retry.hidden = true;
    status.textContent = `${state.page.total} 个结果`;
    try {
      const loader = state.pageLoader;
      const client = loader ? null : backend.chapterClient();
      if (!loader && !client) return;
      const page = loader ? await loader(offset, generation) : await /** @type {NonNullable<typeof client>} */ (client).page(offset);
      if (!current(generation)) return;
      if (loader) {
        state.page = page;
        updateSearch({ results: /** @type {ReaderSearchController.Result[]} */ (page.results), index: -1 });
      } else applyChapterPage(/** @type {ReaderSearchController.Page<ReaderSearchController.ChapterResult>} */ (page));
      render();
      status.textContent = `${page.total} 个结果`;
      if (selectLast !== null) await activate(selectLast ? page.results.length - 1 : 0, false);
    } catch (error) {
      if (current(generation)) {
        status.textContent = /** @type {{message?: string} | null} */ (error)?.message || "搜索结果加载失败";
        state.failedPage = { offset, selectLast, query: search.query };
        retry.textContent = "重试本页";
        retry.hidden = false;
      }
    } finally {
      if (current(generation)) cancel.hidden = true;
    }
  }
  /** @param {number} index @param {boolean} [closePanel] */
  async function activate(index, closePanel = true) {
    if (!active()) return;
    const result = search.results[index];
    if (!result) return;
    const previousIndex = search.index;
    const panelSerial = panel.serial();
    const searchGeneration = runtime.currentGeneration("search");
    const generation = navigation.begin();
    resultNavigation = generation;
    const ownsResult = () => current(searchGeneration) && search.results[index] === result;
    updateSearch({ index });
    updateNavigation();
    try {
      const activated = await backend.activate(result, generation);
      if (activated === false && navigation.current(generation) && ownsResult()) {
        updateSearch({ index: previousIndex });
        updateNavigation();
        status.textContent = "搜索结果定位失败，请重试";
        return;
      }
      if (activated === false || !navigation.current(generation) || search.results[index] !== result) return;
      if (status.textContent === "搜索结果定位失败，请重试")
        status.textContent = `${state.page?.total ?? search.results.length} 个结果`;
      if (closePanel && panelSerial === panel.serial() && current(searchGeneration)) panel.close();
      else if (!closePanel) results.children[index]?.scrollIntoView({ block: "nearest" });
    } catch (error) {
      const failure = /** @type {{name?: string, message?: string} | null | undefined} */ (error);
      if (failure?.name !== "AbortError" && navigation.current(generation) && ownsResult()) {
        updateSearch({ index: previousIndex });
        updateNavigation();
        status.textContent = backend.mode() === "epub-chapters"
          ? failure?.message || "搜索结果定位失败，请重试" : "搜索结果定位失败，请重试";
      }
      navigation.reportError(error, generation);
    } finally {
      if (resultNavigation === generation) resultNavigation = null;
    }
  }
  /** @param {number} step */
  function move(step) {
    const page = state.page;
    if (page?.total) {
      const next = nextResultIndex(step);
      if (next < 0) return loadPage(page.offset ? page.offset - page.pageSize
        : Math.floor((page.total - 1) / page.pageSize) * page.pageSize, true);
      if (next >= search.results.length) return loadPage(
        page.offset + page.pageSize < page.total ? page.offset + page.pageSize : 0, false);
      return activate(next, false);
    }
    if (search.results.length) return activate((search.index + step + search.results.length) % search.results.length, false);
    return undefined;
  }
  function toggle() {
    if (!active()) return;
    if (panel.isOpen() && !view.hidden) return close();
    panel.show();
    updateButton(true);
    updateClear();
    input.focus();
    // Activating a partial row closes the panel, not the still-owned scan.
    if (search.query !== input.value.trim() || (!state.complete && !busy())) run();
    else if (state.failedPage) retry.hidden = false;
  }
  function queue() {
    if (!active()) return;
    const hasQuery = !!input.value.trim();
    cancelPending(hasQuery);
    cancel.hidden = retry.hidden = true;
    status.textContent = hasQuery ? "正在搜索正文…" : "输入关键词搜索正文";
    inputTimer = setTimeout(run, 180);
  }

  listeners.push(runtime.events.on("state:panel", event => {
    const { panel: state } = /** @type {{panel: {open: boolean, selected: string}}} */ (event);
    const activeView = state.open && state.selected === "full-search";
    if (searchViewActive && !activeView && confirmedNoText) button.hidden = true;
    searchViewActive = activeView;
    updateButton(activeView);
  }));

  listen(retry, "click", async () => {
    const failed = state.failedPage;
    if (!failed || search.query !== failed.query) return run();
    if (backend.chapterClient()?.failed) {
      await run();
      if (!state.complete || search.query !== failed.query) return;
    }
    return loadPage(failed.offset, failed.selectLast);
  });
  listen(cancel, "click", () => {
    cancelPending();
    cancel.hidden = true;
    retry.hidden = false;
    retry.textContent = "重试搜索";
    status.textContent = "搜索已取消";
  });
  listen(/** @type {Element} */ (pagination.querySelector("#full-search-page-prev")), "click", () => {
    return state.page ? loadPage(state.page.offset - state.page.pageSize) : undefined;
  });
  listen(/** @type {Element} */ (pagination.querySelector("#full-search-page-next")), "click", () => {
    return state.page ? loadPage(state.page.offset + state.page.pageSize) : undefined;
  });
  listen(/** @type {Element} */ (pagination.querySelector("#full-search-page")), "change", event => {
    const target = /** @type {HTMLInputElement} */ (event.target);
    if (!state.page || !Number.isFinite(target.valueAsNumber)) return;
    const page = Math.max(1, Math.min(Math.ceil(state.page.total / state.page.pageSize), Math.floor(target.valueAsNumber)));
    const offset = (page - 1) * state.page.pageSize;
    if (offset !== state.page.offset) loadPage(offset);
  });
  listen(button, "click", toggle);
  listen(input, "input", event => { updateClear(); if (!/** @type {InputEvent} */ (event).isComposing) queue(); });
  listen(input, "focus", panel.focus);
  listen(input, "compositionend", queue);
  listen(clear, "click", () => { input.value = ""; updateClear(); run(); input.focus(); });
  listen(/** @type {Element} */ (view.querySelector("#full-search-prev")), "click", () => move(-1));
  listen(/** @type {Element} */ (view.querySelector("#full-search-next")), "click", () => move(1));

  function dispose() {
    if (disposed) return;
    disposed = true;
    initialSearch = null;
    clearInputTimer();
    for (const remove of listeners.splice(0)) remove();
    renderedResults = [];
    state.page = state.failedPage = state.pageLoader = null;
  }
  return Object.freeze({
    state, elements: Object.freeze({ view, button, input, status, results, pagination, cancel, retry }),
    render, updatePagination, applyChapterPage, loadPage, run, close, resetAvailability, activate, move, dispose
  });
}
