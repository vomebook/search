// Virtual height state and cache growth. Prefix sums retain the existing height index.
(function () {
/** @returns {SearchVirtualState} */
function createState() {
const VSCROLL = {
  viewKey: "",
  renderStart: 0,
  renderEnd: 0,
  heights: [],
  heightsDirty: true,
  heightTree: [],
  templateCache: new Map(),
  templateCacheKey: "",
  contentVersion: 0,
  measuredWindowKey: "",
  measuredRowKeys: [],
  heightCache: new Map(),
  renderFrame: 0,
  renderAfterScroll: false,
  estimatedHeight: 60,
  sparseHeights: false,
  heightBase: 60,
  isDraggingThumb: false,
  lastScrollTop: 0,
  lastScrollTime: 0,
  scrollVelocity: 0,
  scrollDirection: 1,
};
return VSCROLL;
}
/** @param {SearchVirtualState} VSCROLL @param {SearchVirtualHeightDependencies} deps */
function create(VSCROLL, deps) {
const { getHeightMeasurementKey, getResultStableId } = deps;
function ensureHeightTree() {
  VoiceOfMLSearchHeightIndex.ensureTree(VSCROLL);
}

function getVirtualTotalHeight() {
  return VoiceOfMLSearchHeightIndex.totalHeight(VSCROLL);
}

/** @param {number} index */
function getVirtualOffset(index) {
  return VoiceOfMLSearchHeightIndex.offsetOf(VSCROLL, index);
}

/** @param {number} offset */
function findVirtualIndex(offset) {
  return VoiceOfMLSearchHeightIndex.indexAt(VSCROLL, offset);
}

/** @param {number} len */
function ensureVirtualHeights(len) {
  if (VSCROLL.heights.length >= len) return;
  const oldLen = VSCROLL.heights.length;
  if (VSCROLL.sparseHeights) {
    VSCROLL.heights.length = len; VSCROLL.measuredRowKeys.length = len;
    const measurementKey = getHeightMeasurementKey();
    const keys = deps.hasWindow() || deps.cloning() ? Object.keys(deps.results())
      : Array.from({length: len - oldLen}, (_, offset) => oldLen + offset);
    for (const key of keys) if (Number(key) >= oldLen) {
      const cached = VSCROLL.heightCache.get(getResultStableId(deps.results()[Number(key)]));
      if (cached?.measurementKey === measurementKey) VSCROLL.heights[Number(key)] = cached.height;
    }
    VSCROLL.heightsDirty = true;
    return;
  }
  const canExtendTree = !VSCROLL.heightsDirty && VSCROLL.heightTree.length === oldLen + 1;
  VSCROLL.heights.length = len;
  VSCROLL.measuredRowKeys.length = len;
  const measurementKey = getHeightMeasurementKey();
  for (let i = oldLen; i < len; i++) {
    const cached = VSCROLL.heightCache.get(getResultStableId(deps.results()[i]));
    VSCROLL.heights[i] = cached?.measurementKey === measurementKey
      ? cached.height
      : VSCROLL.estimatedHeight;
  }
  if (canExtendTree) {
    VoiceOfMLSearchHeightIndex.extendTree(VSCROLL, oldLen);
  } else {
    VSCROLL.heightsDirty = true;
  }
}
return { ensureHeightTree, getVirtualTotalHeight, getVirtualOffset, findVirtualIndex, ensureVirtualHeights };
}
globalThis.VoiceOfMLVirtualHeights = { createState, create };
})();
