import type { Resource, DatasetPrimary } from './reader-v3-strict';
export type { Resource } from './reader-v3-strict';
export type V3Resource = Resource | DatasetPrimary;
export interface OcrSource { assetUrl(path: string): string }
export type OcrManifest = (import('./reader-security-strict').ValidatedPdfOcrManifest & { text_layer?: unknown }) | { page_count: number; source_sha256: string; text_layer: Resource; pages?: never };
export interface OcrPage { kind: 'pdf-ocr-page'; blocks: {t: string; b?: number[]}[]; layout?: unknown }
export type TextLayer = import('./reader-v3-strict').TextLayer;
export type OcrPayload = OcrPage | TextLayer;
export interface TextItem { str?: string; transform?: number[] }
export interface TextContent { items: TextItem[]; styles: Record<string, object>; readerTextZones?: {text: string; start: number; end: number; box: number[]}[] }
export interface PdfPage { readerDjvuText?: boolean; getTextContent(options?: {signal: AbortSignal}): Promise<TextContent>; getViewport(options: {scale: number}): {height: number; convertToViewportPoint?: (x: number, y: number) => number[]} }
export interface PdfDocument { numPages: number; _pdfInfo?: {readerPageCountPending?: boolean}; readerNativeTextEvidence?: {count: number; pages: Set<number>; hasText: boolean}; readerNoSearchableText?: boolean }
export interface Shell extends HTMLElement { _ocrPromise?: Promise<void>; _textEpoch?: number; _bookmarkTextItems?: {text: string | undefined; y: number}[] }
export interface Request { demanded: boolean; generation: number | null; page: number; controller: AbortController | null }
export type TextTask = Promise<TextContent> & {request: Request};
export interface Repository { read(ref: Resource): Promise<unknown>; dispose(): void; textIndex(ref: Resource): Promise<import('./reader-v3-strict').TextIndex>; textPage(ref: Resource, page: number): Promise<import('./reader-v3-strict').TextLayer> }
export interface Context {
  ocrManifestUrl: string; readerAbortController: AbortController; documentState: {pageCount: number; zoom: number};
  pdfOcrManifest: OcrManifest | null; pdfOcrManifestPromise: Promise<OcrManifest> | null;
  pdfOcrPagePromises: Map<number, Promise<OcrPayload>>; pdfTextLayerRepository: Repository | null;
  pdfV3Map: {pages: {width: number; height: number}[]} | null;
  pdfDocument: PdfDocument | null; capability: {mode?: string | null} | null;
  fullSearchController: {resetAvailability(): void; state: {highlightsEnabled: boolean}}; syncCapabilityControls(): void;
  PDF_TEXT_CONTENT_CACHE_BYTES: number; pdfTextContentCacheBytes: number; pdfTextContentCache: Map<number, {content: TextContent; bytes: number}>;
  PDF_OCR_PAGE_CACHE_BYTES: number; pdfOcrPageCacheBytes: number; pdfOcrPageCache: Map<number, {payload: OcrPayload; bytes: number}>;
  pdfTextContentPromises: Map<number, TextTask>; searchState: {query: string};
  datasetPrimaryUrl(ref: DatasetPrimary): string; validateResource(ref: Resource): void; readerDownloadApiUrl(url: string): string;
  createV3Repository(options: {sourceSha: string; pageCount: number; signal: AbortSignal; resourceUrl(ref: Resource): string; readJson(url: string, ref: Resource): Promise<unknown>}): Repository;
  v3ResourceUrl(ref: V3Resource): string; fetchReaderUrl(url: string, options?: RequestInit): Promise<Response>;
  readPdfOcrJson(url: string, limit?: number, digest?: string, size?: number, priority?: RequestPriority): Promise<unknown>;
  pdfOcrSource(): OcrSource | null; assertReaderActive(): void;
  loadPdfOcrManifest(): Promise<OcrManifest | null>; createPdfV3Repository(sourceSha: string, pageCount: number): Repository;
  loadPdfOcrPage(page: number, priority?: RequestPriority, retry?: boolean): Promise<OcrPayload>; cachePdfOcrPage(page: number, payload: OcrPayload): void; cachedPdfOcrPage(page: number): OcrPayload | null;
  estimatePdfTextContentBytes(content: TextContent): number; cachePdfTextContent(page: number, content: TextContent): void; cachedPdfTextContent(page: number): TextContent | null;
  estimatePdfOcrPageBytes(payload: OcrPayload): number; drainPdfTextWaiters(): void;
  acquirePdfTextSlot(demanded: boolean, request?: Request): Promise<boolean>; releasePdfTextSlot(background?: boolean): void;
  isReaderGenerationCurrent(kind: string, generation: number | null): boolean; readerAbortError(): Error; awaitReader<T>(promise: Promise<T>): Promise<T>;
  pdfSelectionIntersects?(shell: Shell): boolean; isPdfPageVisible(shell: Shell): boolean;
  populateIndependentTextLayer(layer: Element, payload: {text: string; regions: {text: string}[]}): void;
  populateOcrTextLayer(layer: Element, blocks: OcrPage['blocks'], layout?: unknown): void;
  highlightPdfText(shell: Shell): HTMLElement | undefined; renderPdfOcrText(shell: Shell, loaded?: OcrPayload): Promise<void>;
  loadPdfTextContent(page: number, pdfPage: PdfPage, generation?: number | null): Promise<TextContent>;
  pdfTextContent(items: TextItem[]): string; populatePdfTextLayer(layer: Element, items: TextItem[], viewport: ReturnType<PdfPage['getViewport']>, styles: TextContent['styles']): void;
  pdfSearchText(raw: string): {text: string; offsets: Uint32Array | null}; fullSearchEscape(query: string): string; normalizePdfSearchText(query: string): string;
  pdfSourceOffset(mapping: {text: string; offsets: Uint32Array | null}, index: number): number;
  highlightTextParts(parts: {node: Text; start: number; end: number}[]): HTMLElement[];
}
