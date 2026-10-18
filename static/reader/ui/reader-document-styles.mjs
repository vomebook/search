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

export const DISCOURSE_POST_SELECTOR = ".topic-post .cooked";

export const DISCOURSE_TITLE_SELECTOR = "#topic-title .fancy-title, .topic-link, title";

export const DISCOURSE_HTML_STYLE = `<style>
html,body{min-height:100%;margin:0;background:#fff;color:#202124}
body{box-sizing:border-box;padding:clamp(18px,4vw,48px);font:16px/1.8 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;overflow-wrap:anywhere}
.reader-forum-document{max-width:900px;margin:0 auto}
.reader-forum-document>h1{margin:0 0 1.8em;padding:0 0 .7em;border-bottom:1px solid #d9dde3;font-size:clamp(1.5rem,3vw,2.25rem);line-height:1.35}
.reader-forum-post{margin:0 0 2.5em;padding:0 0 2em;border-bottom:1px solid #e1e5ea}
.reader-forum-post:last-child{margin-bottom:0;border-bottom:0}
.reader-forum-post p{margin:.8em 0}
.reader-forum-post a{color:#185abc}
.reader-forum-post img,.reader-forum-post svg,.reader-forum-post video{max-width:100%;height:auto}
.reader-forum-post table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}
.reader-forum-post blockquote{margin:1em 0;padding:.5em 1em;border-left:3px solid #c5ccd6;background:#f6f8fa}
.reader-forum-post pre{max-width:100%;overflow:auto;white-space:pre-wrap}
@media(max-width:600px){body{padding:16px 14px}.reader-forum-document>h1{font-size:1.5rem}}
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
