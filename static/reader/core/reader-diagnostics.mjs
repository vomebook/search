/**
 * @typedef {{at: number, stage: string, page: number, outcome: string, ms: number}} PdfTiming
 * @param {{readerAbortController: AbortController, pdfPageTimings: PdfTiming[],
 *   pdfStage(stage: string, page?: number): (outcome?: string) => void}} readerContext
 */
export function createReaderDiagnostics(readerContext) {
  /** @param {string} stage @param {number} [page] */
  function pdfStage(stage, page = 0) {
    const started = performance.now();
    return (outcome = "ready") => {
      if (readerContext.readerAbortController.signal.aborted) return;
      readerContext.pdfPageTimings.push({at:started, stage, page, outcome, ms:performance.now()-started});
      if (readerContext.pdfPageTimings.length > 64) readerContext.pdfPageTimings.shift();
    };
  }

  /** @template T @param {T | PromiseLike<T>} promise @param {string} stage @param {number} [page] @returns {Promise<Awaited<T>>} */
  function measurePdf(promise, stage, page = 0) {
    const finish = readerContext.pdfStage(stage,page);
    return Promise.resolve(promise).then(value => { finish(); return value; }, error => {
      finish(error?.name === "AbortError" ? "cancelled" : "failed"); throw error;
    });
  }

  return {
    pdfStage,
    measurePdf
  };
}
