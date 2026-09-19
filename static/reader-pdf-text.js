export function populatePdfTextLayer(layer, items, pdfViewport) {
  const fragment = layer.ownerDocument.createDocumentFragment();
  let positioned = false;
  let plainText = "";
  for (const item of items) {
    const span = layer.ownerDocument.createElement("span");
    const value = item.str + (item.hasEOL ? "\n" : " ");
    span.textContent = value;
    plainText += value;
    const point = item.transform && pdfViewport.convertToViewportPoint
      ? pdfViewport.convertToViewportPoint(item.transform[4], item.transform[5])
      : null;
    if (point) {
      positioned = true;
      const fontHeight = Math.hypot(item.transform[2] || 0, item.transform[3] || 0) || 12;
      span.style.left = `${(point[0] / Math.max(1, pdfViewport.width)) * 100}%`;
      span.style.top = `${(point[1] / Math.max(1, pdfViewport.height)) * 100}%`;
      span.style.fontSize = `${(fontHeight / Math.max(1, pdfViewport.height)) * 100}%`;
    } else span.style.position = "static";
    fragment.appendChild(span);
  }
  if (positioned) {
    layer.replaceChildren(fragment);
    if (!layer.textContent.trim()) layer.textContent = "此页没有可提取文本";
  } else layer.textContent = plainText.trim() || "此页没有可提取文本";
}
