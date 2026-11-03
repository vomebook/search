// Original dataset paths retain their final extension and encode each segment
// independently; slashes remain separators for both sites' existing URLs.
{
  /** @param {{File?: string, Extension?: string, Folder?: string[] | null}} rec @returns {string} */
  function relativeRecordPath(rec) {
    const filename = rec.File || "";
    const extension = rec.Extension || "";
    const fullName = extension ? filename + "." + extension : filename;
    const folders = Array.isArray(rec.Folder) ? rec.Folder : [];
    return folders.length > 0 ? folders.join("/") + "/" + fullName : fullName;
  }

  /** @param {string | null | undefined} path @returns {string} */
  function encodedRecordPath(path) {
    return String(path || "").split("/").map(encodeURIComponent).join("/");
  }

  /** @type {typeof globalThis & {buildRecordRelativePath: typeof buildRecordRelativePath, encodeRecordPath: typeof encodeRecordPath}} */
  const globals = globalThis;
  globals.buildRecordRelativePath = relativeRecordPath;
  globals.encodeRecordPath = encodedRecordPath;
}
