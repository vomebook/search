// Preserve the established extension order and icon selection for search results.
// The host retains the original const bindings and lookup function. Do not
// freeze the values or replace the object prototype: both are observable.
{
  const orderedExtensions = [
    "pdf", "djvu",
    "txt", "md",
    "epub", "mobi", "azw", "azw3", "fb2", "fbz", "chm",
    "doc", "docx", "odt", "rtf", "wps", "caj", "kdh",
    "xls", "xlsx", "csv", "ods", "ppt", "pptx", "pps", "odp", "ps",
    "jpg", "jpeg", "png", "gif", "bmp", "tif", "tiff", "webp", "psd",
    "html", "htm", "mht", "mhtml", "markdown", "vcf", "ini",
    "mp3", "wav", "m4a", "aac", "flac", "mpga", "wma", "ape", "amr",
    "mp4", "mov", "flv", "f4v", "rm", "rmvb", "mkv", "avi", "mpg", "mpeg", "mts", "ts", "wmv", "asx", "swf",
  ];
  const fileIconMap = /** @type {Record<string, string | object>} */ ({
    pdf: "pdf", txt: "text", mht: "text",
    epub: "book", mobi: "book", azw: "book", azw3: "book", fb2: "book", fbz: "book", djvu: "book", chm: "book", caj: "book",
    doc: "doc", docx: "doc", odt: "doc", rtf: "doc",
    ppt: "ppt", pptx: "ppt", pps: "ppt", odp: "ppt",
    xls: "xls", xlsx: "xls", ods: "xls", csv: "csv",
    jpg: "image", jpeg: "image", png: "image", gif: "image", tif: "image", tiff: "image",
    bmp: "image", webp: "image", svg: "image",
    html: "code", htm: "code", aspx: "code", css: "code", js: "code", xml: "code",
    json: "code", ini: "code", bat: "code",
    mp4: "video", mov: "video", flv: "video", swf: "video", asx: "video", rm: "video", rmvb: "video",
    wmv: "video", mpg: "video", mpeg: "video", mkv: "video", avi: "video", mts: "video", ts: "video", f4v: "video",
    mp3: "audio", wav: "audio", wma: "audio", ape: "audio", m4a: "audio", aac: "audio", amr: "audio", flac: "audio", mpga: "audio",
    iso: "archive", msi: "archive", dat: "archive",
    exe: "file", db: "database", itf: "database",
    url: "text", vcf: "text", hhc: "text",
    md: "markdown", markdown: "markdown",
  });
  /** @type {typeof globalThis & {VoiceOfMLSearchFileTypes: typeof VoiceOfMLSearchFileTypes}} */
  const globals = globalThis;
  globals.VoiceOfMLSearchFileTypes = {orderedExtensions, fileIconMap};
}
