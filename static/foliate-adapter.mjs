import "./vendor/foliate/view.js";

export async function openFoliate(bytes, name, type = "application/octet-stream", onView) {
  const view = document.createElement("foliate-view");
  view.className = "foliate-reader-view";
  view.style.cssText = "display:block;width:100%;height:100%;min-height:100%;";
  document.querySelector("#content").appendChild(view);
  onView?.(view);
  await view.open(new File([bytes], name, { type }));
  view.renderer.setAttribute("flow", "scrolled");
  view.renderer.setStyles(`:root, body { background: #181b1e !important; color: #e7e9eb !important; } a, a * { color: #8ab4e8 !important; } img, svg, video { max-width: 100%; }`);
  await view.goToTextStart();
  return view;
}
