/**
 * @param {{assertActive: () => void, abortError: () => Error,
 *   trackResource: (cleanup: () => void) => () => void,
 *   request: (url: string, timeout: number, options: {signal?: AbortSignal, priority: string}) => Promise<Response>,
 *   readBytes: (response: Response) => Promise<Uint8Array<ArrayBuffer>>, timeoutMs: number}} options
 */
export function createReaderImageLoader({assertActive, abortError, trackResource, request, readBytes, timeoutMs}) {
  /** @param {HTMLImageElement} image @param {string} target @param {number} timeoutMs @param {AbortSignal | undefined} signal */
  function wait(image, target, timeoutMs, signal) {
    assertActive();
    return /** @type {Promise<HTMLImageElement>} */ (new Promise((resolve, reject) => {
      let settled = false, timeout = 0, untrack = () => {};
      const abort = () => finish(abortError());
      /** @param {Error} [error] */
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        untrack();
        signal?.removeEventListener("abort", abort);
        image.onload = image.onerror = null;
        if (error) {
          image.removeAttribute("src");
          reject(error);
        } else resolve(image);
      };
      untrack = trackResource(() => finish(abortError()));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      if (settled) return;
      timeout = setTimeout(() => finish(new DOMException("Reader image stalled", "TimeoutError")), timeoutMs);
      image.onload = () => finish();
      image.onerror = () => finish(new Error("image load failed"));
      if (image.src !== new URL(target, location.href).href) image.src = target;
      if (image.complete && image.naturalWidth) finish();
    }));
  }

  /** @param {HTMLImageElement} image @param {string} target @param {AbortSignal | undefined} signal @param {number} [deadline] */
  async function load(image, target, signal, deadline = performance.now() + timeoutMs) {
    const remaining = () => Math.max(1, deadline - performance.now());
    const network = /^https?:$/.test(new URL(target, location.href).protocol);
    try {
      return await wait(image, target, Math.min(network ? 15000 : timeoutMs, remaining()), signal);
    } catch (error) {
      assertActive();
      signal?.throwIfAborted();
      if (!network || typeof error !== "object" || error === null || !("name" in error) ||
          error.name !== "TimeoutError" || !navigator.onLine) throw error;
    }
    const response = await request(target, remaining(),
      { signal, priority: image.fetchPriority || "auto" });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`HTTP ${response.status}`), {status: response.status});
    }
    const bytes = await readBytes(response);
    assertActive();
    signal?.throwIfAborted();
    const blobUrl = URL.createObjectURL(new Blob([bytes], {type: response.headers.get("Content-Type") || ""}));
    try {
      return await wait(image, blobUrl, Math.min(20000, remaining()), signal);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  return Object.freeze({load});
}
