declare namespace ReaderPdfSearch {
  interface ResourceGlobals { VoiceOfMLReaderResources: { vendors: { pdf: { sha256: string } } } }
  type Resource = import('./reader-v3-strict').Resource;
  interface Manifest { source_sha256: string; page_count: number; text_layer?: unknown; book_text?: { path: string; bytes: number; sha256: string } }
  interface Index { book_text: Resource; generation: string; search_partitions?: { start: number; end: number; resource: Resource }[] }
  interface Repository {
    textIndex(ref: Resource): Promise<Index>;
  }
  interface Snippet { text: string; matchStart: number; matchLength: number; prefix: string; suffix: string }
  interface Box { box: number[]; block?: unknown; precision?: string }
  interface Hit { page: number; start: number; length: number; boxes: Box[]; snippet: Snippet; textGeneration?: string }
  interface Result { location: string; snippet: Snippet; activate(generation: number): Promise<boolean> }
  interface Page<T = Result> { total: number; offset: number; pageSize: number; results: T[] }
  interface Progress extends Page<Hit> { scanned: number; pages: number }
  interface Client {
    failed: boolean; dispose(): void; cancel(): void; prefetch(): Promise<unknown>;
    search(query: string, progress: (page: Progress) => void): Promise<Page<Hit>>;
    page(offset: number): Promise<Page<Hit>>;
  }
  interface Configuration { url: string; sha256: string; bytes: number; pageCount: number; sourceSha: string; generation?: string; partitions?: { start: number; end: number; url: string; bytes: number; sha256: string }[] }
  interface Module { createPdfBookSearch(options: Configuration): Client }
  interface Store { readonly stats: {hits: number; misses: number; writes: number; skipped: number}; dispose(): void; get(page: number): Promise<string | null>; put(page: number, text: string): Promise<unknown> }
  interface StoreModule {
    pdfTextStoreKey(identity: { source: string; version: string; pageCount: number; engine: string }): Promise<string | null>;
    createPdfTextStore(key: string, options: { signal: AbortSignal }): Store;
  }
  interface PdfPage { getTextContent(options?: unknown): Promise<unknown> }
  interface PdfDocument { numPages: number; _pdfInfo?: { readerPageCountPending?: boolean }; readerNoSearchableText?: boolean; getPage(page: number): Promise<PdfPage> }
  interface Group { page: number; count: number; checkpoints?: { ordinal: number; start: number }[]; checkpointText?: string }
  interface Context {
    pdfTextLayerRepository: Repository | null; createPdfV3Repository(source: string, pages: number): Repository;
    v3ResourceUrl(resource: Resource): string; pdfBookSearchModulePromise: Promise<Module> | null;
    assertReaderActive(): void; pdfBookSearchClient: Client | null; pdfOcrSource(): { assetUrl(path: string): string } | null;
    documentState: { pageCount: number }; readerAbortController: AbortController; pdfBookSearchPrefetchPromise: Promise<void> | null;
    ocrManifestUrl: string | null; capability: { mode?: string | null | undefined }; PDF_BOOK_SEARCH_PREFETCH_MAX_BYTES: number;
    loadPdfOcrManifest(): Promise<Manifest | null>; ensurePdfBookSearchClient(manifest: Manifest): Promise<Client>;
    pdfBookSearchPrefetchTimer: ReturnType<typeof setTimeout> | 0; PDF_BOOK_SEARCH_PREFETCH_DELAY: number; prefetchPdfBookSearch(): Promise<void>;
    goToPage(page: number, generation: number): Promise<boolean>; isReaderGenerationCurrent(kind: "search" | "navigation", generation: number): boolean;
    content: HTMLElement; pdfV3Manifest: Manifest | null;
    loadPdfOcrPage(page: number, priority?: RequestPriority, retry?: boolean): Promise<import('./reader-pdf-text-runtime-strict').OcrPayload>;
    renderPdfOcrText(shell: Element, loaded?: import('./reader-pdf-text-runtime-strict').OcrPayload): Promise<unknown>;
    renderPdfText(page: PdfPage, shell: Element): Promise<unknown>;
    clearFullSearchMarks(): void;
    viewport: HTMLElement; bookmarkRibbon: HTMLElement; readerPageScrollTop(shell: Element): number;
    fullSearchSession: ReaderSearchController.State;
    updateSearchState(patch: { results: Result[] }): unknown; renderFullSearchResults(): void; fullSearchStatus: HTMLElement;
    pdfDocument: PdfDocument | null; readerRuntime: { currentGeneration(kind: "search"): number };
    fullSearchPageOffset(total: number, offset: number, size: number): number; loadPdfSearchText(pdf: PdfDocument, page: number, generation: number): Promise<string>;
    waitForReader(delay?: number, force?: boolean): Promise<unknown>; fullSearchSnippet(text: string, start: number, length: number): Snippet;
    makePdfSearchPageLoader(groups: Group[], total: number, pattern: RegExp, firstPage: Result[]): (offset: number, generation?: number) => Promise<Page>;
    pdfFetchPolicy: { identity?: string | null } | null; pdfPersistentTextVersion: string | null; pdfPersistentTextStore: Store | null; pdfPersistentTextOpening: Promise<Store | null> | null;
    awaitReader<T>(promise: Promise<T>): Promise<T>; sourceUrl: string; PDF_SEARCH_TEXT_CACHE_BYTES: number; pdfSearchTextCache: Map<number, string>; pdfSearchTextCacheBytes: number;
    getPdfPersistentTextStore(pdf: PdfDocument): Promise<Store | null>; readerAbortError(): Error; cachePdfSearchText(page: number, text: string): void;
    loadPdfTextContent(page: number, pdfPage: PdfPage, generation: number): Promise<{ items: unknown[] }>;
    pdfTextContent(items: unknown[]): string; normalizePdfSearchText(text: string): string; fullSearchEscape(text: string): string;
    highlightPdfText(shell: Element | null, query?: string, selected?: {start: number; value: string}): HTMLElement | undefined;
    publishPdfSearchProgress(generation: number, groups: Group[], total: number, pattern: RegExp, firstPage: Result[], scanned: number, pages: number): boolean;
    syncCapabilityControls(): void;
  }
}
interface Navigator { readonly connection?: { readonly saveData?: boolean; readonly effectiveType?: string; readonly downlink?: number; readonly rtt?: number } }
declare module "*/reader-pdf-book-search.mjs" { export const createPdfBookSearch: ReaderPdfSearch.Module["createPdfBookSearch"]; }
declare module "*/reader-pdf-text-store.mjs" {
  export const pdfTextStoreKey: ReaderPdfSearch.StoreModule["pdfTextStoreKey"];
  export const createPdfTextStore: ReaderPdfSearch.StoreModule["createPdfTextStore"];
}
