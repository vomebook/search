// The storage entries are produced by the reader's source-resolution cache.
export interface StoredSource { url?: string; chapter_manifest?: string }
export interface OpeningPreload {
  manifestUrl: string;
  manifest: Promise<Response>;
  dispose(): void;
}
export interface ContractRoot {
  __VOICE_PDF_PRELOAD__?: OpeningPreload;
  __VOICE_READER_CHAPTER_PRELOAD__?: OpeningPreload;
  VoiceOfMLReaderSecurity?: {
    LIMITS: { manifestBytes: number };
    readBytes(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>>;
  };
  VoiceOfMLReader?: unknown;
  addEventListener?: Window['addEventListener'];
  removeEventListener?: Window['removeEventListener'];
}
export interface PageSource {
  root: string;
  assetUrl(relativePath: string): string;
  pageUrl?: (page: number, format?: 'webp' | 'avif') => string;
}
export interface Asset {
  s?: number; m?: string; p?: string; o?: string; b?: string; ob?: string;
  om?: string; c?: string; cb?: string; pd?: unknown; pdb?: string;
}
export interface ReaderFeatures {
  toc: boolean; search: boolean; zoom: boolean; bookmarks: boolean; pagination: boolean; media: boolean;
}
export interface ReaderContract {
  ReaderMode: Readonly<{ UNSUPPORTED: 0; ORIGINAL: 1; CONVERTED: 2; PENDING: 3; FAILED: 4 }>;
  articleExtensions: readonly string[];
  capability(extension: string | null | undefined): { extension: string; mode: string | null; readerMode: number; article: boolean; features: Readonly<ReaderFeatures> };
  features: Readonly<Record<string, ReaderFeatures>>;
  clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number;
  assetFields(asset: Asset | null | undefined, bucketBase: string, originalExtension?: string): AssetFields | null;
  isBucketPath(path: string, versioned?: boolean, bucket?: string): boolean;
  pdfPageSource(raw: string, base: string, bucketOrigin: string, filename?: string, bucketName?: string): PageSource | null;
  imagePageSource(raw: string, base: string, bucketOrigin: string): PageSource | null;
  canonicalSourceUrl(value: string): string;
  shortSourceId(value: string): string;
  readerUrl(record: ReaderRecord | null | undefined, basePath?: string): string;
}
export interface AssetFields {
  ReaderLink?: string; ReaderExtension?: string; ReaderChapterManifest?: string;
  ReaderOcrManifest?: string; ReaderOcrMode?: string; ReaderPdfDocument?: string;
}
export interface ReaderRecord {
  ReaderLink?: string; readerLink?: string; Link?: string; link?: string;
  ReaderExtension?: string; readerExtension?: string; Extension?: string; extension?: string;
  DownloadLink?: string; downloadLink?: string; File?: string; name?: string;
  ReaderOcrManifest?: string; readerOcrManifest?: string; ReaderPdfDocument?: string;
  ReaderChapterManifest?: string; readerChapterManifest?: string; ChapterManifest?: string; chapterManifest?: string;
  ReturnUrl?: string; returnUrl?: string; Repo?: string; repo?: string;
  Folder?: string[]; folder?: string[]; FolderUrl?: string; folderUrl?: string;
}
