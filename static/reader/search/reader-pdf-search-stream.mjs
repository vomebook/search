// Bounded streams used by the PDF book/partition search Worker.
// Both sinks preserve cancellation and reject before returning partial data.

/** @template T @typedef {{append: (chunk: Uint8Array, size: number) => void, finish: (size: number) => T}} Sink */

/** @param {number} expected @returns {Sink<Uint8Array<ArrayBuffer>>} */
function bytesSink(expected) {
  const bytes = new Uint8Array(expected);
  return {
    append(chunk, size) {
      if (size > bytes.length) throw new Error("READER_RESOURCE_LIMIT");
      bytes.set(chunk, size - chunk.byteLength);
    },
    finish(size) {
      if (size !== expected) throw new Error("PDF_OCR_SIZE_MISMATCH");
      return bytes;
    }
  };
}

/** @returns {Sink<string>} */
function textSink() {
  const decoder = new TextDecoder();
  /** @type {string[]} */
  const chunks = [];
  return {
    append(chunk) { chunks.push(decoder.decode(chunk, {stream: true})); },
    finish() { chunks.push(decoder.decode()); return chunks.join(""); }
  };
}

/** @template T
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {AbortSignal} signal @param {number} limit @param {Sink<T>} sink @returns {Promise<T>} */
async function consume(reader, signal, limit, sink) {
  let size = 0;
  const cancel = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, {once: true});
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");
      const {value, done} = await reader.read();
      if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("READER_RESOURCE_LIMIT");
      sink.append(value, size);
    }
    return sink.finish(size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** @param {ReadableStream<Uint8Array>} stream @param {AbortSignal} signal
 * @param {number} expected @param {number} limit @returns {Promise<Uint8Array<ArrayBuffer>>} */
export async function readPdfSearchBytes(stream, signal, expected, limit) {
  const sink = bytesSink(expected);
  const reader = stream.getReader();
  return consume(reader, signal, limit, sink);
}

/** @param {ReadableStream<Uint8Array>} stream @param {AbortSignal} signal
 * @param {number} limit @returns {Promise<string>} */
export async function readPdfSearchText(stream, signal, limit) {
  const reader = stream.getReader();
  return consume(reader, signal, limit, textSink());
}
