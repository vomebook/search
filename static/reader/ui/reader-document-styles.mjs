export const EPUB_HTML_TAGS = new Set(
  "a,abbr,address,area,article,aside,audio,b,base,bdi,bdo,blockquote,body,br,button,canvas,caption,cite,code,col,colgroup,data,datalist,dd,del,details,dfn,dialog,div,dl,dt,em,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,head,header,hgroup,hr,html,i,iframe,img,input,ins,kbd,label,legend,li,link,main,map,mark,menu,meta,meter,nav,noscript,object,ol,optgroup,option,output,p,picture,pre,progress,q,rb,rp,rt,rtc,ruby,s,samp,script,search,section,select,slot,small,source,span,strong,style,sub,summary,sup,table,tbody,td,template,textarea,tfoot,th,thead,time,title,tr,track,u,ul,var,video,wbr".split(
    ","
  )
);

export const EPUB_HTML_VOID_TAGS = new Set(
  "area,base,br,col,embed,hr,img,input,link,meta,param,source,track,wbr".split(",")
);

export const HTML_FRAME_STYLE =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'; img-src data: blob:; media-src data: blob:; font-src data: blob:; style-src \'unsafe-inline\'"><meta name="color-scheme" content="only light"><style>:root{color-scheme:only light!important;background:#fff!important}html,body{min-height:100%;background:#fff!important;color:#111!important}</style>';

// The isolated document follows the Reader (not the OS) and keeps width
// constraints inside the frame. Spreadsheets use their own two-axis viewport.
export const HTML_PROSE_STYLE = `<style>
:root{color-scheme:light!important;--paper:#f7f3eb;--ink:#202124;--link:#185abc;
  font-size:17px!important;text-size-adjust:none!important;-webkit-text-size-adjust:none!important}
@media(max-width:600px){:root{font-size:14px!important}}
:root[data-reader-theme="dark"]{color-scheme:dark!important;--paper:#202224;--ink:#e7e9eb;--link:#8ab4e8}
html,body{background:var(--paper)!important;color:var(--ink)!important}
body{box-sizing:border-box;max-inline-size:76ch!important;min-inline-size:0!important;
  margin-inline:auto!important;padding-inline:clamp(10px,3vw,24px);overflow-wrap:anywhere;
  font-size:1rem!important;line-height:1.75}
.reader-forum-document{font-size:1rem}
body :is(article,aside,blockquote,dd,div,dl,dt,figure,figcaption,footer,header,h1,h2,h3,h4,h5,h6,li,main,ol,p,section,ul):not(pre *, .reader-ebook-table-scroll *){
  box-sizing:border-box!important;min-inline-size:0!important;max-inline-size:100%!important;
}
body :where(:not(pre,pre *,code,code *,.reader-ebook-table-scroll *)){
  text-wrap-mode:wrap!important;overflow-wrap:anywhere!important;
}
@supports not (text-wrap-mode:wrap){
  body :where(:not(pre,pre *,code,code *,.reader-ebook-table-scroll *)){white-space:normal!important}
}
/* Legacy article layout tables may be sized by a single large illustration.
   Cap media to the reading column even in a scrollable table, while keeping
   multi-column data and preformatted text horizontally scrollable. */
body :is(img,video){max-inline-size:100%!important;block-size:auto!important}
.reader-ebook-table-scroll{container-type:inline-size}
@supports (width:1cqi){.reader-ebook-table-scroll :is(img,video){max-inline-size:min(100%,100cqi)!important}}
body :is(pre,.reader-ebook-table-scroll){box-sizing:border-box!important;max-inline-size:100%!important;overflow-x:auto!important}
body a[href]{color:var(--link)}
body a:not([href]){color:inherit}
@media (prefers-contrast:more){:root{--paper:#fff;--ink:#111}:root[data-reader-theme="dark"]{--paper:#101214;--ink:#fff}}
@media (forced-colors:active){html,body{background:Canvas!important;color:CanvasText!important}body a[href]{color:LinkText!important}}
</style>`;

// Reflow only the validated post shells; authored tables inside posts stay tables.
export const PHPWIND_HTML_STYLE = `<style>
[data-reader-phpwind="shell"]{margin:1rem 0;border-block-end:1px solid currentColor}
[data-reader-phpwind="shell"], [data-reader-phpwind="shell"] > tbody,
[data-reader-phpwind="main"], [data-reader-phpwind="inner"],
[data-reader-phpwind="inner"] > tbody, [data-reader-phpwind="inner"] > tbody > tr,
[data-reader-phpwind="inner"] > tbody > tr > td, [data-reader-phpwind="post"],
[data-reader-phpwind="profile"], [data-reader-phpwind="profile-in-place"]{
  display:block;box-sizing:border-box;inline-size:100%;min-inline-size:0;block-size:auto;
}
[data-reader-phpwind="shell"] > tbody > tr{display:flex;flex-direction:column}
[data-reader-phpwind="profile"], [data-reader-phpwind="profile-in-place"],
[data-reader-phpwind="inner"] > tbody > tr:not(:first-child) > td{font-size:.85em}
[data-reader-phpwind="profile"]{order:1;padding-block:.25em}
[data-reader-phpwind="profile"] > :first-child ~ br{display:none}
[data-reader-phpwind="post"]{font-size:1rem}
[data-reader-phpwind="inert"]{display:none!important}
</style>`;

export const DISCOURSE_POST_SELECTOR = ".topic-post .cooked";

export const DISCOURSE_TITLE_SELECTOR = "#topic-title .fancy-title, .topic-link, title";

// Constrain content to the reading column, even in a wide viewport.
export const EBOOK_LAYOUT_STYLE = `
.reader-ebook-table-scroll { display: block; }
.epub-frame > .reader-epub-chapter {
  min-inline-size: 0;
  overflow-x: auto;
}
.epub-frame > .reader-epub-chapter
  :is(article, aside, blockquote, dd, div, dl, dt, figure, figcaption, footer, header,
    h1, h2, h3, h4, h5, h6, li, main, ol, p, section, ul):not(pre *, svg *, math *) {
  box-sizing: border-box !important;
  min-inline-size: 0 !important;
  max-inline-size: 100% !important;
}
.epub-frame > .reader-epub-chapter
  :where(:not(pre, pre *, svg, svg *, math, math *)) {
  /* Change the wrap mode without collapsing authored spaces or newlines. */
  text-wrap-mode: wrap !important;
  overflow-wrap: anywhere !important;
}
@supports not (text-wrap-mode: wrap) {
  .epub-frame > .reader-epub-chapter
    :where(:not(pre, pre *, svg, svg *, math, math *)) { white-space: normal !important; }
}
.epub-frame > .reader-epub-chapter :is(img, svg, video, canvas):not(svg *, math *) {
  min-inline-size: 0 !important;
  max-inline-size: 100% !important;
  block-size: auto !important;
}
.epub-frame > .reader-epub-chapter :is(pre, .reader-ebook-table-scroll) {
  box-sizing: border-box !important;
  min-inline-size: 0 !important;
  max-inline-size: 100% !important;
  overflow-x: auto !important;
}`;

/** @param {HTMLElement} body */
export function wrapEbookTables(body) {
  for (const table of body.querySelectorAll("table")) {
    if (table.parentElement?.closest("table")) continue;
    const region = body.ownerDocument.createElement("div");
    region.className = "reader-ebook-table-scroll";
    region.tabIndex = 0;
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", table.caption?.textContent?.trim() || "书内表格");
    table.before(region);
    region.appendChild(table);
  }
}

export const DISCOURSE_HTML_STYLE = `<style>
html,body{min-height:100%;margin:0;background:#fff;color:#202124}
body{box-sizing:border-box;padding:clamp(18px,4vw,48px);font:16px/1.8 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;overflow-wrap:anywhere}
.post-stream, .topic-post, .reader-forum-post{box-sizing:border-box!important;min-inline-size:0!important;max-inline-size:100%!important}
.post-stream, .topic-post, .reader-forum-post{inline-size:100%!important;float:none!important}
#topic-title .fancy-title{font-size:clamp(1.5rem,3vw,2.25rem);line-height:1.35}
.reader-forum-post{margin:0 0 2.5em;padding:0 0 2em;border-bottom:1px solid #e1e5ea}
.reader-forum-post:last-child{margin-bottom:0;border-bottom:0}
.reader-forum-post p{margin:.8em 0}
.reader-forum-post a[href]{color:#185abc}
.reader-forum-post img,.reader-forum-post svg,.reader-forum-post video{max-width:100%;height:auto}
.reader-forum-post table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}
.reader-forum-post blockquote{margin:1em 0;padding:.5em 1em;border-left:3px solid #c5ccd6;background:#f6f8fa}
.reader-forum-post pre{max-width:100%;overflow:auto;white-space:pre-wrap}
@media(max-width:600px){body{padding:16px 14px}}
</style>`;

export const SPREADSHEET_HTML_STYLE = `<style>
html,body{min-height:100%;margin:0;background:#fff;color:#16191c}
html{width:max-content;min-width:100%;overflow:auto}
body{box-sizing:border-box;width:max-content;min-width:100%;padding:12px;font:14px/1.35 Arial,"Noto Sans",sans-serif}
.reader-spreadsheet-sheet{width:max-content;min-width:100%;margin:0 0 24px}
.reader-spreadsheet-sheet h2{position:sticky;left:0;width:max-content;margin:0 0 8px;font-size:16px}
.reader-spreadsheet-sheet table{width:max-content;min-width:max-content;border-collapse:collapse;border-spacing:0}
.reader-spreadsheet-sheet th,.reader-spreadsheet-sheet td{white-space:nowrap;vertical-align:top;padding:4px 8px;border:1px solid #c8ccd1}
.reader-spreadsheet-sheet img,.reader-spreadsheet-sheet svg{max-width:none;height:auto}
</style>`;
