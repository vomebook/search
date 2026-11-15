import type { Resource, DatasetPrimary } from './reader-v3-strict';
import type { PdfPage as TextPdfPage } from './reader-pdf-text-runtime-strict';

export type PdfPriority = boolean | number;
export interface PdfShell extends HTMLElement {
  querySelector(selectors: '.reader-page-state'): HTMLElement | null;
  querySelector<K extends keyof HTMLElementTagNameMap>(selectors: K): HTMLElementTagNameMap[K] | null;
  querySelector<E extends Element = Element>(selectors: string): E | null;
  _backgroundRender?: Promise<void>;
  _renderPromise?: Promise<void>;
  _renderCancel?: () => void;
  _renderStarted?: boolean;
  _renderActivePriority?: string;
  _pdfRenderCancelled?: boolean;
  _resumePdfDemand?: boolean;
  _pdfRenderNeedsRequeue?: boolean;
  _pdfRenderOwnsSlot?: boolean;
  _pdfImageEvictedAt?: { page: number; zoom: number; direction: number; budget: number; width: number; height: number };
}
export interface PdfViewport { width: number; height: number }
export interface PdfPageManifest { pageUrl(page: number): string; pageCodec?: (page: number) => string; codec: string }
export interface PdfPage extends TextPdfPage {
  getViewport(options: { scale: number }): PdfViewport;
  render(options: { canvasContext: CanvasRenderingContext2D | null; viewport: PdfViewport; readerPriority: number; transform: number[] | null }): PdfRenderTask;
}
export interface PdfRenderTask { promise: Promise<unknown>; cancel?: () => void }
export interface PdfRendererContext {
  viewport: HTMLElement;
  content: HTMLElement;
  PDF_PREFETCH_MARGIN: number;
  readerAbortController: AbortController;
  capability: { mode?: string | null };
  pdfActiveRenders: number;
  pdfPageManifest: PdfPageManifest | null;
  pdfV3Manifest: { primary: { kind: string; resource: Resource | DatasetPrimary } } | null;
  pdfV3Map: { pages: { width: number; height: number }[] } | null;
  params: URLSearchParams;
  resolvedReaderData: { pdf_document?: string; original_extension?: string } | null;
  downloadUrl: string;
  documentState: { page: number; zoom: number; restorationReady: boolean };
  pdfScrollDirection: number;
  pdfDocument: { getPage(page: number): Promise<PdfPage>; readerRenderScaleLimit?: number; readerMaxCanvasPixels?: number } | null;
  readerRuntime: { currentGeneration(kind: string): number };
  ocrManifestUrl: string;
  imageLoader: { load(image: HTMLImageElement, url: string, signal: AbortSignal): Promise<unknown> };
  pdfShellWindow: { remember(shell: PdfShell): void } | null;
  pdfManifestPrefetchOrigin: unknown;
  pdfManifestPrefetchActive: { size: number };
  pdfManifestPrefetchTimer: number;
  pdfPagePriority(shell: PdfShell): number;
  normalizePdfPriority(priority: PdfPriority): number;
  cancelSpeculativePdfRenders(shell: PdfShell): void;
  promotePdfRenderWaiter(shell: PdfShell): void;
  prioritizePdfManifestPrefetch(url: string): void;
  renderPdfImageShell(shell: PdfShell, force?: boolean, priority?: PdfPriority): Promise<void>;
  renderPdfShell(shell: PdfShell, force?: boolean, priority?: PdfPriority): Promise<void>;
  waitForReader(ms: number): Promise<unknown>;
  renderPdfInBackground(shell: PdfShell, force?: boolean, priority?: PdfPriority): Promise<void> | undefined;
  setPdfPageLoadingState(state: HTMLElement, page: string | number | undefined): void;
  isPdfPageVisible(shell: PdfShell): boolean;
  v3ResourceUrl(resource: Resource | DatasetPrimary): string;
  normalizeSourceUrl(url: string): string;
  validSource(url: string): boolean;
  awaitReader<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
  pdfPixelBudget(): number;
  measurePdf<T>(promise: Promise<T>, kind: string, page: number): Promise<T>;
  acquirePdfPreviewSlot(priority: PdfPriority, shell: PdfShell, signal: AbortSignal): Promise<unknown>;
  releasePdfPreviewSlot(shell: PdfShell): void;
  acquirePdfRenderSlot(priority: PdfPriority, shell: PdfShell, signal: AbortSignal): Promise<unknown>;
  releasePdfRenderSlot(): void;
  assertReaderActive(): void;
  pdfPageEntry(page: number): { page: number } | null;
  takePdfManifestPrefetch(url: string): HTMLImageElement | null;
  renderPdfOcrText(shell: PdfShell): Promise<unknown>;
  applyPdfShellGeometry(change: () => void): void;
  seedPdfPageGeometry?: (width: number, height: number) => void;
  schedulePdfManifestPrefetch(page: number): void;
  queuePdfManifestPrefetch(): void;
  trimPdfManifestImages(shell: PdfShell): void;
  scheduleMarkerSync(): void;
  readerAbortError(): Error;
  isReaderGenerationCurrent(kind: string, generation: number): boolean;
  trackReaderResource(cleanup: () => void): () => unknown;
  renderPdfText(page: PdfPage, shell: PdfShell, signal: AbortSignal): Promise<unknown>;
  trimPdfCanvases(shell: PdfShell): void;
}
