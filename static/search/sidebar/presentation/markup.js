// Markup-only sidebar presentation. Fetching, cancellation, state, events and
// DOM assignment remain with the host so first-paint timing is unchanged.
(function () {
/**
 * @typedef {{name: string, path?: string, count?: number}} FolderEntry
 * @typedef {{name: string, ext?: string, size?: number | null}} FileEntry
 * @typedef {{folders?: FolderEntry[] | null, files?: FileEntry[] | null}} BrowserEntries
 * @typedef {{escape: (value: unknown) => string | undefined, formatSize: (value: number | null | undefined) => string | object | undefined,
 *   iconType: (extension: string | undefined) => string | object, name: (entry: FileEntry) => string,
 *   link: (repo: string, path: string, entry: FileEntry) => string,
 *   reader: (entry: FileEntry, repo: string, path: string) => string,
 *   icon: (type: string | object) => string}} BrowserPorts
 */

/** @param {FolderEntry} entry @param {string} icon @param {BrowserPorts} ports @param {'pages' | 'space'} surface */
function folderMarkup(entry, icon, ports, surface) {
  const label = ports.escape(entry.name);
  const path = surface === 'pages' ? entry.path || '' : entry.path;
  return '<button type="button" class="browser-item" aria-label="打开文件夹：' + label +
    '" data-type="folder" data-path="' + ports.escape(path) + '">' + icon +
    '<span class="browser-name">' + label + '</span><span class="browser-count">' +
    (entry.count || 0).toLocaleString() + '</span></button>';
}

/** @param {FileEntry} entry @param {string} repo @param {string} path @param {BrowserPorts} ports @param {'pages' | 'space'} surface */
function fileMarkup(entry, repo, path, ports, surface) {
  const type = ports.iconType(entry.ext);
  const size = ports.formatSize(entry.size);
  const name = ports.name(entry);
  const label = ports.escape(name);
  const link = ports.link(repo, surface === 'pages' ? path || '' : path, entry);
  const reader = ports.reader(entry, repo, path);
  const icon = ports.icon(type);
  let html = '<div class="browser-item" role="group" aria-label="' + label + '" data-type="file"';
  if (surface === 'pages') html += ' data-filename="' + label + '" data-link="' + ports.escape(link) + '"';
  else html += ' data-link="' + ports.escape(link) + '" data-filename="' + label + '"';
  if (reader) html += (surface === 'pages' ? ' data-reader-url="' : ' data-read-url="') + ports.escape(reader) + '"';
  html += '>' + icon + '<button type="button" class="browser-name" aria-label="' +
    (reader ? '打开阅读器：' : '下载文件：') + label + '">' + label + '</button>' +
    '<button type="button" class="browser-action" aria-label="下载：' + label +
    '" data-download="1">下载</button>' + (size ? '<span class="browser-size">' + size + '</span>' : '') + '</div>';
  return html;
}

/**
 * @param {BrowserEntries} data
 * @param {string} repo
 * @param {string} path
 * @param {'pages' | 'space'} surface
 * @param {BrowserPorts} ports
 * @returns {string}
 */
function browserMarkup(data, repo, path, surface, ports) {
  const icon = ports.icon('folder');
  let html = '';
  if (surface === 'pages') {
    // The Pages host re-reads the arrays at every indexed iteration.
    for (let index = 0; index < (data.folders || []).length; index++)
      html += folderMarkup(/** @type {FolderEntry} */ (/** @type {FolderEntry[]} */ (data.folders)[index]), icon, ports, surface);
    for (let index = 0; index < (data.files || []).length; index++)
      html += fileMarkup(/** @type {FileEntry} */ (/** @type {FileEntry[]} */ (data.files)[index]), repo, path, ports, surface);
  } else {
    for (const folder of data.folders || []) html += folderMarkup(folder, icon, ports, surface);
    for (const file of data.files || []) html += fileMarkup(file, repo, path, ports, surface);
  }
  return html;
}

/** @type {typeof globalThis & {VoiceOfMLSearchSidebarRender: typeof VoiceOfMLSearchSidebarRender}} */
const globals = globalThis;
globals.VoiceOfMLSearchSidebarRender = {browserMarkup};
})();
