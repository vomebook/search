// Runtime classic-script interfaces. Their implementations live in
// static/reader-resources.js and static/reader/core, loaded by reader.html.
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
  txtRelativePath(path: string): string;
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
interface ReaderRequestManagerApi { createReaderRequestManager(options?: object): any }
interface ReaderRuntimeApi { createReaderRuntime(): any }
interface ReaderAdaptersApi { createAdapterRegistry(): any }
interface ReaderScrollApi { createScrollAnchorManager(options: {viewport: Element; candidates: () => unknown}): any }
declare var VoiceOfMLReaderRequests: ReaderRequestManagerApi;
declare var VoiceOfMLReaderRuntime: ReaderRuntimeApi;
declare var VoiceOfMLReaderAdapters: ReaderAdaptersApi;
declare var VoiceOfMLReaderScroll: ReaderScrollApi;
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
  __VOICE_PDF_PRELOAD__?: any;
  __VOICE_READER_CHAPTER_PRELOAD__?: any;
  __VOICE_READER_RESOLVE__?: any;
  __VOICE_READER_EARLY_BACK__?: boolean;
  VoiceOfMLReaderPdfDiagnostics?: any;
  fetchFile?: any;
  RufflePlayer?: any;
  CCRDSpeech: any;
}

interface Navigator {
  readonly connection?: { readonly saveData?: boolean; readonly effectiveType?: string; readonly downlink?: number; readonly rtt?: number };
  readonly deviceMemory?: number;
}
