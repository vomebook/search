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

export function populateOcrTextLayer(layer, blocks) {
  const fragment = layer.ownerDocument.createDocumentFragment();
  for (const block of blocks || []) {
    const text = String(block?.t || "");
    const box = Array.isArray(block?.b) ? block.b : [];
    if (!text || box.length !== 4) continue;
    const span = layer.ownerDocument.createElement("span");
    span.textContent = text;
    span.dataset.ocrText = text;
    span.style.left = `${Math.max(0, Math.min(1, Number(box[0]) || 0)) * 100}%`;
    span.style.top = `${Math.max(0, Math.min(1, Number(box[1]) || 0)) * 100}%`;
    span.style.width = `${Math.max(0, Math.min(1, Number(box[2]) - Number(box[0])) * 100)}%`;
    span.style.height = `${Math.max(0.5, Math.min(1, Number(box[3]) - Number(box[1])) * 100)}%`;
    span.style.fontSize = `${Math.max(8, Math.min(72, Math.abs(Number(box[3]) - Number(box[1])) * 100))}%`;
    fragment.appendChild(span);
  }
  layer.replaceChildren(fragment);
}
