(function (root) {
  "use strict";

  /**
   * @template T
   * @typedef {{ status: "idle" | "loading" | "ready" | "error", attempts: number,
   *   value: T | null, error: unknown, promise: Promise<T | null> | null }} ChapterRecord
   */
  /**
   * @template T
   * @param {{count: number, find: (index: number) => T | null | undefined,
   *   create: (index: number) => T | Promise<T>, commit?: (index: number, value: T) => T}} options
   */
  function createChapterRepository({ count, find, create, commit = (_index, value) => value }) {
    /** @type {ChapterRecord<T>[]} */
    const records = Array.from({ length: count }, () => ({
      status: "idle",
      attempts: 0,
      value: null,
      error: null,
      promise: null
    }));
    let disposed = false;

    /** @param {number} index @returns {Promise<T | null>} */
    function load(index) {
      if (disposed)
        return Promise.reject(new DOMException("Chapter repository disposed", "AbortError"));
      if (!Number.isInteger(index) || index < 0 || index >= records.length)
        return Promise.resolve(null);
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
        .then(() => (disposed ? null : create(index)))
        .then((value) => {
          if (disposed) return null;
          record.status = "ready";
          // The earlier null sentinel requires disposed=true, and dispose is
          // monotonic, so it cannot reach commit after the guard above.
          record.value = find(index) || commit(index, /** @type {T} */ (value));
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

    /** @param {number} index */
    function state(index) {
      const record = records[index];
      return record
        ? Object.freeze({
            status: record.status,
            attempts: record.attempts,
            value: record.value,
            error: record.error
          })
        : null;
    }

    /** @param {number} index */
    function release(index) {
      if (disposed || !Number.isInteger(index) || index < 0 || index >= records.length)
        return false;
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
      for (const record of records) {
        record.status = "idle";
        record.value = null;
        record.error = null;
      }
    }

    return Object.freeze({
      load,
      state,
      release,
      dispose,
      get pending() {
        return records.flatMap((record) => (record.promise ? [record.promise] : []));
      },
      get disposed() {
        return disposed;
      }
    });
  }

  /**
   * @template T
   * @typedef {{index: number, demand: boolean, started: boolean, controller: AbortController,
   *   promise: Promise<T>, resolve: (value: T | PromiseLike<T>) => void, reject: (reason: unknown) => void}} SchedulerRecord
   */
  /**
   * @template T
   * @param {{create: (index: number, signal: AbortSignal, priority: "high" | "low") => T | Promise<T>,
   *   concurrency?: number, speculativeLimit?: number}} options
   */
  function createChapterScheduler({ create, concurrency = 3, speculativeLimit = 2 }) {
    /** @type {Map<number, SchedulerRecord<T>>} */
    const records = new Map(),
    /** @type {Set<SchedulerRecord<T>>} */
      active = new Set();
    let disposed = false, scheduled = false;
    const abortError = () => new DOMException("Chapter load cancelled", "AbortError");
    /** @param {SchedulerRecord<T>} record */
    function cancel(record) {
      if (records.get(record.index) !== record) return;
      records.delete(record.index);
      record.controller.abort(abortError());
      record.reject(record.controller.signal.reason);
    }
    function pump() {
      scheduled = false;
      if (disposed) return;
      while (active.size < concurrency) {
        const queued = [...records.values()].filter(record => !record.started);
        const speculative = [...active].filter(record => !record.demand).length;
        const record = queued.find(record => record.demand) ||
          (speculative < speculativeLimit && queued.find(record => !record.demand));
        if (!record) break;
        record.started = true;
        active.add(record);
        Promise.resolve().then(() => {
          record.controller.signal.throwIfAborted();
          return create(record.index, record.controller.signal, record.demand ? "high" : "low");
        }).then(value => {
          record.controller.signal.throwIfAborted();
          record.resolve(value);
        }).catch(record.reject).finally(() => {
          active.delete(record);
          if (records.get(record.index) === record) records.delete(record.index);
          schedule();
        });
      }
    }
    function schedule() {
      if (scheduled || disposed) return;
      scheduled = true;
      Promise.resolve().then(pump);
    }
    /** @param {number} index @param {boolean} [demand] @param {boolean} [exclusive] */
    function load(index, demand = true, exclusive = false) {
      if (disposed) return Promise.reject(abortError());
      if (demand && exclusive)
        for (const record of records.values())
          if (record.demand && record.index !== index) cancel(record);
      let record = records.get(index);
      if (demand && !record) {
        for (const record of records.values())
          if (!record.demand && record.index !== index) cancel(record);
      }
      if (record) {
        record.demand ||= demand;
        schedule();
        return record.promise;
      }
      // The Promise executor synchronously installs resolve/reject before the
      // record is published to the queue or used by any scheduler callback.
      record = /** @type {SchedulerRecord<T>} */ (/** @type {unknown} */ (
        { index, demand, started: false, controller: new root.AbortController() }));
      record.promise = new Promise((resolve, reject) => Object.assign(record, { resolve, reject }));
      records.set(index, record);
      schedule();
      return record.promise;
    }
    /** @param {number[]} indices */
    function prefetch(indices) {
      const wanted = new Set(indices);
      for (const record of records.values())
        if (!record.demand && !wanted.has(record.index)) cancel(record);
      for (const index of wanted) load(index, false).catch(() => {});
    }
    function dispose() {
      disposed = true;
      for (const record of records.values()) cancel(record);
    }
    return Object.freeze({
      load, prefetch, dispose,
      get activeCount() { return active.size; },
      get pendingCount() { return records.size; }
    });
  }

  root.VoiceOfMLReaderChapters = Object.freeze({ createChapterRepository, createChapterScheduler });
})(typeof self !== "undefined" ? self : globalThis);
