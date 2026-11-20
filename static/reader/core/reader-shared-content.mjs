/** Shared content helpers for the chapter reader and HTML documents.
 * @param {Element} content
 */
export function chapterAnchorCandidates(content) {
  return [...content.querySelectorAll('.reader-epub-chapter')].flatMap(article => [
    article,
    ...article.querySelectorAll(':is(h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,img,table)')
  ]);
}

/** @param {{assertReaderActive: () => void, awaitReader: (value: Promise<unknown>) => Promise<unknown>}} readerContext */
export function createImageSettler(readerContext) {
  /** @param {ParentNode} root @param {number} [timeoutMs] */
  return async function settleReaderImages(root, timeoutMs = 2500) {
    readerContext.assertReaderActive();
    const images = [...root.querySelectorAll(/** @type {'img'} */ ('img[src],img[srcset]'))];
    if (!images.length) return;
    let timeout = 0, active = true;
    /** @type {Set<() => void>} */
    const cleanups = new Set();
    const decoded = Promise.allSettled(images.map(async image => {
      image.loading = 'eager';
      image.decoding = 'async';
      if (!image.complete) await /** @type {Promise<void>} */ (new Promise(resolve => {
        const finish = () => {
          image.removeEventListener('load', finish);
          image.removeEventListener('error', finish);
          cleanups.delete(finish);
          resolve();
        };
        cleanups.add(finish);
        image.addEventListener('load', finish, { once: true });
        image.addEventListener('error', finish, { once: true });
        if (image.complete) finish();
      }));
      if (active) {
        try { await image.decode?.(); } catch (_) {}
      }
    }));
    try {
      await readerContext.awaitReader(Promise.race([
        decoded,
        new Promise(resolve => { timeout = setTimeout(resolve, timeoutMs); })
      ]));
    } finally {
      active = false;
      clearTimeout(timeout);
      for (const cleanup of cleanups) cleanup();
    }
  };
}
