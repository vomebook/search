// File size display and URL parsing. Keep the established parser behavior for
// existing links, including its fallback for non-standard numeric strings.
{
/** @param {number | null | undefined} bytes @returns {{value: string, unit: "B" | "KB" | "MB" | "GB"}} */
function sizeBytesToDisplay(bytes) {
  if (bytes === null || bytes === undefined) return { value: "", unit: "MB" };
  if (bytes >= 1073741824) return { value: (bytes / 1073741824).toFixed(2).replace(/\.?0+$/, ""), unit: "GB" };
  if (bytes >= 1048576) return { value: (bytes / 1048576).toFixed(1).replace(/\.0$/, ""), unit: "MB" };
  if (bytes >= 1024) return { value: (bytes / 1024).toFixed(1).replace(/\.0$/, ""), unit: "KB" };
  return { value: String(bytes), unit: "B" };
}

/** @param {number | null | undefined} bytes @returns {string | null} */
function sizeFmtSizeUrl(bytes) {
  if (bytes === null || bytes === undefined) return null;
  var d = sizeBytesToDisplay(bytes);
  const formatted = d.value + d.unit;
  return sizeParseSizeStr(formatted) === bytes ? formatted : String(bytes) + "B";
}

/** @param {string | null | undefined} str @returns {number | null} */
function sizeParseSizeStr(str) {
  if (!str) return null;
  var m = String(str).match(/^([\d.]+)\s*(GB|MB|KB|B)?$/i);
  if (!m) return parseInt(str) || null;
  // A native successful match contains capture 1; do not change lookup order.
  var val = parseFloat(/** @type {string} */ (m[1]));
  var unit = (m[2] || "B").toUpperCase();
  if (unit === "GB") val *= 1073741824;
  else if (unit === "MB") val *= 1048576;
  else if (unit === "KB") val *= 1024;
  return Math.round(val);
}
// Result labels deliberately retain their legacy cache/coercion semantics;
// unlike URL sizes, they use fixed display precision and omit zero.
const sizeCache = /** @type {Record<string, string | object>} */ ({});
/** @param {number | string | null | undefined} bytes @returns {string | object | undefined} */
function sizeFormatLabel(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (sizeCache[bytes] !== undefined) return sizeCache[bytes];
  if (typeof bytes === "string") bytes = parseInt(bytes);
  if (isNaN(bytes) || bytes === 0) return (sizeCache[bytes] = "");
  let result;
  if (bytes < 1024) result = bytes + " B";
  else if (bytes < 1048576) result = (bytes / 1024).toFixed(1) + " KB";
  else if (bytes < 1073741824) result = (bytes / 1048576).toFixed(1) + " MB";
  else result = (bytes / 1073741824).toFixed(2) + " GB";
  return (sizeCache[bytes] = result);
}
  /** @type {typeof globalThis & {bytesToDisplay: typeof bytesToDisplay, fmtSizeUrl: typeof fmtSizeUrl, parseSizeStr: typeof parseSizeStr, formatSize: typeof formatSize}} */
  const globals = globalThis;
  globals.bytesToDisplay = sizeBytesToDisplay;
  globals.fmtSizeUrl = sizeFmtSizeUrl;
  globals.parseSizeStr = sizeParseSizeStr;
  globals.formatSize = sizeFormatLabel;
}
