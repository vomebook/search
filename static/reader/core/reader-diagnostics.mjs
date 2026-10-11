export function createReaderDiagnostics(readerContext) {
  function pdfStage(stage, page = 0) {
    const started = performance.now();
    return (outcome = "ready") => {
      if (readerContext.readerAbortController.signal.aborted) return;
      readerContext.pdfPageTimings.push({at:started, stage, page, outcome, ms:performance.now()-started});
      if (readerContext.pdfPageTimings.length > 64) readerContext.pdfPageTimings.shift();
    };
  }

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
