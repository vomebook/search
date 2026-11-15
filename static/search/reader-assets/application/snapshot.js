// Reader asset sidecar ownership; site-specific behavior is retained.
(function () {
/** @param {ReaderAssetDependencies} deps */
function create(deps) {
/** @type {ReaderAssetState} */
const state = { assets: null, pending: null, retryAt: 0, converted: null, byRepo: null, convertedPending: null };
const scheduling = VoiceOfMLReaderAssetScheduling.create(deps);
const transport = VoiceOfMLReaderAssetTransport.create(deps, scheduling);
const CONVERTED_READER_BATCH_SIZE = 256;
/** @param {boolean} [deferDecode] */
function loadReaderAssets(deferDecode) {
  if (!deferDecode) {
    scheduling.state.delayUntilPaint = false;
    if (scheduling.state.parseWake) scheduling.state.parseWake();
  }
  if (state.assets) return Promise.resolve(state.assets);
  if (Date.now() < state.retryAt) return Promise.resolve({});
  if (state.pending) return state.pending;
  state.pending = transport.fetchReaderAssetMap(deferDecode === true).then(function(assets) {
    state.assets = assets;
    state.retryAt = 0;
    state.converted = null;
    state.byRepo = null;
    return state.assets;
  }).catch(function() {
    state.retryAt = Date.now() + 5000;
    return {};
  }).finally(function() { state.pending = null; });
  return state.pending;
}

/** @template {VoiceOfMLResultRecord & {extension?: string}} T @param {T} record @param {string} repo @param {string} relativePath @param {string} originalLink @returns {T} */
function applyReaderAsset(record, repo, relativePath, originalLink) {
  var asset = state.assets && state.assets[repo + "\0" + relativePath];
  var fields = VoiceOfMLReader.assetFields(asset, deps.bucketBase, String(record.Extension || record.extension || ""));
  return fields ? Object.assign({}, record, fields, { DownloadLink: originalLink }) : record;
}

/** @param {string} [repo] @returns {Promise<VoiceOfMLResultRecord[]>} */
async function getConvertedReaderRecords(repo) {
  // The sidecar can have tens of thousands of entries. Build one complete
  // snapshot in small tasks so a first click or filter change cannot block UI.
  while (state.assets && !state.converted) {
    const snapshot = state.assets;
    if (!state.convertedPending || state.convertedPending.snapshot !== snapshot) {
      /** @type {ReaderAssetConvertedPending} */
      const pending = { snapshot, promise: null };
      pending.promise = (async function() {
        /** @type {VoiceOfMLResultRecord[]} */
        const all = [];
        /** @type {Record<string, VoiceOfMLResultRecord[]>} */
        const byRepo = Object.create(null);
        const keys = Object.keys(snapshot);
        for (let i = 0; i < keys.length; i++) {
          if (state.assets !== snapshot) return;
          const key = /** @type {string} */ (keys[i]);
          const separator = key.indexOf("\0");
          if (separator > 0) {
            const sourceRepo = key.substring(0, separator);
            const relativePath = key.substring(separator + 1);
            const parts = relativePath.split("/");
            const filename = parts.pop() || "";
            const dot = filename.lastIndexOf(".");
            if (sourceRepo.startsWith("VoiceOfML/") && dot > 0 && !parts.some(function(part) { return !part || part === "." || part === ".."; })) {
              const record = { Repo: sourceRepo, File: filename.substring(0, dot), Extension: filename.substring(dot + 1), Folder: parts, HasTxt: false };
              const originalLink = deps.buildRecordLink(record);
              const converted = applyReaderAsset(record, sourceRepo, relativePath, originalLink);
              if (converted !== record) {
                all.push(converted);
                (byRepo[sourceRepo] || (byRepo[sourceRepo] = [])).push(converted);
              }
            }
          }
          if ((i + 1) % CONVERTED_READER_BATCH_SIZE === 0 && i + 1 < keys.length) {
            await scheduling.yieldConvertedReaderBuild();
          }
        }
        if (state.assets === snapshot) {
          state.converted = all;
          state.byRepo = byRepo;
        }
      })();
      state.convertedPending = pending;
    }
    const pending = state.convertedPending;
    try { await pending.promise; }
    finally { if (state.convertedPending === pending) state.convertedPending = null; }
  }
  if (!state.converted) return [];
  return repo ? (/** @type {Record<string, VoiceOfMLResultRecord[]>} */ (state.byRepo)[repo] || []) : state.converted;
}

return { state, scheduling, transport, loadReaderAssets, applyReaderAsset, getConvertedReaderRecords };
}

globalThis.VoiceOfMLReaderAssets = { create };
})();
