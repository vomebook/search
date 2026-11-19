/** Selection anchor captured before a cross-page drag. */
export interface PdfSelectionAnchor {
  anchorNode: Node | null;
  anchorOffset: number;
}
export interface WindowShell extends HTMLElement {
  _textEpoch?: number;
  _renderCancel?: () => void;
  _renderPromise?: Promise<void>;
  _pdfRenderCancelled?: boolean;
  _pdfRenderNeedsRequeue?: boolean;
  _pdfObserversPending?: boolean;
}
export interface PdfOutlineItem {
  title: string;
  dest: string | readonly unknown[] | null;
  items?: PdfOutlineItem[];
}
export interface PdfOutlineDocument {
  numPages: number;
  getOutline?: () => Promise<PdfOutlineItem[] | null>;
  getDestination?: (name: string) => Promise<readonly unknown[] | null>;
  getPageIndex(ref: object): Promise<number>;
}
export interface DjvuOutlineDocument extends Omit<PdfOutlineDocument, 'getPageIndex'> {
  getPageIndex(ref: number): Promise<number>;
}
export interface PdfOutlineEntry {
  label: string;
  depth: number;
  page?: number | null;
  activate(generation: number): Promise<boolean> | boolean;
}
export interface PdfPreviewViewport { width: number; height: number }
export interface PdfPreviewPage {
  getTextContent(): Promise<import('./reader-pdf-text-runtime-strict').TextContent>;
  getViewport(options: {scale: number}): PdfPreviewViewport;
  render(options: {canvasContext: CanvasRenderingContext2D | null; viewport: PdfPreviewViewport; transform: number[] | null; readerPriority?: number}): {promise: Promise<unknown>; cancel?: () => void};
}
export interface PdfPreviewDocument extends PdfOutlineDocument {
  isPureXfa?: boolean;
  sourceSha256?: string;
  outlineNeedsFullSource?: boolean;
  readerRenderScaleLimit?: number;
  readerMaxCanvasPixels?: number;
  readerNoSearchableText?: boolean;
  _pdfInfo?: {readerPageCountPending?: boolean; numPages: number};
  _transport?: {
    pagesMapper: {pagesNumber: number};
    messageHandler: {
      sendWithPromise(name: 'ReaderPrepareFirstPage', data: null): Promise<unknown[] | null>;
      sendWithPromise(name: 'ReaderGetPagePrefix', data: {limit: number}): Promise<unknown[]>;
      sendWithPromise(name: 'ReaderInstallPagePrefix', data: null): Promise<{refs: unknown[]}>;
      sendWithPromise(name: 'ReaderValidatePageCount', data: null): Promise<{count: number; refs: unknown[]}>;
    };
  };
  getPage(page: number): Promise<PdfPreviewPage>;
  destroy?(): Promise<void> | void;
}
export type PendingPdfDocument = PdfPreviewDocument & {
  _pdfInfo: NonNullable<PdfPreviewDocument['_pdfInfo']>;
  _transport: NonNullable<PdfPreviewDocument['_transport']>;
};
export type DirectDjvuDocument = Omit<PdfPreviewDocument, 'getPageIndex'> & DjvuOutlineDocument & {destroy(): void};
export interface PageWindowSource {
  root: string;
  codec?: string;
  pageUrl?(page: number): string;
  pageCodec?(page: number): string;
  assetUrl(path: string): string;
}
export interface PageWindowManifest extends PageWindowSource {
  pageUrl(page: number): string;
  codec: string;
  pageCount: number;
  sourceFormat?: string;
  entries?: {page: number; path: string}[];
  ocr?: {page?: number; [key: string]: unknown}[];
}
export interface PageWindowRepository {
  read(ref: import('./reader-v3-strict').Resource): Promise<unknown>;
}
export interface PageWindowHandle {
  /** Valid pages are integers in [1, total]. Outside that range the result is
   * unspecified: it may be null or throw. Throws after disposal. */
  ensure(page: number): Element | null;
  remember(shell: WindowShell): void;
  setDefaultRatio(ratio: number): void;
  schedule(): void;
  resize(): void;
  dispose(): void;
}
export interface PageWindowContext {
  capability: {mode?: string | null}; sourceUrl: string; downloadUrl: string; extension: string;
  resolvedReaderData: {original_extension?: string} | null;
  viewport: HTMLElement; content: HTMLElement; status: HTMLElement;
  pageInput: HTMLInputElement; bookmarkRibbon: HTMLButtonElement;
  PDF_PREFETCH_MARGIN: number; READER_PROXY_TIMEOUT_MS: number;
  readerAbortController: AbortController; restorationFailed: boolean;
  readerRestorationPromise: Promise<{page?: number | string; pageOffset?: number | string; id?: string} | null> | null;
  readerRuntime: {currentGeneration(kind: string): number; negotiate(capability: ReturnType<import('./reader-contract-strict').ReaderContract['capability']>): ReturnType<import('./reader-contract-strict').ReaderContract['capability']>; update(kind: string, state: {extension: string}): void};
  documentState: {page: number; pageCount: number; zoom: number};
  pdfPageManifest: PageWindowManifest | null; pdfFirstPagePreload: HTMLImageElement | null; pdfFirstPagePreloadPage: number;
  pdfV3Manifest: import('./reader-v3-strict').ReadingManifest | null;
  pdfV3Map: import('./reader-v3-strict').PageMap | null;
  pdfV3Repository: PageWindowRepository | null;
  pdfOcrManifest: unknown; pdfOcrManifestPromise: Promise<unknown> | null; ocrManifestUrl: string;
  pdfDocument: PdfPreviewDocument | DirectDjvuDocument | null; pdfManifestShells: (WindowShell | undefined)[];
  pdfShellLayoutReady: Promise<boolean> | null;
  pdfShellWindow: PageWindowHandle | null; pdfShellsReady: Promise<void>; pdfUserHasScrolled: boolean; pageNavigationLockUntil: number;
  getInitialReaderRestoration(): Promise<unknown>; initialReaderPage(total: number): number;
  pdfManifestSource(): PageWindowSource | null; preloadPdfFirstPage(total: number): Promise<void>;
  awaitReader<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T>;
  waitForReader(ms?: number, animationFrame?: boolean): Promise<void>;
  assertReaderActive(): void; readerAbortError(): Error; trackReaderResource(callback: () => void): () => void;
  independentTextCaret(document: Document, x: number, y: number): {node: Node; offset: number} | null;
  pdfSelectionIntersects(element: Element): boolean; pageAtMarker(): WindowShell | null;
  isPdfPageVisible(shell: Element | null | undefined): boolean;
  createPdfShellWindow(total: number, first: WindowShell, create: (page: number) => WindowShell, unobserve: (shell: WindowShell) => void, ratio: number, retained?: Map<number, WindowShell> | null): PageWindowHandle | null;
  appendShellsBatched(create: (page: number) => WindowShell, total: number, batch: number,
    onBatchMounted?: (endPage: number) => void): Promise<void>;
  createPdfV3Repository(sha: string, count: number): PageWindowRepository;
  validateReadingManifest(value: unknown, limit: number): import('./reader-v3-strict').ReadingManifest & {kind: 'pdf-reading'};
  validatePageMap(value: unknown, manifest: import('./reader-v3-strict').ReadingManifest): import('./reader-v3-strict').PageMap;
  v3ResourceUrl(resource: import('./reader-v3-strict').Resource | import('./reader-v3-strict').DatasetPrimary): string;
  pdfPrimarySource(): string; loadPdfDocument(url: string): Promise<PdfPreviewDocument>;
  renderPdf(pdf: PdfPreviewDocument | DirectDjvuDocument | Promise<PdfPreviewDocument | DirectDjvuDocument>): Promise<void>;
  renderPdfPages(response: Response | Promise<Response>): Promise<void>;
  loadPdfOcrPage(page: number): Promise<unknown>; loadPdfOcrManifest(): Promise<{source_sha256: string} | null>;
  updateDocumentState(state: {page?: number; pageCount?: number}): void;
  setToc(entries: PdfOutlineEntry[]): void; goToPage(page: number, generation: number): Promise<boolean> | boolean;
  syncCapabilityControls(): void; markReaderContentReady(): void; beginReaderNavigation(): void;
  isReaderGenerationCurrent(kind: string, generation: number): boolean;
  readerDownloadApiUrl(path: string): string; readerContentUrl(url: string): string;
  fetchWithReaderTimeout(url: string, timeout: number, options?: RequestInit): Promise<Response>;
  fetchReaderUrl(url: string, options: RequestInit): Promise<Response>;
  readPdfOcrJson(url: string, limit: number, sha: string, size: number, priority: RequestPriority): Promise<unknown>;
  readerPageScrollTop(shell: Element): number; scheduleMarkerSync(): void;
  renderPdfInBackground(shell: Element, force?: boolean, priority?: number | boolean): Promise<void> | undefined;
  renderPdfShell(shell: Element, force?: boolean, priority?: number | boolean): Promise<void>;
  renderPdfImageShell(shell: Element, force?: boolean, priority?: number | boolean): Promise<void>;
  renderPdfOcrText(shell: Element): Promise<unknown>; promotePdfRenderWaiter(shell: Element): void;
  pdfPagePriority(shell: Element): number; setPdfPageLoadingState(state: HTMLElement, page: number): void;
  acquirePdfRenderSlot(priority: boolean, shell: WindowShell | null, signal: AbortSignal): Promise<unknown>;
  releasePdfRenderSlot(): void; pdfOutputScale(viewport: PdfPreviewViewport): number; pdfPixelBudget(): number;
  measurePdf<T>(promise: Promise<T>, kind: string, page: number): Promise<T>;
}
export interface PdfWindowChunk {
  element: HTMLDivElement;
  start: number;
  end: number;
  mounted: boolean;
}
