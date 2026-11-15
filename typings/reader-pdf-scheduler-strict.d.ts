export interface PdfShell extends HTMLElement {
  _textEpoch?: number;
  _pdfImageEvictedAt?: { page: number; zoom: number; direction: number; budget: number; width: number; height: number };
  _bookmarkTextItems?: { text: string; y: number }[];
  _pdfRenderOwnsSlot?: boolean;
  _renderStarted?: boolean;
  _pdfRenderCancelled?: boolean;
  _pdfRenderNeedsRequeue?: boolean;
  _renderCancel?: () => void;
  _renderPromise?: Promise<unknown> | null;
  _backgroundRender?: unknown;
}
export interface PrefetchRecord { image: HTMLImageElement; url: string; timeout: number }
export interface RenderWaiter { shell: PdfShell | null; priority: number; resolve(): void; reject(error: unknown): void }
export interface PreviewWaiter { shell: PdfShell | null; priority: number; resolve(): void }
export interface TextRequest { demanded: boolean; generation: number; page: number }
export interface TextWaiter { priority: boolean; request: TextRequest | null; resolve(background: boolean): void; reject(error: unknown): void }
export interface SchedulerContext {
  documentState: { restorationReady: boolean; page: number; pageCount: number; zoom: number };
  capability: { mode?: string | null };
  viewport: HTMLElement;
  content: HTMLElement;
  pdfLastScrollTop: number; pdfScrollDirection: number;
  PDF_MANIFEST_PREFETCH_CONCURRENCY: number; PDF_MANIFEST_PREFETCH_MAX_PAGES: number; PDF_MANIFEST_PREFETCH_LIMIT: number;
  pdfManifestPrefetchActive: Set<PrefetchRecord>; pdfManifestPrefetches: Map<string, PrefetchRecord>;
  pdfManifestPrefetchTimer: number; pdfManifestPrefetchNext: number; pdfManifestPrefetchOrigin: number; pdfManifestPrefetchCount: number; pdfManifestPrefetchWrapped: boolean;
  pdfManifestShells: PdfShell[]; pdfPageManifest: { pageUrl(page: number): string } | null;
  pdfActiveRenders: number; pdfRenderWaiters: RenderWaiter[];
  pdfActiveTextLoads: number; pdfActiveSearchTextLoads: number; pdfTextWaiters: TextWaiter[];
  pdfTextContentPromises: Map<number, { request: TextRequest }>;
  readerAbortController: AbortController;
  cancelPdfManifestPrefetch(record: PrefetchRecord): void; stopPdfManifestPrefetch(): void;
  trimPdfManifestPrefetches(): void; pdfRetainedPixels(): number; pdfPixelBudget(): number;
  pdfSurfacePixels(surface: HTMLCanvasElement | HTMLImageElement): number;
  pageAtMarker(): PdfShell | null; isPdfPageVisible(shell: PdfShell | null): boolean; pdfSelectionIntersects(shell: PdfShell | null): boolean;
  setPdfPageLoadingState(state: Element, page: string | undefined): void;
  domSearch: { pruneMarks(): void };
  canPrefetchPdfImages(): boolean; pdfManifestPrefetchConcurrency(): number; pdfManifestPrefetchMaxPages(): number;
  queuePdfManifestPrefetch(delay?: number): void; trimPdfSurfaces(shell?: PdfShell | null): void;
  pdfPagePriority(shell: PdfShell | null): number; normalizePdfPriority(priority: boolean | number): number;
  readerAbortError(): Error; drainPdfTextWaiters(): void;
  isReaderGenerationCurrent(kind: string, generation: number): boolean; nextReaderGeneration(kind: string): number;
  renderPdfInBackground(shell: PdfShell, force?: boolean, priority?: number): Promise<unknown> | undefined;
}
