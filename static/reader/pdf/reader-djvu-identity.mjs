// Source identity rules for DjVu originals. The proxy may resolve a mutable
// alias, but its reply must name exactly the same document at an immutable
// Hugging Face revision before any Range or whole-source read begins.

/** @typedef {{url: string, revision: string}} DjvuSourceIdentity */
/** @typedef {{readerDownloadApiUrl(path: string): string,
 * fetchWithReaderTimeout(url: string, timeout: number, options?: RequestInit): Promise<Response>,
 * READER_PROXY_TIMEOUT_MS: number}} DjvuIdentityContext */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && (typeof value === 'object' || typeof value === 'function'); }
/** @param {string} path */
function hasUnsafeSegments(path) {
  return !path || /[\x00-\x1f\x7f%?#\\]/.test(path) || path.split('/').some(part=>!part || part==='.' || part==='..');
}
/** @param {string | undefined} repo */
function validRepo(repo) { return !!repo && repo !== '.' && repo !== '..'; }
/** @param {URL} original @param {string | undefined} revision @returns {DjvuSourceIdentity | null} */
function canonicalIdentity(original, revision) {
  const match = /^\/datasets\/VoiceOfML\/([A-Za-z0-9._-]+)\/resolve\/([0-9a-f]{40})\/(.+\.djvu)$/.exec(original.pathname);
  if (!revision || original.origin !== 'https://huggingface.co' || !match) return null;
  const repo=match[1],encoded=match[3];
  if (!validRepo(repo) || !encoded) return null;
  let path='';
  try { path=decodeURIComponent(encoded); } catch (_) { return null; }
  if (hasUnsafeSegments(path) || /%(?:2f|5c)/i.test(encoded)) return null;
  return {url:original.href, revision};
}
/** @param {unknown} value @returns {value is DjvuSourceIdentity} */
function validIdentity(value) {
  return isRecord(value) && typeof value.url === 'string' && typeof value.revision === 'string';
}
/** @param {URL} url */
function hasExtras(url) { return !!(url.username || url.password || url.search || url.hash); }
/** @param {URL} original @param {URL} resolved @param {string | undefined} revision @param {string} pinnedRevision */
function validatesPinnedSource(original,resolved,revision,pinnedRevision) {
  if (hasExtras(original) || hasExtras(resolved)) return false;
  if (resolved.origin !== 'https://huggingface.co' || !['huggingface.co','hf-mirror.com'].includes(original.hostname)) return false;
  if (!/^[0-9a-f]{40}$/.test(pinnedRevision) || (revision && revision !== pinnedRevision)) return false;
  return resolved.pathname === original.pathname.replace(/\/(?:resolve|raw)\/(?:main|[0-9a-f]{40})\//,`/resolve/${pinnedRevision}/`);
}
/** @param {DjvuIdentityContext} context @param {string} sourceUrl @param {AbortSignal} signal @returns {Promise<URL>} */
export async function resolveDjvuSource(context,sourceUrl,signal) {
  const original=new URL(sourceUrl);
  const revision=/\/resolve\/([0-9a-f]{40})\//.exec(original.pathname)?.[1];
  let pinned=canonicalIdentity(original,revision);
  if (!pinned) {
    const endpoint=context.readerDownloadApiUrl(`/api/reader-source-revision?url=${encodeURIComponent(sourceUrl)}`);
    const metadata=await context.fetchWithReaderTimeout(endpoint,context.READER_PROXY_TIMEOUT_MS,{signal});
    if (!metadata.ok) throw new Error(`DJVU_SOURCE_REVISION_HTTP_${metadata.status}`);
    /** @type {unknown} */
    const raw=JSON.parse(await VoiceOfMLReaderSecurity.readText(metadata,64*1024));
    if (!validIdentity(raw)) throw new Error('DJVU_SOURCE_REVISION_INVALID');
    pinned=raw;
  }
  const resolved=new URL(pinned.url);
  if (!validatesPinnedSource(original,resolved,revision,pinned.revision)) throw new Error('DJVU_SOURCE_REVISION_INVALID');
  return resolved;
}
