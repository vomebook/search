(function(root) {
  "use strict";

  function createChapterRepository({ count, find, create, commit = (_index, value) => value }) {
    const records = Array.from({ length: count }, () => ({ status: "idle", attempts: 0, value: null, error: null, promise: null }));
    let disposed = false;

    function load(index) {
      if (disposed) return Promise.reject(new DOMException("Chapter repository disposed", "AbortError"));
      if (!Number.isInteger(index) || index < 0 || index >= records.length) return Promise.resolve(null);
      const record = records[index];
      const existing = find(index);
      if (existing) {
        record.status = "ready";
        record.value = existing;
        record.error = null;
        return Promise.resolve(existing);
      }
      if (record.promise) return record.promise;
      record.status = "loading";
      record.attempts += 1;
      record.error = null;
      const promise = Promise.resolve()
        .then(() => disposed ? null : create(index))
        .then((value) => {
          if (disposed) return null;
          record.status = "ready";
          record.value = find(index) || commit(index, value);
          return record.value;
        })
        .catch((error) => {
          if (!disposed) {
            record.status = "error";
            record.error = error;
          }
          throw error;
        })
        .finally(() => {
          if (record.promise === promise) record.promise = null;
        });
      record.promise = promise;
      return promise;
    }

    function state(index) {
      const record = records[index];
      return record ? Object.freeze({ status: record.status, attempts: record.attempts, value: record.value, error: record.error }) : null;
    }

    function release(index) {
      if (disposed || !Number.isInteger(index) || index < 0 || index >= records.length) return false;
      const record = records[index];
      if (record.promise) return false;
      record.status = "idle";
      record.value = null;
      record.error = null;
      return true;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const record of records) { record.status = "idle"; record.value = null; record.error = null; }
    }

    return Object.freeze({ load, state, release, dispose, get pending() { return records.flatMap((record) => record.promise ? [record.promise] : []); }, get disposed() { return disposed; } });
  }

  root.VoiceOfMLReaderChapters = Object.freeze({ createChapterRepository });
})(typeof self !== "undefined" ? self : globalThis);
