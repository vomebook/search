// Bounded scheduling hints, not PDF parsing or page identities.
export const PDF_ADAPTIVE_CHUNK_BYTES = 16384;
export const PDF_DEFAULT_CHUNK_BYTES = 262144;
export const PDF_LARGE_FLAT_CHUNK_BYTES = 32768;
const PDF_LARGE_FLAT_HEADER_BYTES = 65536;
const PDF_LARGE_FLAT_DICTIONARY_BYTES = 15000;
const PDF_MIN_SPARSE_PAGES = 128;

/** @param {Uint8Array} bytes @param {number} total @param {number} chunkSize */
export function firstPageSectionEnd(bytes, total, chunkSize) {
  // A bounded scheduling hint, not a PDF parser. Only a direct, internally
  // consistent first-object linearization dictionary can justify first-page
  // lookahead. PDF.js remains the authority for all content and rendering.
  // Keep this section disjoint from the already scheduled two-chunk tail.
  if (total <= chunkSize * 6) return 0;
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const object = /** @type {(RegExpExecArray & [string, string]) | null} */ (/\b\d+\s+\d+\s+obj\s*<<([^]*?)>>/.exec(header));
  if (!object || object.index > 1024 || !/\/Linearized\s+1(?:\.0+)?(?=[\s/>]|$)/.test(object[1])) return 0;
  /** @param {string} name */
  const integer = name => {
    const match = new RegExp("/" + name + "\\s+(\\d+)(?=[\\s/\\[\\]<>]|$)").exec(object[1]);
    if (!match || /^\s+\d+\s+R\b/.test(object[1].slice(match.index + match[0].length))) return NaN;
    return Number(match[1]);
  };
  const length = integer("L"), end = integer("E"), firstPage = /\/P\s/.test(object[1]) ? integer("P") : 0;
  if (length !== total || firstPage !== 0 || !Number.isSafeInteger(end) || end <= chunkSize ||
      end >= total || end > chunkSize * 4) return 0;
  return Math.min(total, Math.ceil(end / chunkSize) * chunkSize);
}

// A separately downloaded, bounded tail hint can overlap PDF.js's normal
// two-chunk trailer read. It is only a transport hint: no PDF object, page
// count or identity is derived from these bytes. Restrict it to the rare
// large-parent, page-first layout recognized below and to fresh page-one opens.
/** @param {unknown} bytes @param {number} total @param {number} chunkSize */
export function firstPageTailHintStart(bytes, total, chunkSize) {
  if (!(bytes instanceof Uint8Array) || total <= chunkSize * 8 ||
      !isFirstPageCandidate(bytes,total,chunkSize)) return 0;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0,4096));
  const first = /** @type {(RegExpExecArray & [string, string]) | null} */ (/(?:^|[\r\n])\s*\d+\s+\d+\s+obj\s*<<([^]*?)>>/.exec(head));
  const parent = first && /\/Parent\s+(\d+)\s+\d+\s+R(?=[\s/>]|$)/.exec(first[1]);
  if (!first || !/\/Type\s*\/Page(?=[\s/>]|$)/.test(first[1]) || !parent ||
      !Number.isSafeInteger(Number(parent[1])) || Number(parent[1]) < 2048) return 0;
  const tail = Math.floor((total - 1) / chunkSize) * chunkSize - chunkSize;
  return Math.max(chunkSize,tail - chunkSize * 3);
}

// A bounded read-ahead hint only: recognize the first direct image stream in
// the validated opening bytes. It must be complete as a dictionary before
// stream data begins, and its direct length must fit in three more bootstrap
// chunks. PDF.js still resolves the current catalog/page tree and consumes
// original bytes; this never supplies a page identity, total, or decoded image.
/** @param {unknown} bytes @param {number} total @param {number} chunkSize */
export function firstImageSectionEnd(bytes, total, chunkSize) {
  if (!(bytes instanceof Uint8Array) || total <= chunkSize * 6) return 0;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, PDF_LARGE_FLAT_HEADER_BYTES)));
  if (!head.startsWith("%PDF-") || /\/Linearized\b/.test(head.slice(0,1024))) return 0;
  const header = /(?:^|[\r\n])\s*\d+\s+\d+\s+obj\s*<</g;
  let object, scanned = 0, image = null, firstPage = null;
  while ((object = header.exec(head)) && scanned++ < 64) {
    const endObject = head.indexOf("endobj",header.lastIndex), stream = /\bstream(?:\r\n|\r|\n)/g;
    stream.lastIndex = header.lastIndex;
    const match = stream.exec(head);
    if (!match || (endObject >= 0 && endObject < match.index)) {
      if (endObject < 0) return 0;
      const body = head.slice(object.index,endObject);
      if (!firstPage && /\/Type\s*\/Page(?=[\s/>]|$)/.test(body)) firstPage = body;
      header.lastIndex = endObject + 6;
      continue;
    }
    const dictionary = head.slice(object.index,match.index);
    if (!/>>\s*$/.test(dictionary)) return 0;
    const lengths = [...dictionary.matchAll(/\/Length\s+(\d+)(?!\s+\d+\s+R)(?=[\s/>]|$)/g)];
    if (lengths.length !== 1) return 0;
    const length = Number(/** @type {RegExpMatchArray} */ (lengths[0])[1]), streamEnd = match.index + match[0].length + length;
    if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(streamEnd)) return 0;
    if (/\/Type\s*\/XObject(?=[\s/>]|$)/.test(dictionary) && /\/Subtype\s*\/Image(?=[\s/>]|$)/.test(dictionary)) {
      if (streamEnd <= chunkSize || streamEnd > chunkSize * 4 || streamEnd >= total - chunkSize * 2) return 0;
      const id = /** @type {(RegExpExecArray & [string, string, string]) | null} */ (/(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\s*<</.exec(object[0]));
      if (!id || id[1].length > 15 || id[2].length > 15 ||
          !Number.isSafeInteger(Number(id[1])) || !Number.isSafeInteger(Number(id[2]))) return 0;
      image = {number:id[1],generation:id[2],end:Math.ceil(streamEnd / chunkSize) * chunkSize};
      break;
    }
    // Only cross a previous stream when its direct length and terminators fit
    // completely in the bounded header; never scan binary data for objects.
    if (streamEnd >= head.length || !/^\s*endstream\b/.test(head.slice(streamEnd))) return 0;
    const afterStream = head.indexOf("endobj",streamEnd);
    if (afterStream < 0) return 0;
    header.lastIndex = afterStream + 6;
  }
  if (!image) return 0;
  // Do not speculate on an unrelated image. In the already received, bounded
  // prefix, require a page resource dictionary to name this exact image ref.
  // This is still only a hint; PDF.js resolves the real page independently.
  const safe = head.slice(0,/** @type {RegExpExecArray} */ (object).index), resources = firstPage && /** @type {(RegExpExecArray & [string, string, string]) | null} */ (/\/Resources\s+(\d+)\s+(\d+)\s+R(?=[\s/>]|$)/.exec(firstPage));
  if (!resources || resources[1].length > 15 || resources[2].length > 15 ||
      !Number.isSafeInteger(Number(resources[1])) || !Number.isSafeInteger(Number(resources[2]))) return 0;
  const resourceHeader = new RegExp(String.raw`(?:^|[\r\n])\s*${resources[1]}\s+${resources[2]}\s+obj\s*<<`,"g");
  const matches = [...safe.matchAll(resourceHeader)];
  if (matches.length !== 1) return 0;
  const resourceEnd = safe.indexOf("endobj",/** @type {RegExpMatchArray} */ (matches[0]).index);
  if (resourceEnd < 0) return 0;
  const resourceBody = safe.slice(/** @type {RegExpMatchArray} */ (matches[0]).index,resourceEnd);
  const ref = new RegExp(String.raw`/[^\s/<>\[\]()]+\s+${image.number}\s+${image.generation}\s+R(?=[\s/>\]]|$)`);
  if (!/\/XObject(?=[\s/<]|$)/.test(resourceBody) || !ref.test(resourceBody)) return 0;
  return image.end;
}

// This is a scheduling hint, not a PDF parser or a source of page identities.
// For a directly declared large flat /Pages node, PDF.js still validates the
// entire page tree, but its dispersed metadata is cheaper to read in smaller
// chunks. Ambiguous, indirect or compressed structures keep the normal path.
/** @param {unknown} bytes @param {number} total @param {number} fallback */
export function choosePdfRangeChunkSize(bytes, total, fallback = PDF_DEFAULT_CHUNK_BYTES) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(total) || total < 8 * 1024 * 1024 ||
      !Number.isSafeInteger(fallback) || fallback !== PDF_DEFAULT_CHUNK_BYTES) return fallback;
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, PDF_ADAPTIVE_CHUNK_BYTES));
  if (!head.startsWith('%PDF-') || /\/Linearized\b/.test(head.slice(0, 1024))) return fallback;
  const objectHeader = /(?:^|[\r\n])\s*\d+\s+\d+\s+obj\s*<</g;
  const stream = /\bstream(?:\r\n|\r|\n)/.exec(head);
  // Never match a fake object inside a preceding stream. If an object is
  // incomplete in the bounded prefix, stay on the standard range strategy.
  const stop = stream ? stream.index : head.length;
  let object;
  while ((object = objectHeader.exec(head)) && object.index < stop) {
    const end = head.indexOf('endobj', objectHeader.lastIndex);
    if (end < 0 || end > stop) break;
    const text = head.slice(object.index, end);
    objectHeader.lastIndex = end + 6;
    if (!/\/Type\s*\/Pages(?=[\s/>]|$)/.test(text)) continue;
    const count = /\/Count\s+(\d+)(?!\s+\d+\s+R)(?=[\s/>]|$)/.exec(text);
    const kids = /** @type {(RegExpExecArray & [string, string]) | null} */ (/\/Kids\s*\[([^\]]*)\]/.exec(text));
    if (!count || !kids || Number(count[1]) < PDF_MIN_SPARSE_PAGES) continue;
    // Counting only conventional indirect references avoids relying on random
    // byte strings in an arbitrary content stream or on a malformed array.
    const refs = kids[1].match(/\b\d+\s+\d+\s+R\b/g) || [];
    if (refs.length < PDF_MIN_SPARSE_PAGES || refs.length > 4096 || refs.length > Number(count[1]) ||
        kids[1].replace(/\b\d+\s+\d+\s+R\b/g, '').trim() !== '') continue;
    const numbers = refs.map(ref => Number.parseInt(ref, 10));
    if (!numbers.every(Number.isSafeInteger)) continue;
    let ordered = true;
    for (let i = 1; i < numbers.length; i++)
      if (/** @type {number} */ (numbers[i]) <= /** @type {number} */ (numbers[i - 1])) { ordered = false; break; }
    if (!ordered) continue;
    // Sequential page objects are typically clustered even in flat trees;
    // leave those PDFs on the normal larger chunks. This deliberately misses
    // some edge cases rather than penalizing ordinary books.
    if (/** @type {number} */ (numbers[numbers.length - 1]) - /** @type {number} */ (numbers[0]) >= refs.length * 2) return PDF_ADAPTIVE_CHUNK_BYTES;
  }
  return chooseLargeFlatTreeChunkSize(bytes, total, fallback);
}

/** @param {Uint8Array} bytes @param {number} total @param {number} fallback */
function chooseLargeFlatTreeChunkSize(bytes, total, fallback) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, PDF_LARGE_FLAT_HEADER_BYTES)));
  if (!head.startsWith('%PDF-') || /\/Linearized\b/.test(head.slice(0, 1024))) return fallback;
  // Walk only complete direct-length objects. Skip stream bytes exactly; this
  // remains a scheduling hint and PDF.js validates every real page object.
  let cursor = head.indexOf('\n') + 1;
  const line = /(?:^|[\r\n])\s*\d+\s+\d+\s+obj\s*<</g;
  for (let scanned = 0; scanned < 64; scanned++) {
    line.lastIndex = Math.max(0, cursor - 1);
    const object = line.exec(head);
    if (!object || line.lastIndex - object.index > 4096) return fallback;
    const gap = object.index < cursor ? '' : head.slice(cursor, object.index);
    if (gap.replace(/%[^\r\n]*/g, '').trim()) return fallback;
    let pos = line.lastIndex, depth = 1;
    while (pos < head.length && depth) {
      if (head.startsWith('<<', pos)) { depth++; pos += 2; continue; }
      if (head.startsWith('>>', pos)) { depth--; pos += 2; continue; }
      if (head[pos] === '(') {
        let nested = 1; pos++;
        while (pos < head.length && nested) {
          if (head[pos] === '\\') { pos += 2; continue; }
          if (head[pos] === '(') nested++;
          else if (head[pos] === ')') nested--;
          pos++;
        }
        if (nested) return fallback;
        continue;
      }
      if (head[pos] === '<') {
        const close = head.indexOf('>', pos + 1);
        if (close < 0) return fallback;
        pos = close + 1; continue;
      }
      if (head[pos] === '%') {
        const close = head.indexOf('\n', pos + 1);
        if (close < 0) return fallback;
        pos = close + 1; continue;
      }
      pos++;
    }
    if (depth || pos - line.lastIndex > PDF_LARGE_FLAT_DICTIONARY_BYTES) return fallback;
    const dictionary = head.slice(line.lastIndex, pos - 2);
    // Avoid interpreting strings, comments or nested dictionaries as a direct
    // Length/Pages field. The original detector handles its own old cases.
    const simpleDictionary = /^[^()%<>]*$/.test(dictionary);
    const suffix = head.slice(pos);
    const stream = /^\s*stream(?:\r\n|\r|\n)/.exec(suffix);
    if (stream) {
      // Arrays/dictionaries may contain a misleading nested /Length token.
      // Only a flat scalar stream dictionary can justify skipping bytes.
      if (!simpleDictionary || /[\[\]{}]/.test(dictionary)) return fallback;
      const lengths = [...dictionary.matchAll(/\/Length\s+(\d+)(?!\s+\d+\s+R)(?=[\s/>]|$)/g)];
      if (lengths.length !== 1 || (dictionary.match(/\/Length(?=[\s/>]|$)/g) || []).length !== 1) return fallback;
      const length = Number(/** @type {RegExpMatchArray} */ (lengths[0])[1]);
      const end = pos + stream[0].length + length;
      if (!Number.isSafeInteger(length) || !Number.isSafeInteger(end) || end > head.length) return fallback;
      const closing = /^\s*endstream\s*endobj(?=[\s]|$)/.exec(head.slice(end));
      if (!closing) return fallback;
      cursor = end + closing[0].length;
      continue;
    }
    const closing = /^\s*endobj(?=[\s]|$)/.exec(suffix);
    if (!closing) return fallback;
    // No arrays other than the single direct Kids array may contribute
    // tokens to the page-tree proof.
    if (simpleDictionary && /\/Type\s*\/Pages(?=[\s/>]|$)/.test(dictionary)) {
      if (["Type", "Count", "Kids"].some(name =>
        (dictionary.match(new RegExp("/" + name + "(?=[\\s/\\[\\]<>]|$)", "g")) || []).length !== 1)) return fallback;
      const arrays = [...dictionary.matchAll(/\[[^\[\]]*\]/g)];
      const directKidsOnly = arrays.length === 1 &&
        /\/Kids\s*\[[^\[\]]*\]/.test(dictionary) &&
        !/[\[\]{}]/.test(dictionary.replace(/\[[^\[\]]*\]/g, ''));
      if (!directKidsOnly) return fallback;
      const count = /\/Count\s+(\d+)(?!\s+\d+\s+R)(?=[\s/>]|$)/.exec(dictionary);
      const kids = /** @type {(RegExpExecArray & [string, string]) | null} */ (/\/Kids\s*\[([^\]]*)\]/.exec(dictionary));
      if (count && kids && Number(count[1]) >= PDF_MIN_SPARSE_PAGES) {
        const refs = kids[1].match(/\b\d+\s+\d+\s+R\b/g) || [];
        if (refs.length >= PDF_MIN_SPARSE_PAGES && refs.length <= 4096 && refs.length <= Number(count[1]) &&
            kids[1].replace(/\b\d+\s+\d+\s+R\b/g, '').trim() === '') {
          const numbers = refs.map(ref => Number.parseInt(ref,10));
          const tail = numbers.slice(1);
          const ordered = tail.every((number,index) => Number.isSafeInteger(number) &&
            (!index || number > /** @type {number} */ (tail[index-1])));
          const firstNumber = /** @type {number} */ (numbers[0]);
          if (Number.isSafeInteger(firstNumber) && ordered && !tail.includes(firstNumber)) {
            const min = Math.min(...numbers), max = Math.max(...numbers);
            if (max - min >= refs.length * 2) return PDF_LARGE_FLAT_CHUNK_BYTES;
          }
        }
      }
    }
    cursor = pos + closing[0].length;
  }
  return fallback;
}

// A scheduling hint only: PDF.js still parses and validates the original tree.
// Recognize a bounded large two-child root (cover plus remaining subtree),
// without inspecting stream contents or scanning the entire document.
/** @param {unknown} bytes @param {number} total @param {number} rangeChunkSize */
export function isFirstPageCandidate(bytes, total, rangeChunkSize) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(total) || total < 8 * 1024 * 1024) return false;
  if (rangeChunkSize === PDF_ADAPTIVE_CHUNK_BYTES || rangeChunkSize === PDF_LARGE_FLAT_CHUNK_BYTES) return true;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, PDF_ADAPTIVE_CHUNK_BYTES));
  if (!head.startsWith("%PDF-")) return false;
  const first = /** @type {(RegExpExecArray & [string, string]) | null} */ (/(?:^|[\r\n])\s*\d+\s+\d+\s+obj\s*<<([^]*?)>>/.exec(head.slice(0, 4096)));
  const stream = /\bstream(?:\r\n|\r|\n)/.exec(head);
  if (first && /\/Linearized\s+1(?:\.0+)?(?=[\s/>]|$)/.test(first[1])) {
    const length = /\/L\s+(\d+)(?!\s+\d+\s+R)(?=[\s/>]|$)/.exec(first[1]);
    return !!length && Number.isSafeInteger(Number(length[1])) && Number(length[1]) > 0 && Number(length[1]) <= total;
  }
  // Some large PDFs begin with a page dictionary but put their edited page
  // tree at the end. An indirect parent number is only a hint that the
  // tree may be expensive; never use it to infer which page this object is,
  // or to publish a count. The staged worker still asks PDF.js for page one
  // and performs the same last-page validation and recovery as every other
  // staged candidate. An ambiguous or incomplete first object stays normal.
  if (first && first.index < 1024 && (!stream || stream.index > first.index + first[0].length) &&
      /\/Type\s*\/Page(?=[\s/>]|$)/.test(first[1])) {
    const parent = /\/Parent\s+(\d+)\s+(\d+)\s+R(?=[\s/>]|$)/.exec(first[1]);
    const end = head.indexOf("endobj", first.index + first[0].length);
    if (parent && Number.isSafeInteger(Number(parent[1])) && Number(parent[1]) >= 2048 &&
        Number.isSafeInteger(Number(parent[2])) && end >= 0 && end < 4096 &&
        (!stream || end < stream.index)) {
      const pageObject = head.slice(first.index,end);
      if (/>>\s*$/.test(pageObject) && /\/Contents(?=[\s/\[>]|$)/.test(pageObject) &&
          /\/Resources(?=[\s/<>]|$)/.test(pageObject)) return true;
    }
  }
  const stop = stream ? stream.index : head.length;
  const objects = /(?:^|[\r\n])\s*\d+\s+\d+\s+obj\s*<</g;
  let object;
  while ((object = objects.exec(head)) && object.index < stop) {
    const end = head.indexOf("endobj", objects.lastIndex);
    if (end < 0 || end > stop) return false;
    const text = head.slice(object.index, end);
    objects.lastIndex = end + 6;
    if (!/\/Type\s*\/Pages(?=[\s/>]|$)/.test(text)) continue;
    const count = /\/Count\s+(\d+)(?!\s+\d+\s+R)(?=[\s/>]|$)/.exec(text);
    const kids = /** @type {(RegExpExecArray & [string, string]) | null} */ (/\/Kids\s*\[([^\]]*)\]/.exec(text));
    if (!count || Number(count[1]) < PDF_MIN_SPARSE_PAGES || !kids) continue;
    const refs = kids[1].match(/\b\d+\s+\d+\s+R\b/g) || [];
    if (refs.length === 2 && kids[1].replace(/\b\d+\s+\d+\s+R\b/g, "").trim() === "") return true;
  }
  return false;
}
