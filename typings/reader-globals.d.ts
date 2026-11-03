// Runtime classic-script interfaces. Their implementations live in
// static/reader-resources.js and static/reader/core, loaded by reader.html.
// Classic search helpers are loaded before app.js, and composed into it in production.
declare function bytesToDisplay(bytes: number | null | undefined): {value: string; unit: "B" | "KB" | "MB" | "GB"};
declare function fmtSizeUrl(bytes: number | null | undefined): string | null;
declare function parseSizeStr(value: string | null | undefined): number | null;

interface ReaderSecurityApi {
  readonly LIMITS: Readonly<{
    documentBytes: number; pdfRangeDocumentBytes: number; archiveCompressedBytes: number;
    archiveExpandedBytes: number; archiveEntries: number; archiveRatio: number;
    manifestBytes: number; pdfPages: number; chapters: number; chapterBytes: number;
    chapterTotalBytes: number;
  }>;
  assertResponseSize(response: Response, limit: number): Response;
  createByteBudget(limit?: number): { reserve(bytes: number): void; release(bytes: number): void; readonly used: number; readonly remaining: number };
  readBytes(response: Response, limit?: number, budget?: ReturnType<ReaderSecurityApi["createByteBudget"]>): Promise<Uint8Array<ArrayBuffer>>;
  readText(response: Response, limit?: number, encoding?: string, budget?: ReturnType<ReaderSecurityApi["createByteBudget"]>): Promise<string>;
  inspectZip(bytes: ArrayBuffer | Uint8Array, limits?: ReaderSecurityApi["LIMITS"]): {entries: number; compressed: number; expanded: number};
  validateChapterManifest<T>(manifest: T): T;
  validatePdfPageManifest<T>(manifest: T): T;
  validatePdfOcrManifest<T>(manifest: T): T;
  validatePdfOcrPage<T>(payload: T, pageNumber: number): T;
  isZipContainer(extension: string, bytes?: Uint8Array): boolean;
}

interface ReaderResourcesApi {
  readonly vendors: Record<string, { readonly url: string; readonly file: string; readonly sha256: string }>;
  readonly foliateVendors: Record<string, { readonly url: string; readonly file: string; readonly sha256: string }>;
  readonly readerFiles: readonly string[];
  readonly readerComponentFiles: readonly string[];
  vendorUrl(name: string, base: string): string;
  runtimePaths(base: string): string[];
  shellAssets(base: string): string[];
  pdfSupportAssets(base: string): string[];
  djvuDecoderAssets(base: string): string[];
  engineAssets(extension: string, base: string, foliateSuffix?: string, workerWrapper?: string): string[];
}

interface ReaderContractApi {
  readonly ReaderMode: Readonly<Record<string, number>>;
  readonly articleExtensions: readonly string[];
  capability(extension: string): any;
  readonly features: Readonly<Record<string, object>>;
  clampNumber(value: number, min: number, max: number, fallback: number): number;
  assetFields(asset: any, base: string, extension: string): any;
  isBucketPath(path: string, source?: boolean, bucket?: string): boolean;
  pdfPageSource(url: string, origin: string, upstream: string, filename?: string, bucketName?: string): any;
  imagePageSource(url: string, origin: string, upstream: string): any;
  canonicalSourceUrl(value: string): string;
  shortSourceId(value: string): string;
  readerUrl(record: any, basePath?: string): string;
}

declare var VoiceOfMLReaderSecurity: ReaderSecurityApi;
declare var VoiceOfMLReaderResources: ReaderResourcesApi;
declare var VoiceOfMLReader: ReaderContractApi;
interface ReaderStoreApi {
  readonly STORE_VERSION: string;
  get(url: string): Promise<any>;
  put(entry: any): Promise<void>;
  list(): Promise<any[]>;
  remove(url: string): Promise<void>;
  clearHistory(): Promise<void>;
  putBookmark(entry: any): Promise<void>;
  listBookmarks(url: string): Promise<any[]>;
  listAllBookmarks(): Promise<any[]>;
  removeBookmark(id: string): Promise<void>;
  subscribe(callback: (message: any) => void): () => void;
  dispose(): void;
}
declare var VoiceOfMLReaderStore: ReaderStoreApi;
interface ReaderRequestManagerOptions {
  fetchImpl?: typeof fetch;
  AbortControllerImpl?: typeof AbortController;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  initialIdleMs?: number;
}
interface ReaderRequestManager {
  request(url: RequestInfo | URL, timeoutMs: number, requestInit?: RequestInit): Promise<Response>;
  requestBuffered(url: RequestInfo | URL, timeoutMs: number, limit: number, requestInit?: RequestInit): Promise<Response>;
  dispose(): void;
  readonly pendingCount: number;
  readonly activeCount: number;
  readonly disposed: boolean;
}
interface ReaderRequestManagerApi { createReaderRequestManager(options?: ReaderRequestManagerOptions): Readonly<ReaderRequestManager> }
interface ReaderRuntimeApi { createReaderRuntime(): any }
interface ReaderFormatAdapter {
  open(): unknown;
  render(prepared: unknown): unknown;
  restore(entry: unknown, generation: number): unknown;
  dispose(): unknown;
}
interface ReaderAdapterRegistry {
  register(mode: string, adapter: ReaderFormatAdapter): Readonly<ReaderFormatAdapter & { mode: string }>;
  activate(mode: string): Readonly<ReaderFormatAdapter & { mode: string }>;
  get(mode: string): Readonly<ReaderFormatAdapter & { mode: string }> | null;
  dispose(): unknown;
  readonly active: Readonly<ReaderFormatAdapter & { mode: string }> | null;
  readonly modes: string[];
}
interface ReaderAdaptersApi {
  readonly METHODS: readonly (keyof ReaderFormatAdapter)[];
  createAdapterRegistry(): ReaderAdapterRegistry;
}
interface ReaderScrollAnchor { node: Element; offset: number; generation: number }
interface ReaderScrollAnchorManager {
  capture(): ReaderScrollAnchor | null;
  restore(snapshot?: ReaderScrollAnchor | null): boolean;
  remember(): void;
  preserve<T>(change: () => T): T;
  observe(node: Element): void;
  unobserve(node: Element): void;
  invalidate(): void;
  dispose(): void;
  whenIdle(task: () => void): void;
  readonly scrolling: boolean;
}
interface ReaderScrollApi {
  createScrollAnchorManager(options: {
    viewport: Element;
    candidates(): Element[];
    ResizeObserverImpl?: typeof ResizeObserver;
    requestFrame?: typeof requestAnimationFrame;
    cancelFrame?: typeof cancelAnimationFrame;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    scrollIdleDelay?: number;
  }): ReaderScrollAnchorManager;
}
interface ChapterScheduler<T> {
  load(index: number, demand?: boolean, exclusive?: boolean): Promise<T>;
  prefetch(indices: number[]): void;
  dispose(): void;
  readonly activeCount: number;
  readonly pendingCount: number;
}
interface ChapterRepositoryState<T> {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly attempts: number;
  readonly value: T | null;
  readonly error: unknown;
}
interface ReaderChaptersApi {
  createChapterScheduler<T>(options: {
    create(index: number, signal: AbortSignal, priority: "high" | "low"): T | Promise<T>;
    concurrency?: number;
    speculativeLimit?: number;
  }): ChapterScheduler<T>;
  createChapterRepository<T>(options: {
    count: number;
    find(index: number): T | null | undefined;
    create(index: number): T | Promise<T>;
    commit?(index: number, value: T): T;
  }): {
    load(index: number): Promise<T | null>;
    state(index: number): ChapterRepositoryState<T> | null;
    release(index: number): boolean;
    dispose(): void;
    readonly pending: Promise<T | null>[];
    readonly disposed: boolean;
  };
}
interface ReaderVirtualApi {
  createSectionVirtualizer<T extends Element>(options: {
    limit: number;
    getLoaded(): T[];
    getIndex(node: T): number;
    getHeight(node: T): number;
    virtualize(node: T, index: number, height: number): unknown;
    release(index: number): unknown;
    preserve?(change: () => void): void;
    canVirtualize?(node: T, index: number): boolean;
  }): { trim(centerIndex: number): {removed: number; retained: number}; dispose(): void; readonly limit: number };
}
declare var VoiceOfMLReaderRequests: ReaderRequestManagerApi;
declare var VoiceOfMLReaderRuntime: ReaderRuntimeApi;
declare var VoiceOfMLReaderAdapters: ReaderAdaptersApi;
declare var VoiceOfMLReaderScroll: ReaderScrollApi;
declare var VoiceOfMLReaderChapters: ReaderChaptersApi;
declare var VoiceOfMLReaderVirtual: ReaderVirtualApi;

interface SearchSessionApi {
  createSearchSession(options: {canPersist(): boolean; canRestore(target?: URL): boolean}): {
    openSearchSessionDB(): Promise<IDBDatabase>;
    persistSearchSession(): Promise<void>;
    restoreSearchSession(): Promise<boolean>;
  };
}
interface DownloadControllerApi {
  createDownloadController(options: {
    buildCheckUrl(link: string): string;
    buildDownloadUrl(filename: string, link: string): string;
    triggerDownload(url: string): void;
    showToast(message: string, duration?: number): void;
    isSpeculativeAllowed?(): boolean;
    isBatchActive?(): boolean;
    timeout?: number;
  }): {
    downloadChecks: Map<string, unknown>;
    downloadCheckQueue: unknown[];
    pendingDownloads: Map<string, unknown>;
    checkDownload(link: string, speculative?: boolean, signal?: AbortSignal): Promise<boolean | string>;
    runDownloadCheck(item: unknown): Promise<void>;
    pumpDownloadChecks(): void;
    scheduleDownloadLaunch(filename: string, link: string, cancelled: () => boolean): Promise<boolean>;
    downloadFile(filename: string, link: string, options?: {button?: HTMLElement; quiet?: boolean; skipCheck?: boolean; signal?: AbortSignal; batch?: object}): Promise<boolean>;
    readonly activeDownloadChecks: number;
  };
}
interface SearchReaderNavigationApi {
  createNavigation(readerPath: string, options?: {resume?(url: string): void; close?(): void}): {
    parse(raw: string): URL;
    mergeSearchParams(target: string | URL, source: URLSearchParams | string, options?: {hashRoute?: boolean; keys?: readonly string[]}): URL;
    saved(): {readerUrl?: string; shareUrl?: string; returnScroll?: unknown} | null;
    prepare(raw: string, returnUrl: string): URL;
    remember(url: URL, returnScroll: object, replace?: boolean): void;
    mount(url: URL): HTMLIFrameElement;
    unmount(keepSpeech?: boolean): HTMLElement | null;
    dismiss(): void;
    replace(raw: string, returnScroll: object): HTMLIFrameElement;
    accepts(event: MessageEvent): boolean;
    persistProgress(progress: object): void;
    readonly returnFocus: HTMLElement | null;
  };
}
declare var VoiceOfMLSearchSession: SearchSessionApi;
declare var VoiceOfMLDownloadController: DownloadControllerApi;
declare var VoiceOfMLReaderNavigation: SearchReaderNavigationApi;

// The imported module registers this custom element; it does not export the
// book to our code. The concrete sections are provided by the chosen engine.
interface FoliateViewElement extends HTMLElement {
  open(file: File): Promise<void>;
  book: { sections: Array<{linear?: string}> };
}
interface HTMLElementTagNameMap { "foliate-view": FoliateViewElement }
declare var DOMPurify: {
  sanitize(input: string, options: {RETURN_DOM_FRAGMENT: true; [key: string]: unknown}): DocumentFragment;
  sanitize(input: string, options?: object): string;
  addHook(name: string, callback: (...args: any[]) => void): void;
  removeHook(name: string, callback?: (...args: any[]) => void): void;
};
declare var marked: { parse(markdown: string): string };
declare var CCRDSpeechPlan: {
  safe(text: string, offset: number): number;
  sentence(text: string, offset: number): {start: number; end: number};
  batch(text: string, offset: number, first?: boolean, carry?: number): any;
  phraseEnds(text: string, first?: boolean, carry?: number): number[];
  wordEnds(text: string): {end: number; word: string}[];
  wordStart(text: string, offset: number): number;
  clauseStart(text: string, offset: number): number;
  numberSpans(text: string): {start: number; end: number}[];
  partIndex(...args: any[]): number;
  previousSentence(...args: any[]): number;
};
declare function openPreview(id: string, query: string, options: {scroll: boolean}): Promise<unknown>;
declare function showToast(message: string): void;

interface Math { sumPrecise(values: Iterable<number>): number }
interface Window {
  VoiceOfMLReader: ReaderContractApi;
  VoiceOfMLReaderResources: ReaderResourcesApi;
  VoiceOfMLReaderSecurity: ReaderSecurityApi;
  VoiceOfMLReaderStore: ReaderStoreApi;
  VoiceOfMLReaderRequests: ReaderRequestManagerApi;
  VoiceOfMLReaderRuntime: ReaderRuntimeApi;
  VoiceOfMLReaderAdapters: ReaderAdaptersApi;
  VoiceOfMLReaderScroll: ReaderScrollApi;
  VoiceOfMLReaderChapters: ReaderChaptersApi;
  VoiceOfMLReaderVirtual: ReaderVirtualApi;
  VoiceOfMLSearchSession: SearchSessionApi;
  VoiceOfMLDownloadController: DownloadControllerApi;
  VoiceOfMLReaderNavigation: SearchReaderNavigationApi;
  __VOICE_PDF_PRELOAD__?: any;
  __VOICE_READER_CHAPTER_PRELOAD__?: any;
  __VOICE_READER_RESOLVE__?: any;
  __VOICE_READER_EARLY_BACK__?: () => boolean;
  VoiceOfMLReaderPdfDiagnostics?: any;
  fetchFile?: any;
  RufflePlayer?: any;
  CCRDSpeech: any;
}

interface Navigator {
  readonly connection?: { readonly saveData?: boolean; readonly effectiveType?: string; readonly downlink?: number; readonly rtt?: number };
  readonly deviceMemory?: number;
}
