export interface PdfRange { begin: number; end: number }
export interface PdfDocument {
  _pdfInfo?: { readerPageCountPending?: boolean };
  _transport: { messageHandler: { on(name: string, callback: (range: PdfRange) => void): void } };
}
export interface PdfTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void> | void;
  prioritizeRange?: (range: PdfRange) => void;
}
export interface PdfWorker {
  promise: Promise<unknown>;
  port: Worker | null;
  readerFirstPageWorker?: boolean;
  destroy(): void;
}
export interface PdfModule {
  GlobalWorkerOptions: { workerSrc: string };
  PDFWorker: new () => PdfWorker;
  PDFDataRangeTransport?: unknown;
}
export interface PdfOptions {
  url: string; worker: PdfWorker | null; rangeChunkSize: number;
  disableAutoFetch: boolean; disableStream: boolean; wasmUrl: string; cMapUrl: string;
  cMapPacked: boolean; standardFontDataUrl: string; withCredentials: boolean;
}
export interface InitialRange {
  complete: boolean; bytes: Uint8Array; total: number; rangeChunkSize: number;
  etag?: string; cancelInitial?: (reason?: unknown) => void;
}
export type Initial = Promise<InitialRange | null> | null;
export interface Restoration { page?: number | string; pageOffset?: number | string; id?: string }
export interface RangeHooks {
  signal: AbortSignal; readBytes: typeof VoiceOfMLReaderSecurity.readBytes; limit: number; rangeLimit: number;
  canPrefetchFirstPage(): boolean;
}
export interface EngineContext {
  assertReaderActive(): void; readerAbortError(): Error; trackReaderResource(destroy: () => void): () => void;
  readerAbortController: AbortController; READER_PROXY_TIMEOUT_MS: number;
  sourceUrl: string; contentUrl: string; PDFJS_WORKER_URL: string; PDFJS_URL: string;
  PDFJS_WASM_URL: string; PDFJS_CMAP_URL: string; PDFJS_STANDARD_FONT_URL: string;
  capability: { mode?: string | null }; extension: string; ocrManifestUrl: string | null; pdfV3Manifest: unknown;
  readerRestorationLoaded: boolean; restorationFailed: boolean; readerRestorationEntry: Restoration | null;
  readerRestorationPromise: Promise<Restoration | null> | null;
  readerRuntime: { currentGeneration(kind: string): number } | null;
  pdfFetchPolicy: { prioritizeRange?(begin: number, end: number, url: string): void; add(urls: string[]): void; dispose(): void } | null;
  pdfWorker: PdfWorker | null; releasePdfWorker: (() => void) | null; pdfEnginePreload: Promise<PdfModule> | null;
  openPdfRangeTask(pdfjs: PdfModule, options: PdfOptions, hooks: RangeHooks & { initial: Initial; boundedMetadata: boolean; ratePriority(begin: number, end: number): void; canPrefetchOpening(): boolean; onError(error: unknown): void }): Promise<PdfTask>;
  preparePdfInitialRange(options: {url: string; rangeChunkSize: number}, hooks: RangeHooks): Promise<InitialRange | null>;
  retryReaderProxy<T>(callback: () => Promise<T>): Promise<T>; retryableReaderProxyError(error: unknown): boolean;
  loadPdfTaskWithTimeout(pdfjs: PdfModule, options: (url: string) => PdfOptions, url: string, initial?: Initial): Promise<PdfDocument>;
  loadPdfWithTimeout(pdfjs: PdfModule, options: (url: string) => PdfOptions, target?: string, proxy?: string, takeInitial?: (url: string) => Initial): Promise<PdfDocument>;
  preloadPdfEngine(): Promise<PdfModule>; loadPdfEngine(): Promise<PdfModule>;
  preparePdfWorker(pdfjs: PdfModule, firstPage?: boolean, signal?: AbortSignal | null): Promise<PdfModule>;
  preparePdfWorkerAttempt(pdfjs: PdfModule, attempt: number, firstPage?: boolean, signal?: AbortSignal | null): Promise<PdfModule>;
  awaitReader<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T>; waitForReader(ms: number): Promise<void>;
  pdfPrimarySource(): string; readerContentUrl(target: string): string;
  createPdfFetchPolicy(): NonNullable<EngineContext['pdfFetchPolicy']>;
  isFirstPageCandidate(bytes: Uint8Array, total: number, chunkSize: number): boolean;
  measurePdf<T>(promise: Promise<T>, label: string): Promise<T>;
  saveProgress(): void; fail(message: string, code: string): void;
}
