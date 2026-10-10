// Transport is supplied by the Reader's cancellation/deadline-owned request manager.
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const positive = value => Number.isFinite(value) && value > 0;
const integer = value => Number.isSafeInteger(value) && value > 0;
const invalid = () => { throw new Error("PDF_V3_INVALID"); };
const modes = new Set(["auto", "horizontal-ltr", "horizontal-rtl", "vertical-rl", "vertical-lr"]);
const pathPattern = /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\/[0-9a-f]{16}\/(?:reading-manifest\.json|page-map\.json\.gz|text-layer-manifest\.json|text-review-manifest\.json|text\/(?:page-[0-9]{6}\.json\.gz|book-text\.json\.gz|search-[0-9]{6}-[0-9]{6}\.json\.gz|partition-[0-9]{6}-[0-9]{6}-manifest\.json)|preview\/(?:page-[0-9]{6}\.(?:png|webp|jpeg)|partition-[0-9]{6}-[0-9]{6}-manifest\.json))$/;
export const isV3Path = path => typeof path === "string" && pathPattern.test(path);
export function validateResource(ref, source = "") {
  if (!ref || !["vomebook/pdf-pages-v2", "vomebook/reader-assets-v2"].includes(ref.bucket) ||
      ref.role !== "runtime" || !sha(ref.sha256) || !integer(ref.bytes) ||
      !globalThis.VoiceOfMLReader.isBucketPath(ref.path, true, ref.bucket)) invalid();
  if (isV3Path(ref.path) && (ref.bucket !== "vomebook/pdf-pages-v2" ||
      (source && !ref.path.startsWith(`objects/${source.slice(0, 2)}/${source}/`)))) invalid();
  return ref;
}
function validBox(b) {
  return Array.isArray(b) && b.length === 4 && b.every(v => Number.isFinite(v) && v >= 0 && v <= 1) &&
    b[0] < b[2] && b[1] < b[3];
}
function validQuad(quad) {
  if (!Array.isArray(quad) || quad.length !== 4 || quad.some(point =>
      !Array.isArray(point) || point.length !== 2 || point.some(v => !Number.isFinite(v) || v < 0 || v > 1))) return false;
  let area = 0;
  for (let i = 0; i < 4; i++) area += quad[i][0] * quad[(i + 1) % 4][1] - quad[(i + 1) % 4][0] * quad[i][1];
  return Math.abs(area) > 2e-9;
}
export function validateTextLayer(layer, entry, source) {
  if (!layer || layer.version !== 1 || layer.kind !== "pdf-text-layer" || layer.source_sha256 !== source ||
      layer.page !== entry.page || !sha(layer.generation) || layer.generation !== entry.generation ||
      !sha(layer.raw_sha256) || !sha(layer.page_identity) || layer.page_identity !== entry.page_identity ||
      layer.offset_unit !== "unicode-codepoint" || typeof layer.text !== "string" ||
      !["raw", "accepted"].includes(layer.revision) || !["unreviewed", "partially-reviewed"].includes(layer.quality) ||
      !["processed", "processed-empty"].includes(layer.processing) ||
      layer.quality !== entry.quality || layer.processing !== entry.processing ||
      !positive(layer.geometry?.width) || !positive(layer.geometry?.height) ||
      layer.geometry.coordinate_space !== "normalized-page" || !Array.isArray(layer.regions) ||
      layer.regions.length > 10000) invalid();
  if ((layer.revision === "raw" && layer.quality !== "unreviewed") ||
      (layer.revision === "accepted" && (layer.quality !== "partially-reviewed" ||
        !sha(layer.parent_generation) || !Array.isArray(layer.acceptances) || !layer.acceptances.length))) invalid();
  const chars = Array.from(layer.text), ids = new Set();
  let end = 0;
  for (const [order, region] of layer.regions.entries()) {
    if (!region || typeof region.id !== "string" || ids.has(region.id) || region.order !== order ||
        !Number.isSafeInteger(region.start) || !Number.isSafeInteger(region.end) || region.start < end ||
        region.end <= region.start || region.end > chars.length || typeof region.text !== "string" ||
        chars.slice(region.start, region.end).join("") !== region.text || !validBox(region.box) ||
         !validQuad(region.quad) ||
        !modes.has(region.writing_mode) || !["ltr", "rtl", "mixed", "neutral"].includes(region.direction)) invalid();
    end = region.end;
    ids.add(region.id);
  }
  return layer;
}
export function partitionFor(partitions, page) {
  let low = 0, high = partitions.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (partitions[mid].start <= page) low = mid + 1;
    else high = mid;
  }
  const part = partitions[low - 1];
  return part && page <= part.end ? part : null;
}
function partitions(values, count, complete, source) {
  if (!Array.isArray(values)) invalid();
  let end = 0;
  for (const part of values) {
    if (!integer(part.start) || !integer(part.end) || part.start <= end || part.end < part.start ||
        part.end > count || (complete && part.start !== end + 1)) invalid();
    validateResource(part.resource, source);
    end = part.end;
  }
  if (complete && end !== count) invalid();
}
export function createV3Repository({ readJson, readBytes, resourceUrl, signal, pageCount, sourceSha }) {
  const cache = new Map(), pending = new Map();
  let bytes = 0, disposed = false, index = null, textPending = null, indexKey = "";
  const active = () => { if (disposed || signal?.aborted) throw new DOMException("Reader closed", "AbortError"); };
  async function read(ref, source = sourceSha) {
    active();
    validateResource(ref, source);
    const key = ref.bucket + ":" + ref.path + ":" + ref.sha256;
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached.value; }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 8) throw new Error("PDF_V3_BUSY");
    const task = Promise.resolve().then(() => readJson(resourceUrl(ref), ref)).then(value => {
      active();
      const size = JSON.stringify(value).length * 2;
      if (size <= 2 * 1024 * 1024) {
        cache.set(key, { value, size }); bytes += size;
        while (cache.size > 4 || bytes > 2 * 1024 * 1024) {
          const oldest = cache.keys().next().value;
          bytes -= cache.get(oldest).size; cache.delete(oldest);
        }
      }
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }
  async function textIndex(ref) {
    active(); validateResource(ref, sourceSha);
    const key = ref.bucket + ":" + ref.path + ":" + ref.sha256;
    if (indexKey && indexKey !== key) throw new Error("PDF_V3_GENERATION_CHANGED");
    indexKey = key;
    if (index) return index;
    if (!textPending) textPending = read(ref).then(value => {
      if (value.version !== 1 || value.kind !== "pdf-text-layer-index" || value.complete !== true ||
          value.source_sha256 !== sourceSha || value.page_count !== pageCount || !sha(value.generation) ||
          !["raw", "effective"].includes(value.revision) || value.offset_unit !== "unicode-codepoint") invalid();
      partitions(value.partitions, pageCount, true, sourceSha);
      validateResource(value.book_text, sourceSha);
      if (!value.book_text.path.endsWith("/text/book-text.json.gz")) invalid();
      if (value.search_partitions !== undefined) {
        partitions(value.search_partitions, pageCount, true, sourceSha);
        for (const part of value.search_partitions) {
          if (part.end - part.start >= 32 || !part.resource.path.endsWith(
            `/text/search-${String(part.start).padStart(6, "0")}-${String(part.end).padStart(6, "0")}.json.gz`)) invalid();
        }
      }
      active(); index = value; return value;
    }).catch(error => { textPending = null; throw error; });
    return textPending;
  }
  return {
    read,
    textIndex,
    async textPage(ref, page) {
      if (!integer(page) || page > pageCount) invalid();
      const root = await textIndex(ref), part = partitionFor(root.partitions, page);
      const value = await read(part.resource);
      if (value.version !== 1 || value.kind !== "pdf-text-partition" || value.source_sha256 !== sourceSha ||
          value.generation !== root.generation || value.start !== part.start || value.end !== part.end ||
          !Array.isArray(value.pages) || value.pages.length !== part.end - part.start + 1 ||
          value.pages.some((p, i) => p.page !== part.start + i)) invalid();
      const entry = value.pages[page - part.start];
      validateResource(entry.resource, sourceSha);
      if (!entry.resource.path.endsWith(`/text/page-${String(page).padStart(6, "0")}.json.gz`)) invalid();
      return validateTextLayer(await read(entry.resource), entry, sourceSha);
    },
    async preview(manifest, map, page) {
      active();
      const part = partitionFor(manifest.preview.partitions, page);
      if (!part) throw new Error("PDF_V3_PREVIEW_PENDING");
      const data = await read(part.resource);
      if (data.version !== 3 || data.kind !== "pdf-preview-partition" || data.source_sha256 !== sourceSha ||
          data.page_map_sha256 !== manifest.page_map.sha256 || data.start !== part.start || data.end !== part.end ||
          !Array.isArray(data.pages) || data.pages.length > part.end - part.start + 1) invalid();
      let previous = part.start - 1;
      for (const entry of data.pages) {
        if (!integer(entry.page) || entry.page <= previous || entry.page > part.end ||
            entry.page_identity !== map.pages[entry.page - 1].identity ||
            !["png", "webp", "jpeg"].includes(entry.codec) || !integer(entry.width) || !integer(entry.height)) invalid();
        const geometry = map.pages[entry.page - 1];
        if ((["bitonal-image", "unknown"].includes(geometry.classification) && entry.codec !== "png") ||
            Math.abs((entry.width / entry.height) / (geometry.width / geometry.height) - 1) > .01) invalid();
        validateResource(entry.resource, sourceSha);
        if (!entry.resource.path.endsWith(`/preview/page-${String(entry.page).padStart(6, "0")}.${entry.codec}`)) invalid();
        previous = entry.page;
      }
      if (part.complete && data.pages.length !== part.end - part.start + 1) invalid();
      const entry = data.pages.find(p => p.page === page);
      if (!entry) throw new Error("PDF_V3_PREVIEW_PENDING");
      const packed = await readBytes(resourceUrl(entry.resource), entry.resource);
      active();
      return { entry, blob: new Blob([packed], { type: `image/${entry.codec}` }) };
    },
    dispose() { disposed = true; cache.clear(); bytes = 0; index = null; }
  };
}
export function validateReadingManifest(manifest, maxPages) {
  if (!manifest || manifest.version !== 3 || manifest.kind !== "pdf-reading" ||
      !sha(manifest.source_sha256) || !sha(manifest.generation) || !integer(manifest.page_count) ||
      manifest.page_count > maxPages || typeof manifest.source_key !== "string" ||
      manifest.primary?.kind !== "pdf" || manifest.primary.status !== "ready" ||
      typeof manifest.preview?.complete !== "boolean" || manifest.preview.page_count !== manifest.page_count) invalid();
  validateResource(manifest.primary.resource);
  if (!manifest.primary.resource.path.endsWith(".pdf")) invalid();
  validateResource(manifest.page_map, manifest.source_sha256);
  if (!manifest.page_map.path.endsWith("/page-map.json.gz")) invalid();
  partitions(manifest.preview.partitions, manifest.page_count, manifest.preview.complete, manifest.source_sha256);
  if (!Number.isSafeInteger(manifest.preview.ready_pages) || manifest.preview.ready_pages < 0 ||
      manifest.preview.ready_pages > manifest.page_count ||
      (manifest.preview.complete && manifest.preview.ready_pages !== manifest.page_count)) invalid();
  if (manifest.preview.complete && manifest.preview.partitions.some(p => p.complete !== true)) invalid();
  if (manifest.text_layer) validateResource(manifest.text_layer, manifest.source_sha256);
  if (manifest.text_layer && !manifest.text_layer.path.endsWith("/text-layer-manifest.json")) invalid();
  if (manifest.components?.document !== "ready" ||
      manifest.components.preview !== (manifest.preview.complete ? "ready" : "pending") ||
      manifest.components.text !== (manifest.text_layer ? "ready" : "pending")) invalid();
  return manifest;
}
export function validatePageMap(map, manifest) {
  if (!map || map.version !== 1 || map.kind !== "pdf-page-map" || map.source_sha256 !== manifest.source_sha256 ||
      !Array.isArray(map.pages) || map.pages.length !== manifest.page_count || map.pages.some((p, i) =>
        p.page !== i + 1 || !sha(p.identity) || !positive(p.width) || !positive(p.height) ||
        ![0, 90, 180, 270].includes(p.rotation) || !Array.isArray(p.crop_box) || p.crop_box.length !== 4 ||
        !Array.isArray(p.media_box) || p.media_box.length !== 4 ||
        [...p.crop_box, ...p.media_box].some(v => !Number.isFinite(v)))) invalid();
  return map;
}
