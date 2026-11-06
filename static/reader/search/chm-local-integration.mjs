// LOCAL TEST WORKTREE ONLY: never enable this adapter on an HTTPS production
// origin. It is a disposable integration of a separately verified experiment,
// not a release or transaction authorization.
const PAIRS = new Map([
  ["chapters/ebook/chm/8b1e4e4a539a58757be5d1012861f3cacda416e39ee461e1ea521d95921009ce/18ba3952389e349e/chapter-manifest.json",
   ["8b1e4e4a539a58757be5d1012861f3cacda416e39ee461e1ea521d95921009ce", "bc50c5be8c985411", "faceaee9d91d694ef57d914f2bd86f16889798558a7f34fd3afca902bca2f203"]],
  ["chapters/ebook/chm/a30c4f7dc0d7ee59778e252ec4e49757d8ab4cf142d2798257030c483c09f4e0/ec25ac797cc0bee4/chapter-manifest.json",
   ["a30c4f7dc0d7ee59778e252ec4e49757d8ab4cf142d2798257030c483c09f4e0", "1d4db6aed8930887", "fa620692f26f61c70534ca82098c3cbd580010ae7e94eeb415099f6cc69d1655"]],
  ["chapters/ebook/chm/a72ce4c104a891febdfdb90f1a40171b0edb7435b8e6251801a43989c67a88f1/f71b585b61ea8b3b/chapter-manifest.json",
   ["a72ce4c104a891febdfdb90f1a40171b0edb7435b8e6251801a43989c67a88f1", "551923a5166cf5b8", "1df3c9e92e02a3f28475b6b2bcb2cd90d57c2eda6f56252eb8c80aa0ca1f847c"]]
]);

const bucket = path => `https://voiceofml-search.hf.space/api/reader-bucket-resource?path=${encodeURIComponent(path)}`;
async function sha256(bytes) {
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function localCandidateSearch(context, manifestUrl, manifestBytes) {
  if (!["127.0.0.1", "localhost"].includes(location.hostname)) return null;
  let url;
  try { url = new URL(manifestUrl); } catch (_) { return null; }
  if (url.origin !== "https://voiceofml-search.hf.space" || url.pathname !== "/api/reader-bucket-resource" ||
      url.username || url.password || url.hash || [...url.searchParams.keys()].join() !== "path") return null;
  const path = url.searchParams.get("path"), pair = PAIRS.get(path);
  if (!pair) return null;
  const [source, oldVersion, expectedManifest] = pair;
  if (await sha256(manifestBytes) !== expectedManifest) throw new Error("本地 CHM 搜索测试：章节清单校验失败");
  const sourceBytes = manifestBytes.slice(), candidateRoot = path.slice(0, -"chapter-manifest.json".length);
  const oldRoot = `chapters/ebook/chm/${source}/${oldVersion}/`;
  let pending = null;
  const acquire = async () => {
    if (pending) return pending.promise;
    const controller = new AbortController();
    const readerSignal = context.readerAbortController.signal;
    const abort = () => controller.abort(readerSignal.reason);
    if (readerSignal.aborted) abort();
    else readerSignal.addEventListener("abort", abort, {once:true});
    const record = {controller, promise:null, complete:false};
    record.promise = (async () => {
      const bytes = async (path, limit) => {
        const response = await context.fetchReaderUrl(bucket(path), { signal: controller.signal });
        if (!response.ok) throw new Error(`本地 CHM 搜索测试：HTTP ${response.status}`);
        return VoiceOfMLReaderSecurity.readBytes(response, limit);
      };
      const [oldManifestBytes, oldIndexBytes, candidateIndexBytes, mapper, experiment] = await Promise.all([
        bytes(oldRoot + "chapter-manifest.json", VoiceOfMLReaderSecurity.LIMITS.manifestBytes),
        bytes(oldRoot + "epub-search-index.json.gz", 64 * 1024 * 1024),
        bytes(candidateRoot + "epub-search-index.json.gz", 64 * 1024 * 1024),
        context.chapterSearchModule(), import("/__chm-local-experiment.mjs")
      ]);
      const bridge = await experiment.prepareLocalLegacySearch({source, oldManifestBytes,
        candidateManifestBytes: sourceBytes, oldIndexBytes, candidateIndexBytes, mapper: mapper.chapterTextMap,
        signal: controller.signal});
      controller.signal.throwIfAborted();
      const original = JSON.parse(new TextDecoder().decode(oldManifestBytes));
      const index = {...original.search_index, url: bucket(oldRoot + original.search_index.path)};
      // Search metadata must not clone the old multi-megabyte text back into
      // the worker: the worker independently fetches and hashes the index.
      const chapters = original.chapters.map(({index, path, title}) => ({index, path, title}));
      record.complete = true;
      return {bridge, configuration: {chapters, index}};
    })().catch(error => { if (pending === record) pending = null; throw error; })
      .finally(() => readerSignal.removeEventListener("abort", abort));
    pending = record;
    return record.promise;
  };
  const cancel = () => {
    if (!pending || pending.complete) return;
    const record = pending;
    pending = null;
    record.controller.abort(new DOMException("Search cancelled", "AbortError"));
  };
  const dispose = () => {
    if (!pending) return;
    const record = pending;
    pending = null;
    if (!record.complete) record.controller.abort(new DOMException("Reader closed", "AbortError"));
  };
  return Object.freeze({source, acquire, cancel, dispose});
}
