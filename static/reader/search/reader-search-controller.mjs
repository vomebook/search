// Shared search presentation and task ownership; format matching stays in Reader.
export function createReaderSearchController({
  document, runtime, signal, nextGeneration, isCurrent, updateSearch,
  backend, navigation, panel
}) {
  const search = runtime.state.search;
  const state = {
    page: null, failedPage: null, complete: false,
    pdfInProgress: false, chapterInProgress: false, pageLoader: null
  };
  let inputTimer = 0, disposed = false;
  let renderedResults = [], renderedOffset = -1;
  const listeners = [];
  const active = () => !disposed && !signal.aborted;
  const current = generation => active() && isCurrent(generation);
  const busy = () => state.pdfInProgress || state.chapterInProgress;
  const pagedMode = () => ["epub-chapters", "pdf", "pdf-pages", "foliate"].includes(backend.mode());

  const view = document.createElement("section");
  view.id = "full-search-view";
  view.className = "reader-panel-view full-search-view";
  view.dataset.panelView = "full-search";
  view.hidden = true;
  view.innerHTML =
    '<div class="full-search-bar"><input id="full-search-input" class="full-search-input" type="search" placeholder="搜索正文" aria-label="搜索正文"><button id="full-search-clear" class="icon-button" type="button" aria-label="清除全文搜索" title="清除">×</button></div><div id="full-search-status" class="full-search-status" role="status">输入关键词搜索正文</div><div class="full-search-nav"><button id="full-search-prev" type="button" disabled>上一个</button><button id="full-search-next" type="button" disabled>下一个</button></div><div id="full-search-results" class="full-search-results"></div>';
  document.querySelector("#history-panel").insertBefore(view, document.querySelector(".reader-panel-tabs"));
  const button = document.querySelector("#full-search-toggle");
  button.textContent = "全文搜索";
  button.setAttribute("aria-label", "全文搜索");
  const input = view.querySelector("#full-search-input");
  const status = view.querySelector("#full-search-status");
  const results = view.querySelector("#full-search-results");
  const clear = view.querySelector("#full-search-clear");
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

  function listen(target, type, callback) {
    target.addEventListener(type, callback);
    listeners.push(() => target.removeEventListener(type, callback));
  }
  function clearInputTimer() {
    clearTimeout(inputTimer);
    inputTimer = 0;
  }
  function updateButton(open) {
    button.textContent = open ? "关闭全文搜索" : "全文搜索";
    button.setAttribute("aria-label", button.textContent);
  }
  function updateClear() {
    clear.hidden = !input.value;
  }
  function updateNavigation() {
    view.querySelectorAll(".full-search-nav button").forEach(node => {
      node.disabled = !search.results.length;
    });
  }
  function updatePagination() {
    const page = state.page;
    pagination.hidden = !page || !page.total;
    if (!page) return;
    const pages = Math.ceil(page.total / page.pageSize);
    const pageInput = pagination.querySelector("#full-search-page");
    pageInput.value = String(Math.floor(page.offset / page.pageSize) + 1);
    pageInput.max = String(Math.max(1, pages));
    pageInput.style.setProperty("--page-width", `${pageInput.max.length}ch`);
    pagination.querySelector("#full-search-pages").textContent = `/ ${pages}`;
    pagination.querySelector("#full-search-page-prev").disabled = busy() || page.offset === 0;
    pagination.querySelector("#full-search-page-next").disabled = busy() || page.offset + page.pageSize >= page.total;
    pageInput.disabled = busy();
  }
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
    state.pdfInProgress = state.chapterInProgress = false;
    state.page = state.failedPage = state.pageLoader = null;
    updateSearch({ query, results: [], index: -1 });
    render();
  }
  function cancelPending() {
    clearInputTimer();
    nextGeneration();
    navigation.begin();
    backend.chapterClient()?.cancel();
    backend.pdfClient()?.cancel();
    resetResults();
  }
  function close() {
    clearInputTimer();
    if (busy()) state.complete = false;
    nextGeneration();
    if (state.chapterInProgress) backend.chapterClient()?.cancel();
    if (state.pdfInProgress) backend.pdfClient()?.cancel();
    state.pdfInProgress = state.chapterInProgress = false;
    cancel.hidden = retry.hidden = true;
    panel.hide();
    updateButton(false);
  }
  async function run() {
    if (!active()) return;
    clearInputTimer();
    const query = input.value.trim();
    const generation = nextGeneration();
    backend.pdfClient()?.cancel();
    navigation.begin();
    backend.clearMarks();
    resetResults(query);
    retry.hidden = true;
    retry.textContent = "重试搜索";
    cancel.hidden = !pagedMode() || !query;
    state.pdfInProgress = ["pdf", "pdf-pages", "foliate"].includes(backend.mode()) && !!query;
    state.chapterInProgress = backend.mode() === "epub-chapters" && !!query;
    if (!query) {
      backend.chapterClient()?.cancel();
      status.textContent = "输入关键词搜索正文";
      return;
    }
    status.textContent = "正在搜索正文…";
    try {
      await backend.search(query, generation);
      if (!current(generation)) return;
      state.complete = true;
      state.pdfInProgress = state.chapterInProgress = false;
      render();
      const total = state.page?.total ?? search.results.length;
      status.textContent = total ? `${total}${!state.page && total === 100 ? "+" : ""} 个结果` : "未找到正文匹配";
    } catch (error) {
      if (current(generation)) {
        status.textContent = error.message || "正文搜索不可用";
        retry.hidden = !pagedMode();
      }
    } finally {
      if (current(generation)) {
        state.pdfInProgress = state.chapterInProgress = false;
        updatePagination();
        cancel.hidden = true;
        updateNavigation();
      }
    }
  }
  function applyChapterPage(page) {
    state.page = page;
    updateSearch({ results: page.results.map(backend.chapterResult), index: -1 });
  }
  async function loadPage(offset, selectLast = null) {
    if (!active() || busy() || !state.page || (!backend.chapterClient() && !state.pageLoader)) return;
    state.failedPage = null;
    const generation = nextGeneration();
    navigation.begin();
    if (!["foliate", "epub-chapters"].includes(backend.mode())) cancel.hidden = false;
    retry.hidden = true;
    status.textContent = `${state.page.total} 个结果`;
    try {
      const loader = state.pageLoader;
      const page = await (loader ? loader(offset, generation) : backend.chapterClient().page(offset));
      if (!current(generation)) return;
      if (loader) {
        state.page = page;
        updateSearch({ results: page.results, index: -1 });
      } else applyChapterPage(page);
      render();
      status.textContent = `${page.total} 个结果`;
      if (selectLast !== null) await activate(selectLast ? page.results.length - 1 : 0, false);
    } catch (error) {
      if (current(generation)) {
        status.textContent = error.message || "搜索结果加载失败";
        state.failedPage = { offset, selectLast, query: search.query };
        retry.textContent = "重试本页";
        retry.hidden = false;
      }
    } finally {
      if (current(generation)) cancel.hidden = true;
    }
  }
  async function activate(index, closePanel = true) {
    if (!active()) return;
    const result = search.results[index];
    if (!result) return;
    const previousIndex = search.index;
    const panelSerial = panel.serial();
    const searchGeneration = runtime.currentGeneration("search");
    const generation = navigation.begin();
    const ownsResult = () => current(searchGeneration) && search.results[index] === result;
    updateSearch({ index });
    try {
      const activated = await backend.activate(result, generation);
      if (activated === false && navigation.current(generation) && ownsResult()) {
        updateSearch({ index: previousIndex });
        status.textContent = "搜索结果定位失败，请重试";
        return;
      }
      if (activated === false || !navigation.current(generation) || search.results[index] !== result) return;
      if (status.textContent === "搜索结果定位失败，请重试")
        status.textContent = `${state.page?.total ?? search.results.length} 个结果`;
      if (closePanel && panelSerial === panel.serial() && current(searchGeneration)) panel.close();
      else if (!closePanel) results.children[index]?.scrollIntoView({ block: "nearest" });
    } catch (error) {
      if (error?.name !== "AbortError" && navigation.current(generation) && ownsResult()) {
        updateSearch({ index: previousIndex });
        status.textContent = backend.mode() === "epub-chapters"
          ? error.message || "搜索结果定位失败，请重试" : "搜索结果定位失败，请重试";
      }
      navigation.reportError(error, generation);
    }
  }
  function move(step) {
    const page = state.page;
    if (page?.total) {
      const next = search.index < 0 ? (step > 0 ? 0 : -1) : search.index + step;
      if (next < 0) return loadPage(page.offset ? page.offset - page.pageSize
        : Math.floor((page.total - 1) / page.pageSize) * page.pageSize, true);
      if (next >= search.results.length) return loadPage(
        page.offset + page.pageSize < page.total ? page.offset + page.pageSize : 0, false);
      return activate(next, false);
    }
    if (search.results.length) return activate((search.index + step + search.results.length) % search.results.length, false);
  }
  function toggle() {
    if (!active()) return;
    if (panel.isOpen() && !view.hidden) return close();
    panel.show();
    updateButton(true);
    updateClear();
    input.focus();
    if (search.query !== input.value.trim() || !state.complete) run();
    else if (state.failedPage) retry.hidden = false;
  }
  function queue() {
    if (!active()) return;
    cancelPending();
    cancel.hidden = retry.hidden = true;
    status.textContent = input.value.trim() ? "正在搜索正文…" : "输入关键词搜索正文";
    inputTimer = setTimeout(run, 180);
  }

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
  listen(pagination.querySelector("#full-search-page-prev"), "click", () => loadPage(state.page.offset - state.page.pageSize));
  listen(pagination.querySelector("#full-search-page-next"), "click", () => loadPage(state.page.offset + state.page.pageSize));
  listen(pagination.querySelector("#full-search-page"), "change", event => {
    if (!state.page || !Number.isFinite(event.target.valueAsNumber)) return;
    const page = Math.max(1, Math.min(Math.ceil(state.page.total / state.page.pageSize), Math.floor(event.target.valueAsNumber)));
    const offset = (page - 1) * state.page.pageSize;
    if (offset !== state.page.offset) loadPage(offset);
  });
  listen(button, "click", toggle);
  listen(input, "input", event => { updateClear(); if (!event.isComposing) queue(); });
  listen(input, "focus", panel.focus);
  listen(input, "compositionend", queue);
  listen(clear, "click", () => { input.value = ""; updateClear(); run(); input.focus(); });
  listen(view.querySelector("#full-search-prev"), "click", () => move(-1));
  listen(view.querySelector("#full-search-next"), "click", () => move(1));

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInputTimer();
    for (const remove of listeners.splice(0)) remove();
    renderedResults = [];
    state.page = state.failedPage = state.pageLoader = null;
  }
  return Object.freeze({
    state, elements: Object.freeze({ view, button, input, status, results, pagination, cancel, retry }),
    render, updatePagination, applyChapterPage, loadPage, run, close, activate, move, dispose
  });
}
