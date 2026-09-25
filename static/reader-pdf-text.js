const MISSING_TEXT = "此页没有可提取文本";

function clampUnit(value) {
  return Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0));
}

function normalizeBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const x0 = clampUnit(box[0]);
  const y0 = clampUnit(box[1]);
  const x1 = clampUnit(box[2]);
  const y1 = clampUnit(box[3]);
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const right = Math.max(x0, x1);
  const bottom = Math.max(y0, y1);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function measureRunScale(layer, text, fontRatio, widthRatio) {
  const height = layer.clientHeight || layer.getBoundingClientRect?.().height || 0;
  const fontSize = Math.max(1, height * fontRatio);
  const width = Math.max(
    1,
    (layer.clientWidth || layer.getBoundingClientRect?.().width || 0) * widthRatio
  );
  const canvas =
    layer._readerPdfMeasureCanvas ||
    (layer._readerPdfMeasureCanvas = layer.ownerDocument.createElement("canvas"));
  const context = canvas.getContext("2d");
  if (!context || !text) return 1;
  context.font = `${fontSize}px "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "SimSun", serif`;
  const measured = context.measureText(text.replace(/\n/g, " ")).width;
  return measured > 0 ? Math.max(0.2, Math.min(4, width / measured)) : 1;
}

function appendTextRun(layer, fragment, text, box, fontRatio, className = "") {
  const block = layer.ownerDocument.createElement("span");
  block.className = `reader-pdf-text-block${className ? ` ${className}` : ""}`;
  block.style.left = `${box.left * 100}%`;
  block.style.top = `${box.top * 100}%`;
  block.style.width = `${box.width * 100}%`;
  block.style.height = `${box.height * 100}%`;
  block.style.setProperty("--reader-pdf-font-ratio", String(fontRatio));
  block.style.setProperty(
    "--reader-pdf-run-scale-x",
    String(measureRunScale(layer, text, fontRatio, box.width))
  );

  const run = layer.ownerDocument.createElement("span");
  run.className = "reader-pdf-text-run";
  run.textContent = text;
  block.appendChild(run);
  fragment.appendChild(block);
  return run;
}

function appendFallbackRun(layer, fragment, text) {
  const block = layer.ownerDocument.createElement("span");
  block.className = "reader-pdf-text-block reader-pdf-text-fallback";
  const run = layer.ownerDocument.createElement("span");
  run.className = "reader-pdf-text-run";
  run.textContent = text;
  block.appendChild(run);
  fragment.appendChild(block);
}

function replaceLayer(layer, fragment, plainText) {
  if (fragment.childNodes.length) layer.replaceChildren(fragment);
  else layer.textContent = plainText.trim() || MISSING_TEXT;
}

export function populatePdfTextLayer(layer, items, pdfViewport) {
  const fragment = layer.ownerDocument.createDocumentFragment();
  let positioned = false;
  let plainText = "";
  let fallbackText = "";
  const pageWidth = Math.max(1, pdfViewport?.width || 0);
  const pageHeight = Math.max(1, pdfViewport?.height || 0);

  for (const item of items || []) {
    const text = String(item?.str || "");
    const value = text + (item?.hasEOL ? "\n" : " ");
    plainText += value;
    if (!text) continue;
    if (!item?.transform || typeof pdfViewport?.convertToViewportPoint !== "function") {
      fallbackText += value;
      continue;
    }

    const point = pdfViewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const fontHeight = Math.hypot(item.transform[2] || 0, item.transform[3] || 0) || 12;
    const box = {
      left: clampUnit(point[0] / pageWidth),
      top: clampUnit((point[1] - fontHeight) / pageHeight),
      width: clampUnit((Number(item.width) || fontHeight * text.length) / pageWidth),
      height: clampUnit(fontHeight / pageHeight)
    };
    if (!box.width || !box.height) {
      fallbackText += value;
      continue;
    }
    positioned = true;
    appendTextRun(layer, fragment, value, box, box.height * 0.92);
  }

  if (positioned) {
    if (fallbackText) appendFallbackRun(layer, fragment, fallbackText);
    replaceLayer(layer, fragment, plainText);
  } else layer.textContent = plainText.trim() || MISSING_TEXT;
}

export function populateOcrTextLayer(layer, blocks) {
  const fragment = layer.ownerDocument.createDocumentFragment();
  for (const block of blocks || []) {
    const text = String(block?.t || "");
    const box = normalizeBox(block?.b);
    if (!text || !box) continue;
    const run = appendTextRun(
      layer,
      fragment,
      text,
      box,
      box.height * 0.92,
      "reader-pdf-ocr-block"
    );
    run.dataset.ocrText = text;
  }
  replaceLayer(layer, fragment, "");
}
