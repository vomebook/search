// Preserve the original ID checks, coercions and lazy path-helper lookup.
{
  /**
   * @param {unknown} result
   * @returns {string}
   */
  function resultStableId(result) {
    const record = /** @type {{Id?: unknown, id?: unknown, Repo?: string, File?: string, Extension?: string, Folder?: string[] | null} | null | undefined} */ (result);
    if (!record || typeof record !== "object") return "";
    if (record.Id || record.id) return String(record.Id || record.id);
    return `${record.Repo || ""}\0${buildRecordRelativePath(record)}`;
  }
  /** @type {typeof globalThis & {VoiceOfMLSearchIdentity: typeof VoiceOfMLSearchIdentity}} */
  const globals = globalThis;
  globals.VoiceOfMLSearchIdentity = {getResultStableId: resultStableId};
}
