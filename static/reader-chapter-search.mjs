export function createChapterSearch(configuration) {
  const worker = new Worker("/search/static/reader-chapter-search-worker.mjs", { type: "module" });
  let sequence = 0, pending = null, disposed = false, session = null, failure = null;
  const cancelPending = () => {
    pending?.reject(new DOMException("Search cancelled", "AbortError"));
    pending = null;
  };
  worker.onmessage = ({ data }) => {
    if (!pending || pending.id !== data.id) return;
    const task = pending;
    pending = null;
    if (data.error) task.reject(new Error(data.error));
    else { session = data.session; task.resolve(data); }
  };
  worker.onerror = event => {
    event.preventDefault();
    failure = new Error("全文搜索组件加载失败，请重试");
    pending?.reject(failure);
    pending = null;
  };
  worker.postMessage({ type: "init", configuration });
  function request(type, values) {
    if (disposed) return Promise.reject(new DOMException("Reader closed", "AbortError"));
    if (failure) return Promise.reject(failure);
    cancelPending();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending = { id, resolve, reject };
      worker.postMessage({ type, id, ...values });
    });
  }
  return {
    get failed() { return !!failure; },
    search: query => request("search", { query }),
    page: offset => request("page", { offset, session }),
    cancel() { cancelPending(); session = null; worker.postMessage({ type: "cancel" }); },
    dispose() { disposed = true; cancelPending(); worker.terminate(); }
  };
}

// Match the bundle's normalized text while retaining exact DOM offsets.
export function chapterTextMap(roots) {
  const runs = [], chunks = [];
  let length = 0, pendingSpace = null;
  const decoder = document.createElement("textarea");
  const append = (text, node, start, end, linear) => {
    if (!text) return;
    if (pendingSpace && length) {
      chunks.push(" ");
      runs.push({ ...pendingSpace, from: length, to: ++length, linear: false });
    }
    pendingSpace = null;
    chunks.push(text);
    runs.push({ node, start, end, linear, from: length, to: length + text.length });
    length += text.length;
  };
  for (const root of roots.filter(Boolean)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest("script,style,noscript,.reader-chapter-link-error")) continue;
      if (length) pendingSpace = { node: null, start: 0, end: 0 };
      const pattern = /&(?:#[xX][0-9a-fA-F]+;?|#\d+;?|[a-zA-Z][a-zA-Z0-9]+;?)|[\s\u0085\u001c-\u001f]+|[^&\s\u0085\u001c-\u001f]+|&/gu;
      for (const match of node.data.matchAll(pattern)) {
        const raw = match[0], start = match.index, end = start + raw.length;
        let text = raw;
        if (raw.startsWith("&")) { decoder.innerHTML = raw; text = decoder.value; }
        if (/^[\s\u0085\u001c-\u001f]+$/u.test(text)) {
          pendingSpace ||= { node, start, end };
        } else append(text, node, start, end, text === raw);
      }
    }
  }
  return {
    text: chunks.join(""),
    parts(start, end, body) {
      const output = [];
      for (const run of runs) {
        if (run.to <= start || run.from >= end || !run.node || !body.contains(run.node)) continue;
        const part = { node: run.node,
          start: run.linear ? run.start + Math.max(start - run.from, 0) : run.start,
          end: run.linear ? run.end - Math.max(run.to - end, 0) : run.end };
        const last = output[output.length - 1];
        if (last?.node === part.node) last.end = part.end;
        else output.push(part);
      }
      return output;
    }
  };
}
