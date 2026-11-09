/**
 * @typedef {{response: Promise<Response> | Response, engines?: Promise<unknown>}} ReaderTextPrepared
 * @typedef {ReaderTextPrepared & {engines: Promise<unknown>}} ReaderMarkdownPrepared
 * @typedef {((markdown: false, prepared: ReaderTextPrepared) => Promise<void>) &
 *   ((markdown: true, prepared: ReaderMarkdownPrepared) => Promise<void>)} ReaderTextRenderer
 * @typedef {object} ReaderTextContext
 * @property {() => void} assertReaderActive
 * @property {HTMLElement} content
 * @property {() => void} markReaderContentReady
 * @property {() => Promise<void>} waitForReader
 * @property {(cleanup: () => void) => () => void} trackReaderResource
 * @property {() => Error} readerAbortError
 * @property {<T>(promise: T | PromiseLike<T>) => Promise<Awaited<T>>} awaitReader
 * @property {(bytes: Uint8Array, hint?: string) => string} detectTextEncoding
 * @property {{title: string}} documentState
 * @property {ReaderTextRenderer} renderText
 */
/** @param {ReaderTextContext} readerContext */
export function createReaderTextFormat(readerContext) {
  /** @param {Response} response */
  async function renderPlainText(response) {
    readerContext.assertReaderActive();
    const pre = document.createElement("div");
    pre.className = "reader-text";
    readerContext.content.appendChild(pre);
    let /** @type {HTMLPreElement | null} */ block = null, blockLength = 0;
    /** @param {string} value @param {string} [encoding] */
    const appendDecoded = async (value, encoding = "utf-8") => {
      // Unicode can contain a literal replacement character. Keep legacy
      // damaged-codepage cleanup scoped to non-Unicode decoding.
      const text = encoding.startsWith("utf-") ? value : value.replace(/\ufffd/g, "");
      let offset = 0, deadline = performance.now() + 8;
      while (offset < text.length) {
        if (!block) {
          block = document.createElement("pre");
          block.className = "reader-text-block";
          pre.appendChild(block);
        }
        let end = Math.min(text.length, offset + 32768 - blockLength);
        if (end < text.length) {
          const newline = text.lastIndexOf("\n", end - 1);
          if (newline >= offset) end = newline + 1;
          const previous = text.charCodeAt(end - 1), next = text.charCodeAt(end);
          if ((previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) ||
              (previous === 13 && next === 10)) end--;
        }
        if (end === offset) { block = null; blockLength = 0; continue; }
        const tail = block.lastChild;
        if (tail?.nodeType === Node.TEXT_NODE) (/** @type {Text} */ (tail)).appendData(text.slice(offset, end));
        else block.appendChild(document.createTextNode(text.slice(offset, end)));
        if (text.length) readerContext.markReaderContentReady();
        blockLength += end - offset;
        offset = end;
        if (offset < text.length || blockLength >= 32768) { block = null; blockLength = 0; }
        if (offset < text.length && performance.now() >= deadline) {
          await readerContext.waitForReader();
          readerContext.assertReaderActive();
          deadline = performance.now() + 8;
        }
      }
    };
    const limit = VoiceOfMLReaderSecurity.LIMITS.documentBytes;
    VoiceOfMLReaderSecurity.assertResponseSize(response, limit);
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > limit) {
        throw Object.assign(new Error("READER_RESOURCE_LIMIT"), { code: "READER_RESOURCE_LIMIT" });
      }
      readerContext.assertReaderActive();
      const decoder = new TextDecoder(readerContext.detectTextEncoding(bytes, readerContext.documentState.title));
      await appendDecoded(decoder.decode(bytes), decoder.encoding);
      return;
    }
    const reader = response.body.getReader(),
      /** @type {Uint8Array[]} */ sampleChunks = [],
      /** @type {number[]} */ signature = [],
      previewDecoder = new TextDecoder("utf-8");
    const untrack = readerContext.trackReaderResource(() => {
      reader.cancel(readerContext.readerAbortError()).catch(() => {});
    });
    let length = 0,
      sampleLength = 0,
      displayedSampleSize = 0,
      previewChunkIndex = 0,
      previewChunkOffset = 0,
      /** @type {TextDecoder | null} */ decoder = null,
      asciiPreviewPossible = true,
      asciiPrefixLength = 0;
    const startDecoder = async () => {
      const sample = new Uint8Array(sampleLength);
      let offset = 0;
      for (const chunk of sampleChunks) {
        sample.set(chunk, offset);
        offset += chunk.byteLength;
      }
      decoder = new TextDecoder(readerContext.detectTextEncoding(sample, readerContext.documentState.title));
      await appendDecoded(decoder.decode(sample.subarray(displayedSampleSize), { stream: true }), decoder.encoding);
      sampleChunks.length = 0;
    };
    try {
      while (true) {
        const { value, done } = await readerContext.awaitReader(reader.read());
        readerContext.assertReaderActive();
        if (done) break;
        if (!value?.byteLength) continue;
        length += value.byteLength;
        if (length > limit) {
          throw Object.assign(new Error("READER_RESOURCE_LIMIT"), { code: "READER_RESOURCE_LIMIT" });
        }
        if (!decoder) {
          sampleChunks.push(value);
          sampleLength += value.byteLength;
          for (let i = 0; i < value.byteLength && signature.length < 3; i++) signature.push(/** @type {number} */ (value[i]));
          // A BOM determines the decoder without waiting for the heuristic
          // sample. Retain streaming decoder state across split code units.
          if ((signature[0] === 0xef && signature[1] === 0xbb && signature[2] === 0xbf) ||
              (signature[0] === 0xff && signature[1] === 0xfe) ||
              (signature[0] === 0xfe && signature[1] === 0xff)) {
            await startDecoder();
            continue;
          }
          if (asciiPreviewPossible) {
            let asciiLength = 0;
            while (asciiLength < value.length && (/** @type {number} */ (value[asciiLength])) > 0 && (/** @type {number} */ (value[asciiLength])) < 128)
              asciiLength++;
            asciiPrefixLength += asciiLength;
            if (value[asciiLength] === 0) {
              // A split UTF-16 prefix must not leave an ASCII preview behind.
              pre.textContent = "";
              block = null;
              blockLength = 0;
              displayedSampleSize = 0;
              asciiPrefixLength = 0;
              asciiPreviewPossible = false;
            } else if (asciiLength < value.length) asciiPreviewPossible = false;
          }
          if (asciiPrefixLength >= 4 && asciiPrefixLength > displayedSampleSize) {
            // The full sample remains for encoding detection; preview only its
            // unseen ASCII prefix instead of revisiting all previous chunks.
            while (displayedSampleSize < asciiPrefixLength) {
              // The preview cursor advances through the retained sample until
              // it has consumed precisely the accumulated ASCII prefix.
              const chunk = /** @type {Uint8Array} */ (sampleChunks[previewChunkIndex]);
              const end = Math.min(chunk.length, previewChunkOffset + asciiPrefixLength - displayedSampleSize);
              await appendDecoded(previewDecoder.decode(chunk.subarray(previewChunkOffset, end)));
              displayedSampleSize += end - previewChunkOffset;
              previewChunkOffset = end;
              if (end === chunk.length) {
                previewChunkIndex++;
                previewChunkOffset = 0;
              }
            }
          }
          if (sampleLength < 65540) continue;
          await startDecoder();
        } else {
          // This branch is reached only after the closure assigned a decoder;
          // TypeScript does not track assignments made inside that closure.
          await appendDecoded((/** @type {TextDecoder} */ (/** @type {unknown} */ (decoder))).decode(value, { stream: true }), (/** @type {TextDecoder} */ (/** @type {unknown} */ (decoder))).encoding);
        }
      }
      // If no decoder was selected during streaming, successful completion of
      // startDecoder assigns one even for an empty sample. A failure is caught.
      if (!decoder) await startDecoder();
      await appendDecoded((/** @type {TextDecoder} */ (/** @type {unknown} */ (decoder))).decode(), (/** @type {TextDecoder} */ (/** @type {unknown} */ (decoder))).encoding);
    } catch (reason) {
      try {
        await reader.cancel(reason);
      } catch (_) {}
      throw reason;
    } finally {
      untrack();
      reader.releaseLock();
    }
  }

  /** @param {Uint8Array} bytes @param {string} [hint] */
  function detectTextEncoding(bytes, hint = "") {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
    let evenNulls = 0, oddNulls = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (!bytes[index]) {
        if (index % 2 === 0) evenNulls++;
        else oddNulls++;
      }
    }
    if (oddNulls > bytes.length / 8 && oddNulls > evenNulls * 4) return "utf-16le";
    if (evenNulls > bytes.length / 8 && evenNulls > oddNulls * 4) return "utf-16be";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
      return "utf-8";
    } catch (_) {}
    if (/[\u0400-\u04ff]/.test(hint)) return "windows-1251";
    const candidates = /[\u3400-\u9fff]/.test(hint)
      ? ["gb18030", "big5"]
      : ["gb18030", "big5", "windows-1251", "windows-1252"];
    let best = "gb18030",
      bestScore = -Infinity;
    for (const encoding of candidates) {
      try {
        const text = new TextDecoder(encoding).decode(bytes);
        const controls = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length;
        const replacements = (text.match(/\ufffd/g) || []).length;
        const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
        const cyrillic = (text.match(/[\u0400-\u04ff]/g) || []).length;
        const commonCjk = (
          text.match(
            /[的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经之进着等部家自理起现实都体制当本性应开合因由然前外政社义事相全与关各重新内正反明原利质向道命此变结解问意建公系军情者立代通题党程展料员革文总品活长求老基资级图统知组别期论运农指区战任处理世]/g
          ) || []
        ).length;
        const score = Math.max(cjk + commonCjk * 5, cyrillic) - controls * 20 - replacements * 40;
        if (score > bestScore) {
          best = encoding;
          bestScore = score;
        }
      } catch (_) {}
    }
    return best;
  }

  /** @param {ReaderTextPrepared} prepared */
  function renderTextDocument(prepared) {
    return readerContext.renderText(false, prepared);
  }

  /** @param {ReaderMarkdownPrepared} prepared */
  function renderMarkdownDocument(prepared) {
    return readerContext.renderText(true, prepared);
  }

  return {
    renderPlainText,
    detectTextEncoding,
    renderTextDocument,
    renderMarkdownDocument
  };
}
