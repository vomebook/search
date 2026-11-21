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
 * @property {(bytes: Uint8Array, hint?: string, leading?: boolean) => string} detectTextEncoding
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
          // An unbroken chunk must not rescan the already appended prefix.
          const newline = text.slice(offset, end).lastIndexOf("\n");
          if (newline >= 0) end = offset + newline + 1;
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
    const limit = VoiceOfMLReaderSecurity.LIMITS.documentBytes, sampleLimit = 65540;
    VoiceOfMLReaderSecurity.assertResponseSize(response, limit);
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > limit) {
        throw Object.assign(new Error("READER_RESOURCE_LIMIT"), { code: "READER_RESOURCE_LIMIT" });
      }
      readerContext.assertReaderActive();
      let start = 0;
      if (bytes.length >= sampleLimit) {
        let ascii = 0;
        while (ascii < sampleLimit && (bytes[ascii] ?? 0) > 0 && (bytes[ascii] ?? 128) < 128) ascii++;
        if (ascii === sampleLimit) {
          start = ascii;
          while (start < bytes.length && (bytes[start] ?? 128) < 128) start++;
        }
      }
      const decoder = new TextDecoder(readerContext.detectTextEncoding(bytes.subarray(start, start + sampleLimit),
        readerContext.documentState.title, start === 0));
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
      committedAscii = false,
      displayedSampleSize = 0,
      previewChunkIndex = 0,
      previewChunkOffset = 0,
      /** @type {TextDecoder | null} */ decoder = null,
      asciiPreviewPossible = true,
      asciiPrefixLength = 0,
      /** @type {TextDecoder | null} */ utf8Preview = new TextDecoder("utf-8", { fatal: true }),
      previewText = "";
    const clearUtf8Preview = () => {
      delete pre.dataset.textPreview;
      utf8Preview = null;
      previewText = "";
    };
    /** @param {Uint8Array} chunk */
    const showUtf8Preview = chunk => {
      if (!utf8Preview) return;
      if (displayedSampleSize || chunk.includes(0)) { clearUtf8Preview(); return; }
      let decoded;
      try { decoded = utf8Preview.decode(chunk, { stream: true }); }
      catch (_) { clearUtf8Preview(); return; }
      // Keep this tentative, bounded text out of the document's text nodes so
      // search, speech and bookmark excerpts cannot consume a charset guess.
      if (previewText.length < 2048) {
        const end = 2048 - previewText.length;
        const last = decoded.charCodeAt(end - 1);
        previewText += decoded.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
        if (/^(?:[^\u3400-\u9fff]*[\u3400-\u9fff]){4}/.test(previewText)) {
          pre.dataset.textPreview = previewText;
          readerContext.markReaderContentReady();
        }
      }
    };
    const startDecoder = async () => {
      // Use the fixed sample bytes without copying a contiguous view.
      let sample = sampleChunks.length === 1 ? sampleChunks[0] : undefined;
      if (!sample) {
        sample = new Uint8Array(sampleLength);
        let offset = 0;
        for (const chunk of sampleChunks) {
          sample.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
      const encoding = readerContext.detectTextEncoding(sample, readerContext.documentState.title, !committedAscii);
      // Do not strip an internal UTF-8 BOM after an ASCII preface.
      decoder = new TextDecoder(encoding, { ignoreBOM: committedAscii });
      clearUtf8Preview();
      if (decoder.encoding.startsWith("utf-16") && displayedSampleSize) {
        // A late NUL pattern can choose UTF-16 even after the ASCII preview
        // stopped. Rebuild from byte zero, not the ASCII preview's byte offset.
        pre.textContent = "";
        block = null;
        blockLength = 0;
        displayedSampleSize = 0;
      }
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
        for (let pending = value; pending.length;) {
          if (decoder) {
            const active = /** @type {TextDecoder} */ (/** @type {unknown} */ (decoder));
            await appendDecoded(active.decode(pending, { stream: true }), active.encoding);
            break;
          }
          // Pure ASCII cannot distinguish UTF-8 from a legacy code page.
          // Render it as it arrives and start a fresh bounded sample at the
          // first high byte, regardless of where the response is split.
          if (committedAscii && asciiPreviewPossible) {
            let skip = 0;
            while (skip < pending.length && (pending[skip] ?? 128) < 128) skip++;
            if (skip) await appendDecoded(previewDecoder.decode(pending.subarray(0, skip)));
            if (skip === pending.length) break;
            pending = pending.subarray(skip);
            asciiPreviewPossible = false;
          }
          const take = Math.min(pending.length, sampleLimit - sampleLength);
          const value = take === pending.length ? pending : pending.subarray(0, take);
          pending = pending.subarray(take);
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
          if (sampleLength < sampleLimit) { showUtf8Preview(value); continue; }
          if (!committedAscii && asciiPreviewPossible) {
            committedAscii = true;
            sampleChunks.length = 0;
            sampleLength = displayedSampleSize = asciiPrefixLength = 0;
            clearUtf8Preview();
            continue;
          }
          await startDecoder();
        }
      }
      // If no decoder was selected during streaming, successful completion of
      // startDecoder assigns one even for an empty sample. A failure is caught.
      if (!decoder) await startDecoder();
      await appendDecoded((/** @type {TextDecoder} */ (/** @type {unknown} */ (decoder))).decode(), (/** @type {TextDecoder} */ (/** @type {unknown} */ (decoder))).encoding);
    } catch (reason) {
      clearUtf8Preview();
      try {
        await reader.cancel(reason);
      } catch (_) {}
      throw reason;
    } finally {
      clearUtf8Preview();
      untrack();
      reader.releaseLock();
    }
  }

  /** @type {Uint8Array | undefined} */
  let cjkWeights;

  function getCjkWeights() {
    // Index just the CJK range, and only allocate this on the legacy path.
    const weights = new Uint8Array(0x9fff - 0x3400 + 1).fill(1);
    const common = "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经之进着等部家自理起现实都体制当本性应开合因由然前外政社义事相全与关各重新内正反明原利质向道命此变结解问意建公系军情者立代通题党程展料员革文总品活长求老基资级图统知组别期论运农指区战任处理世";
    for (let i = 0; i < common.length; i++) weights[common.charCodeAt(i) - 0x3400] = 6;
    return weights;
  }

  /** @param {string} text */
  function legacyEncodingScore(text) {
    // Tally the same UTF-16 code units and weights in one pass, without
    // materializing an array of matches for each class and candidate.
    const weights = cjkWeights ??= getCjkWeights();
    let cjk = 0, cyrillic = 0, controls = 0, replacements = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x3400 && code <= 0x9fff) cjk += /** @type {number} */ (weights[code - 0x3400]);
      else if (code >= 0x0400 && code <= 0x04ff) cyrillic++;
      else if (code === 0xfffd) replacements++;
      else if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) controls++;
    }
    return Math.max(cjk, cyrillic) - controls * 20 - replacements * 40;
  }

  /** @param {Uint8Array} bytes @param {string} [hint] @param {boolean} [leading] */
  function detectTextEncoding(bytes, hint = "", leading = true) {
    if (leading) {
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
    }
    // A late sample cannot reinterpret the committed ASCII prefix as UTF-16.
    const firstNull = leading ? bytes.indexOf(0) : -1;
    if (firstNull !== -1) {
      let evenNulls = 0, oddNulls = 0;
      for (let index = firstNull; index < bytes.length; index++) {
        if (!bytes[index]) {
          if (index % 2 === 0) evenNulls++;
          else oddNulls++;
        }
      }
      if (oddNulls > bytes.length / 8 && oddNulls > evenNulls * 4) return "utf-16le";
      if (evenNulls > bytes.length / 8 && evenNulls > oddNulls * 4) return "utf-16be";
    }
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
        const score = legacyEncodingScore(new TextDecoder(encoding).decode(bytes));
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
