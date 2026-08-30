import "./vendor/foliate/view.js";

export async function openFoliate(bytes, name, type = "application/octet-stream", onView) {
  const view = document.createElement("foliate-view");
  view.className = "foliate-reader-view";
  view.style.cssText = "display:block;width:100%;height:100%;min-height:100%;";
  document.querySelector("#content").appendChild(view);
  onView?.(view);
  await view.open(new File([bytes], name, { type }));
  view.renderer.setAttribute("flow", "scrolled");
  await view.goToTextStart();
  return view;
}
