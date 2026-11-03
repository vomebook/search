const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadManager(fetchImpl) {
  const timers = new Map();
  let nextTimer = 1;
  const sandbox = {
    self: {},
    DOMException,
    Response,
    ReadableStream,
    AbortController,
    fetch: fetchImpl,
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  };
  sandbox.self = sandbox;
  const filename = path.join(__dirname, "../static/reader/core/reader-request-manager.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  return { manager: sandbox.VoiceOfMLReaderRequests.createReaderRequestManager(), timers };
}

async function main() {
  let resolveFetch,
    calls = 0;
  const shared = loadManager(() => {
    calls += 1;
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  });
  const first = shared.manager.request("book", 1000),
    second = shared.manager.request("book", 1000);
  await Promise.resolve();
  assert.notStrictEqual(first, second);
  assert.strictEqual(calls, 1);
  assert.strictEqual(shared.timers.size, 1);
  resolveFetch(new Response("shared body", { status: 200 }));
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.notStrictEqual(firstResponse, secondResponse);
  assert.strictEqual(await firstResponse.text(), "shared body");
  assert.strictEqual(await secondResponse.text(), "shared body");
  assert.strictEqual(shared.manager.pendingCount, 0);
  assert.strictEqual(shared.manager.activeCount, 0);
  assert.strictEqual(shared.timers.size, 0);

  const optionCalls = [];
  const distinct = loadManager((url, init) => new Promise((resolve) => optionCalls.push({ url, init, resolve })));
  const variants = [
    distinct.manager.request("document", 1000, { headers: { Range: "bytes=0-9" } }),
    distinct.manager.request("document", 1000, { headers: { Range: "bytes=10-19" } }),
    distinct.manager.request("document", 1000, { method: "HEAD" }),
    distinct.manager.request("document", 25),
    distinct.manager.request("document", 1000),
    distinct.manager.request("document", 1000, { priority: "high" })
  ];
  await Promise.resolve();
  assert.strictEqual(optionCalls.length, 5, "different ranges, methods and deadlines must not share a response");
  for (const { init, resolve } of optionCalls)
    resolve(new Response(init.method === "HEAD" ? null : (init.headers?.Range || "whole body")));
  const variantResponses = await Promise.all(variants);
  assert.deepStrictEqual(await Promise.all(variantResponses.map(response => response.text())),
    ["bytes=0-9", "bytes=10-19", "", "whole body", "whole body", "whole body"]);
  assert.strictEqual(distinct.manager.activeCount, 0);
  assert.strictEqual(distinct.timers.size, 0);

  const caller = new AbortController();
  const ownedCalls = [];
  const owned = loadManager((_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    ownedCalls.push({ resolve });
  }));
  const ownedRequest = owned.manager.request("same-source", 1000, { signal: caller.signal });
  const otherRequest = owned.manager.request("same-source", 1000);
  await Promise.resolve();
  assert.strictEqual(ownedCalls.length, 2);
  caller.abort(new DOMException("Caller cancelled", "AbortError"));
  await assert.rejects(ownedRequest, error => error === caller.signal.reason);
  ownedCalls[1].resolve(new Response("unaffected"));
  assert.strictEqual(await (await otherRequest).text(), "unaffected");
  await assert.rejects(owned.manager.request("already-cancelled", 1000, { signal: caller.signal }),
    error => error === caller.signal.reason);
  assert.strictEqual(ownedCalls.length, 2);
  assert.strictEqual(owned.manager.activeCount, 0);
  assert.strictEqual(owned.timers.size, 0);

  const bodyCaller = new AbortController();
  let ownedBodyCancels = 0;
  const ownedBody = loadManager(() => Promise.resolve(new Response(new ReadableStream({
    cancel() { ownedBodyCancels++; }
  }))));
  const ownedResponse = await ownedBody.manager.request("owned-body", 1000, { signal: bodyCaller.signal });
  bodyCaller.abort(new DOMException("Caller cancelled body", "AbortError"));
  await assert.rejects(ownedResponse.text(), error => error === bodyCaller.signal.reason);
  assert.strictEqual(ownedBodyCancels, 1);
  assert.strictEqual(ownedBody.manager.activeCount, 0);
  assert.strictEqual(ownedBody.timers.size, 0);

  const timedOut = loadManager(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.onabort = () => reject(new DOMException("timed out", "AbortError"));
      })
  );
  const timedRequest = timedOut.manager.request("timeout", 25);
  await Promise.resolve();
  [...timedOut.timers.values()][0]();
  await assert.rejects(timedRequest, (error) => error.name === "TimeoutError");
  assert.strictEqual(timedOut.manager.pendingCount, 0);
  assert.strictEqual(timedOut.timers.size, 0);

  let attempts = 0;
  const retry = loadManager(() =>
    ++attempts === 1 ? Promise.reject(new Error("temporary")) : Promise.resolve({ ok: true })
  );
  await assert.rejects(retry.manager.request("retry", 1000), /temporary/);
  assert.strictEqual((await retry.manager.request("retry", 1000)).ok, true);
  assert.strictEqual(attempts, 2);

  const disposed = loadManager(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.onabort = () => reject(new DOMException("aborted", "AbortError"));
      })
  );
  const pending = disposed.manager.request("slow", 1000);
  await Promise.resolve();
  disposed.manager.dispose();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.strictEqual(disposed.manager.pendingCount, 0);
  assert.strictEqual(disposed.timers.size, 0);
  await assert.rejects(
    disposed.manager.request("late", 1000),
    (error) => error.name === "AbortError"
  );

  let streamController;
  const bodyTimeout = loadManager((_url, { signal }) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            streamController = controller;
            signal.onabort = () => controller.error(new DOMException("timed out", "AbortError"));
          }
        }),
        { status: 200 }
      )
    )
  );
  const bodyRequest = bodyTimeout.manager.request("body", 25);
  const bodyResponse = await bodyRequest;
  assert.strictEqual(bodyTimeout.timers.size, 1);
  [...bodyTimeout.timers.values()][0]();
  await assert.rejects(bodyResponse.text(), (error) => error.name === "TimeoutError");
  assert.ok(streamController);
  assert.strictEqual(bodyTimeout.timers.size, 0);
  assert.strictEqual(bodyTimeout.manager.activeCount, 0);

  // Fetch headers have settled, but both independent bodies still need disposal.
  let bodyCancels = 0;
  const signals = [];
  const streaming = loadManager((_url, { signal }) => {
    signals.push(signal);
    return Promise.resolve(
      new Response(
        new ReadableStream({
          cancel(reason) {
            assert.strictEqual(reason.name, "AbortError");
            bodyCancels++;
          }
        })
      )
    );
  });
  const firstBody = await streaming.manager.request("stream", 1000);
  const secondBody = await streaming.manager.request("stream", 1000);
  assert.strictEqual(streaming.manager.pendingCount, 0);
  assert.strictEqual(streaming.manager.activeCount, 2);
  const firstReading = assert.rejects(firstBody.text(), (error) => error.name === "AbortError");
  streaming.manager.dispose();
  await firstReading;
  await assert.rejects(secondBody.text(), (error) => error.name === "AbortError");
  assert.strictEqual(bodyCancels, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.strictEqual(streaming.timers.size, 0);
  assert.strictEqual(streaming.manager.activeCount, 0);
  streaming.manager.dispose();
  assert.strictEqual(bodyCancels, 2);

  let finishClonedFetch,
    cloneCancels = 0;
  const cloned = loadManager(
    () =>
      new Promise((resolve) => {
        finishClonedFetch = resolve;
      })
  );
  const cloneOne = cloned.manager.request("clones", 1000),
    cloneTwo = cloned.manager.request("clones", 1000);
  await Promise.resolve();
  finishClonedFetch(
    new Response(
      new ReadableStream({
        cancel() {
          cloneCancels++;
        }
      })
    )
  );
  const cloneResponses = await Promise.all([cloneOne, cloneTwo]);
  const cloneReads = cloneResponses.map((response) =>
    assert.rejects(response.text(), (error) => error.name === "AbortError")
  );
  cloned.manager.dispose();
  await Promise.all(cloneReads);
  assert.strictEqual(cloneCancels, 1);
  assert.strictEqual(cloned.manager.activeCount, 0);

  const cancelled = loadManager(() => Promise.resolve(new Response(new ReadableStream())));
  const cancelResponse = await cancelled.manager.request("cancel", 1000);
  await cancelResponse.body.cancel();
  assert.strictEqual(cancelled.manager.activeCount, 0);
  assert.strictEqual(cancelled.timers.size, 0);

  let queuedCalls = 0;
  const queued = loadManager(() => {
    queuedCalls++;
    return Promise.resolve(new Response("unused"));
  });
  const queuedRequest = queued.manager.request("queued", 1000);
  queued.manager.dispose();
  await assert.rejects(queuedRequest, (error) => error.name === "AbortError");
  assert.strictEqual(queuedCalls, 0);
  assert.strictEqual(queued.manager.activeCount, 0);

  let finishLate,
    lateCancels = 0;
  const late = loadManager(
    () =>
      new Promise((resolve) => {
        finishLate = resolve;
      })
  );
  const lateRequest = late.manager.request("late-response", 1000);
  await Promise.resolve();
  late.manager.dispose();
  finishLate(
    new Response(
      new ReadableStream({
        cancel() {
          lateCancels++;
        }
      })
    )
  );
  await assert.rejects(lateRequest, (error) => error.name === "AbortError");
  assert.strictEqual(lateCancels, 1);
  assert.strictEqual(late.manager.activeCount, 0);
  // Exercise the same cancellation boundaries for deadlines and lifecycle disposal.
  for (const timeout of [true, false]) {
    const name = timeout ? "TimeoutError" : "AbortError";
    const stop = (harness) => {
      if (timeout) [...harness.timers.values()][0]();
      else harness.manager.dispose();
    };
    const assertSettled = (harness) => {
      assert.strictEqual(harness.manager.pendingCount, 0);
      assert.strictEqual(harness.manager.activeCount, 0);
      assert.strictEqual(harness.timers.size, 0);
      assert.strictEqual(harness.manager.disposed, !timeout);
    };

    let starts = 0;
    const beforeFetch = loadManager(() => {
      starts++;
      return Promise.resolve(new Response("unused"));
    });
    const queued = beforeFetch.manager.request("queued", 25);
    stop(beforeFetch);
    await assert.rejects(queued, (error) => error.name === name);
    assert.strictEqual(starts, 0);
    assertSettled(beforeFetch);

    let headerSignal;
    const headers = loadManager((_url, { signal }) => {
      headerSignal = signal;
      return new Promise((_resolve, reject) => {
        // Some transports reject with AbortError even when given a custom reason.
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("transport aborted", "AbortError")),
          { once: true }
        );
      });
    });
    const headerRequests = [
      headers.manager.request("headers", 25),
      headers.manager.request("headers", 25)
    ];
    await Promise.resolve();
    stop(headers);
    await Promise.all(
      headerRequests.map((request) =>
        assert.rejects(request, (error) => error === headerSignal.reason && error.name === name)
      )
    );
    assertSettled(headers);

    let finish, lateSignal, cancelledWith;
    const delayedHeaders = loadManager((_url, { signal }) => {
      lateSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const delayedRequest = delayedHeaders.manager.request("late", 25);
    await Promise.resolve();
    stop(delayedHeaders);
    finish(
      new Response(
        new ReadableStream({
          cancel(reason) {
            cancelledWith = reason;
          }
        })
      )
    );
    await assert.rejects(
      delayedRequest,
      (error) => error === lateSignal.reason && error.name === name
    );
    assert.strictEqual(cancelledWith, lateSignal.reason);
    assertSettled(delayedHeaders);

    let bodySignal,
      cancels = 0;
    const bodies = loadManager((_url, { signal }) => {
      bodySignal = signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            cancel(reason) {
              assert.strictEqual(reason, signal.reason);
              assert.strictEqual(reason.name, name);
              cancels++;
            }
          })
        )
      );
    });
    const responses = await Promise.all([
      bodies.manager.request("clones", 25),
      bodies.manager.request("clones", 25)
    ]);
    assert.notStrictEqual(responses[0], responses[1]);
    assert.strictEqual(bodies.manager.pendingCount, 0);
    assert.strictEqual(bodies.manager.activeCount, 1);
    const reads = responses.map((response) =>
      assert.rejects(response.text(), (error) => error.name === name)
    );
    stop(bodies);
    const firstReason = bodySignal.reason;
    bodies.manager.dispose();
    await Promise.all(reads);
    assert.strictEqual(bodySignal.reason, firstReason);
    assert.strictEqual(bodySignal.reason.name, name);
    assert.strictEqual(cancels, 1);
    assert.strictEqual(bodies.manager.activeCount, 0);
    assert.strictEqual(bodies.timers.size, 0);
  }
  console.log("reader request manager contracts passed");
}

require("node:test")("reader request manager behavior", {timeout: 10000}, main);
