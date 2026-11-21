// Runtime classic-script interfaces. Their implementations live in
// static/reader-resources.js and static/reader/core, loaded by reader.html.
// Classic search helpers are loaded before app.js, and composed into it in production.
declare function bytesToDisplay(bytes: number | null | undefined): {value: string; unit: "B" | "KB" | "MB" | "GB"};
declare function fmtSizeUrl(bytes: number | null | undefined): string | null;
declare function parseSizeStr(value: string | null | undefined): number | null;
declare function formatSize(bytes: number | string | null | undefined): string | object | undefined;
declare function buildRecordRelativePath(record: {File?: string; Extension?: string; Folder?: string[] | null}): string;
declare function encodeRecordPath(path: string | null | undefined): string;
declare function escapeHTML(text: unknown): string | undefined;
declare function getHighlightRegex(query: string): RegExp | null;
declare function highlightText(text: unknown, query: string | null | undefined): string | undefined;
declare var VoiceOfMLSearchValidation: {isValidSearchResponse(data: unknown, expectedPage: number, expectedPageSize: number): unknown};
interface VoiceOfMLSearchRequestBody {page: number; page_size: number; [key: string]: unknown}
interface VoiceOfMLSearchRequestEntry {
  controller: AbortController; deadline: number; nextListenerId: number;
  listeners: Map<number, {owner: AbortSignal | null; cancel: (() => void) | null}>;
  promise: Promise<unknown>; expire(): void; resume?(): void; suspended?: boolean;
}
interface VoiceOfMLSearchTransportDependencies {
  fetch(url: string, options: RequestInit): Promise<Response>;
  validate(data: unknown, page: number, size: number): unknown;
}
interface VoiceOfMLSearchTransport {
  pending: Map<string, VoiceOfMLSearchRequestEntry>;
  createRequest(key: string, url: string, body: VoiceOfMLSearchRequestBody, timeout: number): VoiceOfMLSearchRequestEntry;
  fetchPage(key: string, url: string, body: VoiceOfMLSearchRequestBody, signal: AbortSignal | null | undefined, timeout: number): Promise<unknown>;
  expire(): void;
}
declare var VoiceOfMLSearchTransport: {create(deps: VoiceOfMLSearchTransportDependencies): VoiceOfMLSearchTransport};
interface VoiceOfMLSearchPrefetchGroup extends AbortController {
  groupKey: string; active: Map<number, Promise<void>>; attempted: Set<number>;
  cacheWaits: Map<number, {controller: AbortController; urgent: boolean}>;
}
interface VoiceOfMLSearchPrefetchExpected {generation: string; total: number; query: {pageSize: number}}
interface VoiceOfMLSearchPrefetchDependencies {
  readView(): {key: string; loadedPage: number; total: number; pageSize: number; generation: string | undefined; inactive: boolean};
  getGroup(): VoiceOfMLSearchPrefetchGroup | null;
  setGroup(group: VoiceOfMLSearchPrefetchGroup): void;
  hasPage(page: number): boolean; stringify(body: VoiceOfMLSearchRequestBody): string | undefined;
  getCached(key: string): VoiceOfMLSearchWindowPageData | null;
  evictCached(key: string): void;
  readRecent(key: string, page: number, expected: VoiceOfMLSearchPrefetchExpected, wait: number, signal: AbortSignal): Promise<VoiceOfMLSearchWindowPageData | null>;
  fetchPage(key: string, url: string, body: VoiceOfMLSearchRequestBody, signal: AbortSignal): Promise<VoiceOfMLSearchWindowPageData>;
  validate(data: VoiceOfMLSearchWindowPageData, page: number, size: number, expected: VoiceOfMLSearchPrefetchExpected | null): void;
  acceptPage(page: number, data: VoiceOfMLSearchWindowPageData): void;
  scheduleReady(page: number): void; writeCached(key: string, data: VoiceOfMLSearchWindowPageData): void;
  onFailure(error: Error): void;
}
declare var VoiceOfMLSearchPrefetch: {create(deps: VoiceOfMLSearchPrefetchDependencies): {prefetch(base: string, template: VoiceOfMLSearchRequestBody): Promise<void>}};
interface VoiceOfMLWindowRequest extends Promise<VoiceOfMLSearchWindowPageData | null> {
  demanded: boolean; diskWait: AbortController;
}
interface VoiceOfMLResultWindow {
  key: string; query: VoiceOfMLSearchViewProjection; total: number; generation?: string | undefined;
  controller: AbortController; pending: Map<number, VoiceOfMLWindowRequest | Promise<VoiceOfMLSearchWindowPageData | null>>; failures: Map<number, unknown>;
  invalid?: boolean | undefined; preview?: boolean; retrying?: boolean;
  prefetched?: Map<number, VoiceOfMLSearchWindowPageData> | undefined;
  prefetchFailures?: Set<number> | undefined;
}
interface VoiceOfMLWindowRecoveryDependencies {
  fetchPage(query: VoiceOfMLSearchViewProjection, page: number, signal: AbortSignal, anchorId: string | undefined): Promise<VoiceOfMLSearchWindowPageData>;
  isRecoverable(error: unknown): boolean; isLocal(query: VoiceOfMLSearchViewProjection): boolean | number | undefined;
  wait(signal: AbortSignal, delay: number, local: boolean | number | undefined): Promise<void>;
}
interface VoiceOfMLWindowRequestDependencies {
  readRecent(key: string, page: number, expected: VoiceOfMLResultWindow, delay: number, signal: AbortSignal): Promise<VoiceOfMLSearchWindowPageData | null>;
  isCurrent(window: VoiceOfMLResultWindow): boolean;
  fetchPage(query: VoiceOfMLSearchViewProjection, page: number, signal: AbortSignal, anchorId: string | undefined, demanded: () => boolean): Promise<VoiceOfMLSearchWindowPageData>;
  validate(data: VoiceOfMLSearchWindowPageData, page: number, size: number, expected: VoiceOfMLResultWindow): void;
  scheduleRender(): void;
}
declare var VoiceOfMLResultWindowLoader: {
  waitForRecovery(signal: AbortSignal, delay: number, local: boolean | number | undefined): Promise<void>;
  fetchWithRecovery(deps: VoiceOfMLWindowRecoveryDependencies, query: VoiceOfMLSearchViewProjection, page: number, signal: AbortSignal, anchorId: string | undefined, demanded?: () => boolean): Promise<VoiceOfMLSearchWindowPageData>;
  requestPage(deps: VoiceOfMLWindowRequestDependencies, window: VoiceOfMLResultWindow, page: number, prefetch?: boolean): Promise<VoiceOfMLSearchWindowPageData | null | undefined> | undefined;
  retryFailed(window: VoiceOfMLResultWindow, current: () => boolean, load: (page: number) => Promise<boolean>, update: () => void): Promise<void>;
};
interface VoiceOfMLWindowStatusOptions {
  window: {invalid?: boolean | undefined; failures: ReadonlyMap<number, unknown>} | null;
  getHost(): HTMLElement | null; retry(): void;
}
interface VoiceOfMLWindowPlaceholderOptions {
  index: number; page: number; contentVersion: number; height: number;
  invalid: boolean | undefined; failed: boolean | undefined;
}
declare var VoiceOfMLResultWindowStatus: {
  update(options: VoiceOfMLWindowStatusOptions): void;
  createPlaceholder(options: VoiceOfMLWindowPlaceholderOptions): HTMLDivElement;
};
declare var VoiceOfMLSearchIdentity: {getResultStableId(result: unknown): string};
declare var VoiceOfMLSearchFileTypes: {orderedExtensions: string[]; fileIconMap: Record<string, string | object>};
interface VoiceOfMLFolderSelectionNode {
  path: string;
  children?: VoiceOfMLFolderSelectionNode[] | null;
  isRoot?: boolean;
  hasDirectFiles?: boolean;
  hasChildren?: boolean;
  showSelfToggle?: boolean;
}
interface VoiceOfMLFolderSelectionState {full: boolean; partial: boolean}
declare var VoiceOfMLSearchFolderSelection: {
  folderPathCovered(path: string, subtreeSet: ReadonlySet<string>): boolean;
  createFolderSelectionLookup(nodes: readonly VoiceOfMLFolderSelectionNode[] | null | undefined, subtreeSet: ReadonlySet<string>,
    selfSet: ReadonlySet<string>): Map<VoiceOfMLFolderSelectionNode, VoiceOfMLFolderSelectionState>;
  folderSelectionState(node: VoiceOfMLFolderSelectionNode | null | undefined, subtreeSet: ReadonlySet<string>, selfSet: ReadonlySet<string>,
    lookup?: Map<VoiceOfMLFolderSelectionNode, VoiceOfMLFolderSelectionState> | null): VoiceOfMLFolderSelectionState;
  applyFolderSelectionToNode(node: VoiceOfMLFolderSelectionNode, row: Pick<ParentNode, "querySelector">, subtreeSet: ReadonlySet<string>,
    selfSet: ReadonlySet<string>, lookup?: Map<VoiceOfMLFolderSelectionNode, VoiceOfMLFolderSelectionState> | null): void;
};
interface VoiceOfMLSidebarFolder {name: string; path?: string; count?: number}
interface VoiceOfMLSidebarFile {name: string; ext?: string; size?: number | string | null}
interface VoiceOfMLSidebarEntries {folders?: VoiceOfMLSidebarFolder[] | null; files?: VoiceOfMLSidebarFile[] | null}
interface VoiceOfMLSidebarPorts {
  escape(value: unknown): string | undefined;
  formatSize(value: number | string | null | undefined): string | object | undefined;
  iconType(extension: string | undefined): string | object;
  name(entry: VoiceOfMLSidebarFile): string;
  link(repo: string, path: string, entry: VoiceOfMLSidebarFile): string;
  reader(entry: VoiceOfMLSidebarFile, repo: string, path: string): string;
  icon(type: string | object): string;
}
declare var VoiceOfMLSearchSidebarRender: {
  browserMarkup(data: VoiceOfMLSidebarEntries, repo: string, path: string, surface: "pages" | "space", ports: VoiceOfMLSidebarPorts): string;
};
interface VoiceOfMLSearchViewState {
  mode: string; repoFull: string | null; query: string; filterMinSize: number | null; filterMaxSize: number | null;
  searchFolders: boolean; exact: boolean; useLocalMode?: boolean; pageSize: number;
  filterRepos: string[]; filterExtensions: string[]; filterFolderSelfs: string[]; filterFolderSubtrees: string[];
}
interface VoiceOfMLSearchViewMemo {
  key: string; scalars: (string | number | boolean | null | undefined)[]; filters: string[][];
}
interface VoiceOfMLSearchViewProjection {
  mode: string; repo: string; query: string; repos: string[]; extensions: string[];
  folders: {self: string[]; subtree: string[]}; plainFolders: []; minSize: number | null; maxSize: number | null;
  sort: string; searchFolders: boolean; exact: boolean; pageSize: number; useLocalMode?: boolean | undefined;
}
declare var VoiceOfMLSearchViewKey: {
  resolve(getSource: () => {state: VoiceOfMLSearchViewState; surface: "pages" | "space"; getSort: () => string},
    getPrevious: () => VoiceOfMLSearchViewMemo | null,
    getCompare: () => (current: readonly (string | number | boolean | null | undefined)[], saved: readonly (string | number | boolean | null | undefined)[] | null | undefined) => boolean,
    getEncoder: () => (projection: VoiceOfMLSearchViewProjection) => string): VoiceOfMLSearchViewMemo;
};
declare var VoiceOfMLSearchCanonical: {
  stableStringify(value: unknown, getVisit: () => (value: unknown) => string | undefined): string | undefined;
};
declare var VoiceOfMLSearchRecovery: {
  isRecoverable(error: {name?: string | undefined; status?: number | undefined; code?: string | undefined; message?: string | undefined} | null | undefined): boolean;
};
interface VoiceOfMLPagingView {
  generation: number; loadedPage: number; page: number; resultCount: number;
  hasMore: boolean; loading: boolean; suspended: boolean; inactive: boolean; dragging: boolean;
  scrollTop: number; loadedHeight: number; viewportHeight: number; appendScrollTop?: number | null | undefined;
}
interface VoiceOfMLPagingRecovery { failures: number; retryAt: number }
interface VoiceOfMLPagingDependencies {
  policy: typeof VoiceOfMLPagingPolicy;
  clock: {now(): number; setTimeout(callback: () => void, delay: number): number; clearTimeout(timer: number): void};
  readView(): VoiceOfMLPagingView; expireRequests(): void; append(page: number, scrollTop: number): void;
  onState(state: Readonly<VoiceOfMLPagingRecovery>): void;
}
interface VoiceOfMLPagingController {
  readRecovery(): VoiceOfMLPagingRecovery; updateStatus(): void; reset(): void;
  schedule(delay?: number, readyPage?: number): void; finish(success: boolean, terminal?: boolean): void;
  retryBottom(): void; retry(): void; maybeLoad(bottomOnly?: boolean, retry?: boolean): void; dispose(): void;
}
interface VoiceOfMLPagingStatusOptions {getHost(): HTMLElement | null | undefined; revealHost: boolean; retry(): void}
declare var VoiceOfMLPagingPolicy: {
  isAtBottom(view: VoiceOfMLPagingView): boolean; acceptsReadyPage(view: VoiceOfMLPagingView, readyPage: number): boolean;
  shouldLoad(view: VoiceOfMLPagingView, recovery: VoiceOfMLPagingRecovery, now: number, bottomOnly: boolean, retry: boolean): boolean;
  afterAttempt(failures: number, success: boolean, terminal: boolean, now: number): VoiceOfMLPagingRecovery;
};
declare var VoiceOfMLPagingController: {create(deps: VoiceOfMLPagingDependencies): VoiceOfMLPagingController};
declare var VoiceOfMLPagingStatus: {create(options: VoiceOfMLPagingStatusOptions): {render(view: VoiceOfMLPagingView, recovery: VoiceOfMLPagingRecovery): void}};
interface VoiceOfMLInputDraftOwner {href: string; key: string | undefined; cancelled: boolean}
interface VoiceOfMLInputVisitOwner {generation: number; viewKey: string | null}
interface VoiceOfMLInputState {
  timer: number | null; composing: boolean; dirty: boolean; ready: boolean;
}
interface VoiceOfMLInputElement extends EventTarget {
  value: string;
  _earlySearchInput?: {dirty: boolean; composing: boolean; owner: VoiceOfMLInputDraftOwner | null; dispose(): void};
}
interface VoiceOfMLInputDependencies {
  input: VoiceOfMLInputElement; navigation: EventTarget; ownership: typeof VoiceOfMLSearchInputOwnership;
  clock: {setTimeout(callback: () => void, delay: number): number; clearTimeout(timer: number): void};
  getHref(): string; getEntryKey(): string | undefined; getViewKey(): string | null;
  syncInput(): void; canSubmit(): boolean; submit(query: string): void; onState(state: Readonly<VoiceOfMLInputState>): void;
}
interface VoiceOfMLInputController {
  mount(): void; dispose(): void; debounce(): void; cancelTimer(): void; invalidateVisit(): void;
  captureDraft(renew?: boolean): void; cancelDraft(): void; draftIsCurrent(): boolean; finishStartup(current: boolean): void;
}
declare var VoiceOfMLSearchInputOwnership: {
  draft(href: string, key: string | undefined): VoiceOfMLInputDraftOwner;
  draftIsCurrent(owner: VoiceOfMLInputDraftOwner | null, href: string, key: string | undefined): boolean;
  visit(generation: number, viewKey: string | null): VoiceOfMLInputVisitOwner;
  visitIsCurrent(owner: VoiceOfMLInputVisitOwner, generation: number, viewKey: string | null): boolean;
};
declare var VoiceOfMLSearchInput: {create(deps: VoiceOfMLInputDependencies): VoiceOfMLInputController};
interface VoiceOfMLSearchWindowPageData {results: unknown[]; page: number; page_size: number; total: number; generation?: string | undefined}
interface VoiceOfMLSearchWindowExpected {total: number; generation?: string | undefined}
declare var VoiceOfMLSearchWindowPage: {
  validate(data: VoiceOfMLSearchWindowPageData | null | undefined, page: number, pageSize: number, expected?: VoiceOfMLSearchWindowExpected | null | undefined): void;
};
interface VoiceOfMLHeightIndexState {
  heights: readonly number[];
  heightTree: number[];
  heightsDirty: boolean;
  sparseHeights: boolean;
  heightBase: number;
  estimatedHeight?: number;
}
declare var VoiceOfMLSearchHeightIndex: {
  fenwickAdd(tree: number[], idx: number, delta: number): void;
  ensureTree(state: VoiceOfMLHeightIndexState): number[];
  extendTree(state: VoiceOfMLHeightIndexState, previousLength: number): boolean;
  totalHeight(state: VoiceOfMLHeightIndexState): number;
  offsetOf(state: VoiceOfMLHeightIndexState, index: number): number;
  indexAt(state: VoiceOfMLHeightIndexState, offset: number): number;
};
declare class BoundedResponseCache<T = unknown> extends Map<string, T> {
  constructor(limit: number, ttl: number, budget?: number);
  limit: number;
  ttl: number;
  budget: number;
  bytes: number;
  entriesInfo: Map<string, {bytes: number; time: number}>;
}

interface ReaderSecurityApi {
  readonly LIMITS: Readonly<{
    documentBytes: number; pdfDocumentBytes: number;
    manifestBytes: number; pdfPages: number; chapters: number; chapterBytes: number;
    chapterTotalBytes: number;
  }>;
  assertResponseSize(response: Response, limit: number): Response;
  createByteBudget(limit?: number): { reserve(bytes: number): void; release(bytes: number): void; readonly used: number; readonly remaining: number };
  readBytes(response: Response, limit?: number, budget?: ReturnType<ReaderSecurityApi["createByteBudget"]>): Promise<Uint8Array<ArrayBuffer>>;
  readText(response: Response, limit?: number, encoding?: string, budget?: ReturnType<ReaderSecurityApi["createByteBudget"]>): Promise<string>;
  validateChapterManifest(manifest: unknown): import("./reader-security-strict").ValidatedChapterManifest;
  validatePdfPageManifest(manifest: unknown): import("./reader-security-strict").ValidatedPdfPageManifest;
  validatePdfOcrManifest(manifest: unknown): import("./reader-security-strict").ValidatedPdfOcrManifest;
  validatePdfOcrPage(payload: unknown, pageNumber: number): import("./reader-security-strict").ValidatedPdfOcrPage;
}

interface ReaderResourcesApi {
  readonly vendors: Record<string, { readonly url: string; readonly file: string; readonly sha256: string }>;
  readonly readerFiles: readonly string[];
  readonly readerComponentFiles: readonly string[];
  vendorUrl(name: string, base: string): string;
  runtimePaths(base: string): string[];
  shellAssets(base: string): string[];
  pdfSupportAssets(base: string): string[];
  djvuDecoderAssets(base: string): string[];
  djvuSelectedAssets(base: string): string[];
  djvuSupportsSIMD(): boolean;
  ruffleAssets(base: string): string[];
  engineAssets(extension: string, base: string, workerWrapper?: string): string[];
}

interface ReaderContractApi {
  readonly ReaderMode: Readonly<Record<string, number>>;
  readonly articleExtensions: readonly string[];
  capability(extension: string | null | undefined): ReaderContractCapability;
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
type ReaderStoreApi = import("./reader-store-strict").ReaderStoreStrictApi;
declare var VoiceOfMLReaderStore: ReaderStoreApi;
interface ReaderRequestManagerOptions {
  fetchImpl?: typeof fetch;
  AbortControllerImpl?: typeof AbortController;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  initialIdleMs?: number;
}
// The manager normalizes the signal before sending a native fetch request.
type ReaderRequestInit = Omit<RequestInit, 'signal'> & { signal?: AbortSignal | null | undefined };
interface ReaderRequestManager {
  request(url: RequestInfo | URL, timeoutMs: number, requestInit?: ReaderRequestInit): Promise<Response>;
  requestBuffered(url: RequestInfo | URL, timeoutMs: number, limit: number, requestInit?: ReaderRequestInit): Promise<Response>;
  dispose(): void;
  readonly pendingCount: number;
  readonly activeCount: number;
  readonly disposed: boolean;
}
interface ReaderRequestManagerApi { createReaderRequestManager(options?: ReaderRequestManagerOptions): Readonly<ReaderRequestManager> }
interface ReaderContractCapability {
  readonly [key: string]: unknown;
  readonly extension: string; readonly mode: string | null; readonly readerMode: number; readonly article: boolean;
  readonly features: Readonly<{toc: boolean; search: boolean; zoom: boolean; bookmarks: boolean; pagination: boolean; media: boolean}>;
}
interface ReaderRuntimeCapability { mode?: string | null; features?: object; [key: string]: unknown }
interface ReaderRuntimeState {
  lifecycle: {phase: string; stage: string; disposed: boolean; errorCode: string};
  source: {id: string; url: string; contentUrl: string; downloadUrl: string; extension: string; metadata: unknown};
  document: {title: string; zoom: number; page: number; pageCount: number; restoredEntry: unknown; restorationReady: boolean};
  navigation: {tocEntries: unknown[]; currentChapterIndex: number};
  search: {query: string; results: unknown[]; index: number};
  panel: {open: boolean; selected: string; showingAllBookmarks: boolean; editingBookmark: import('./reader-store-strict').BookmarkEntry | null};
  formats: {active: unknown; pdf: Record<string, unknown>; html: Record<string, unknown>; media: Record<string, unknown>; [key: string]: unknown};
  capability: ReaderRuntimeCapability | null;
}
type ReaderRuntimeDisposable = (() => void) | {dispose?: () => void};
interface ReaderEventBus {
  on(type: string, listener: (detail: unknown, type: string) => void): () => void;
  emit(type: string, detail: unknown): void;
  dispose(): void;
  readonly disposed: boolean;
}
type ReaderRuntimeFormatSnapshot = Readonly<Record<string, unknown>>;
interface ReaderRuntimeFormatsSnapshot {
  readonly active: ReaderRuntimeFormatSnapshot;
  readonly pdf: ReaderRuntimeFormatSnapshot;
  readonly html: ReaderRuntimeFormatSnapshot;
  readonly media: ReaderRuntimeFormatSnapshot;
  readonly [key: string]: ReaderRuntimeFormatSnapshot | undefined;
}
type ReaderRuntimeUpdateDomain = Exclude<keyof ReaderRuntimeState, "capability">;
type ReaderRuntimeSnapshot = Readonly<{
  [K in Exclude<keyof ReaderRuntimeState, "formats" | "capability">]: Readonly<ReaderRuntimeState[K]>
}> & {readonly formats: ReaderRuntimeFormatsSnapshot; readonly capability: ReaderRuntimeCapability | null};
interface ReaderRuntime {
  readonly state: ReaderRuntimeState;
  readonly events: Readonly<ReaderEventBus>;
  snapshot(): ReaderRuntimeSnapshot;
  update<K extends ReaderRuntimeUpdateDomain>(domain: K, patch: Partial<ReaderRuntimeState[K]>): boolean;
  updateFormat(format: string, patch: Record<string, unknown>): boolean;
  setPhase(phase: string): boolean;
  setStage(stage: string): boolean;
  fail(code: string): void;
  nextGeneration(name: string): number;
  currentGeneration(name: string): number;
  isCurrent(name: string, value: number): boolean;
  track<T extends ReaderRuntimeDisposable | null | undefined>(disposable: T): T;
  untrack(disposable: ReaderRuntimeDisposable): void;
  schedule(callback: () => void, delay?: number): ReturnType<typeof setTimeout>;
  cancel(handle: ReturnType<typeof setTimeout>): void;
  frame(callback: () => void): number;
  cancelFrame(handle: number): void;
  negotiate(capability: ReturnType<import('./reader-contract-strict').ReaderContract['capability']>): Readonly<ReturnType<import('./reader-contract-strict').ReaderContract['capability']>>;
  negotiate<T extends ReaderRuntimeCapability>(capability: T): Readonly<T & {features: object}>;
  negotiate(capability: null | undefined): Readonly<{features: object}>;
  dispose(): void;
}
interface ReaderRuntimeApi {
  readonly FEATURE_MATRIX: Readonly<Record<string, object>>;
  createEventBus(): Readonly<ReaderEventBus>;
  createReaderRuntime(options?: {events?: Readonly<ReaderEventBus>; initialState?: Partial<ReaderRuntimeState>}): Readonly<ReaderRuntime>;
}
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
  watchTransaction(transaction: IDBTransaction): {result: Promise<boolean>; finished: Promise<void>; fail(): void};
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
    onUncertain?(filename: string, link: string): void;
    showToast(message: unknown, duration?: number): void;
    isSpeculativeAllowed?(): boolean;
    isBatchActive?(): boolean;
    timeout?: number;
  }): {
    downloadChecks: Map<string, unknown>;
    downloadCheckQueue: unknown[];
    pendingDownloads: Map<string, unknown>;
    checkDownload(link: string, speculative?: boolean, signal?: AbortSignal): Promise<unknown>;
    runDownloadCheck(item: {link: string; entry: {users: number; controller: AbortController; promise: Promise<unknown>; expires: number}; resolve(value: unknown): void}): Promise<void>;
    pumpDownloadChecks(): void;
    scheduleDownloadLaunch(filename: string, link: string, cancelled: () => boolean): Promise<boolean>;
    downloadFile(filename: string, link: string, options?: {button?: HTMLElement; quiet?: boolean; skipCheck?: boolean; batch?: {cancelled?: boolean; abortController?: AbortController}}): Promise<boolean>;
    downloadFileDetailed(filename: string, link: string, options?: {button?: HTMLElement; quiet?: boolean; skipCheck?: boolean; batch?: {cancelled?: boolean; abortController?: AbortController}}): Promise<"started" | "failed" | "uncertain" | "cancelled">;
    readonly activeDownloadChecks: number;
  };
}
interface SearchReaderNavigationApi {
  createNavigation(readerPath: string, options?: {resume?(url: string): void; close?(): void}): {
    parse(raw: string): URL;
    mergeSearchParams(target: string | URL, source: URLSearchParams | string, options?: {hashRoute?: boolean; keys?: readonly string[]}): URL;
    // JSON storage may contain any valid JSON value, not only our own record.
    saved(): unknown;
    clear(url: URL): void;
    prepare(raw: string, returnUrl: string): URL;
    remember(url: URL, returnScroll: object, replace?: boolean): void;
    searchLocation(): URL | null;
    mount(url: URL, deferTitle?: boolean): HTMLIFrameElement | null;
    unmount(keepSpeech?: boolean): HTMLElement | null;
    dismiss(): void;
    showCloseRecovery(raw: string): void;
    replace(raw: string, returnScroll: object): HTMLIFrameElement | null;
    accepts(event: MessageEvent): boolean;
    persistProgress(progress: {url?: unknown; closeTime?: unknown} | null | undefined): void;
    disposeBackground(): void;
    readonly backgroundReader: HTMLIFrameElement | null;
    readonly readerUrl: string | null;
    readonly reusedMount: boolean;
    readonly returnFocus: HTMLElement | null;
  };
}
declare var VoiceOfMLSearchSession: SearchSessionApi;
declare var VoiceOfMLDownloadController: DownloadControllerApi;
declare var VoiceOfMLReaderNavigation: SearchReaderNavigationApi;

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
  RufflePlayer?: any;
  CCRDSpeech: any;
}

interface Navigator {
  readonly connection?: { readonly saveData?: boolean; readonly effectiveType?: string; readonly downlink?: number; readonly rtt?: number };
  readonly deviceMemory?: number;
}
