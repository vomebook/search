import "./vendor/foliate/view.js";

export async function openFoliate(bytes, name, type = "application/octet-stream", onView) {
  const view = document.createElement("foliate-view");
  view.className = "foliate-reader-view";
  view.style.cssText = "display:block;width:100%;height:100%;min-height:100%;";
  document.querySelector("#content").appendChild(view);
  onView?.(view);
  let readerTheme = "dark";
  const applyReaderTheme = () => {
    const colors = readerTheme === "light"
      ? { background: "#ffffff", color: "#202124", link: "#165ea8" }
      : { background: "#181b1e", color: "#e7e9eb", link: "#8ab4e8" };
    view.renderer?.setStyles(`:root, body { background: ${colors.background} !important; color: ${colors.color} !important; } body, body :is(p, div, span, li, td, th, blockquote, pre, code, h1, h2, h3, h4, h5, h6) { color: ${colors.color} !important; } a, a * { color: ${colors.link} !important; } img, svg, video { max-width: 100%; }`);
  };
  view.addEventListener("load", applyReaderTheme);
  await view.open(new File([bytes], name, { type }));
  view.renderer.setAttribute("flow", "scrolled");
  view.setReaderTheme = (theme) => { readerTheme = theme === "light" ? "light" : "dark"; applyReaderTheme(); };
  await view.goToTextStart();
  return view;
}
