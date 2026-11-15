/// <reference path="../../../typings/reader-globals.d.ts" />

const runtime = VoiceOfMLReaderRuntime.createReaderRuntime({
  events: VoiceOfMLReaderRuntime.createEventBus(),
  initialState: {document: {title: "", zoom: 1, page: 1, pageCount: 0, restoredEntry: null, restorationReady: false}}
});
runtime.update("document", {page: 2, restorationReady: true});
runtime.update("source", {url: "book"});
runtime.update("formats", {active: "pdf", pdf: {activeRenders: 1}});
runtime.updateFormat("pdf", {activeRenders: 1});
runtime.updateFormat("custom", {value: false});
runtime.events.on("state", (detail, type) => { void detail; type.toUpperCase(); });
runtime.track({dispose() {}});
runtime.cancel(runtime.schedule(() => {}));
runtime.snapshot().formats.pdf.activeRenders;
runtime.snapshot().formats.active;
runtime.snapshot().formats.custom?.value;
runtime.negotiate({mode: "pdf"});
// @ts-expect-error capability must be set using negotiate
runtime.update("capability", {mode: "pdf"});
// @ts-expect-error an unknown format may not exist, even without noUncheckedIndexedAccess
runtime.snapshot().formats.custom.value;
// @ts-expect-error snapshot format records are frozen
runtime.snapshot().formats.pdf.activeRenders = 1;

// @ts-expect-error page is numeric
runtime.update("document", {page: "2"});
// @ts-expect-error url belongs to source, not document
runtime.update("document", {url: "book"});
// @ts-expect-error unknown domain
runtime.update("missing", {});
// @ts-expect-error format containers must be object records
runtime.update("formats", {pdf: 3});
// @ts-expect-error format patches are records, not primitives
runtime.updateFormat("pdf", 3);
// @ts-expect-error initialState replaces a whole domain, not a partial domain
VoiceOfMLReaderRuntime.createReaderRuntime({initialState: {document: {page: 2}}});
// @ts-expect-error listener type must be a string
runtime.events.on(42, () => {});
// @ts-expect-error timers require a callback
runtime.schedule("callback");
// @ts-expect-error snapshots are frozen
runtime.snapshot().document.page = 3;
