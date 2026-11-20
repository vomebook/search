// Candidate shapes for untrusted JSON. These describe fields inspected by the
// validators, not a guarantee that every optional or extra field is valid.
export interface ChapterCandidate {
  index: number;
  path: string;
  bytes?: number | string | null;
  size?: number | string | null;
}
export interface ChapterManifestCandidate {
  version: number;
  kind: string;
  chapters: ChapterCandidate[];
  toc?: { title: string; chapter: number; depth: number; fragment: string }[];
  search_index?: { text_profile?: string } | null;
}
export interface PdfImageCandidate { sha256: string; bytes: number; codec: string }
export interface PdfOcrReferenceCandidate {
  p: number; o: string; os: string; ob: number;
  w?: string; j?: string; r?: string; rbucket?: string; rs?: string; rb: number;
}
export interface PdfPageManifestCandidate {
  version: number; kind: string; page_count: number; pages?: unknown;
  codec: string; images: PdfImageCandidate[]; source_format: string; source_sha256: string;
  toc?: { title: string; page: number; depth: number }[];
  ocr?: PdfOcrReferenceCandidate[];
}
export interface PdfOcrManifestCandidate {
  version: number; kind: string; complete: boolean; source_sha256: string;
  profile: unknown; page_count: number; pages: PdfOcrReferenceCandidate[]; source_format: string;
  book_text: { path: string; sha256: string; bytes: number };
  page_manifest?: { path: string } | null;
}
export interface PdfOcrPageCandidate {
  version: number; kind: string; page: number; width: number; height: number;
  blocks: { t: string; b: [number, number, number, number] }[];
}
// Only fields established on every successful path are exposed as concrete types.
// Other properties may be present, but have not necessarily been validated.
export interface ValidatedChapterManifest {
  version: 1; kind: "epub-chapters";
  chapters: { index: number; path: string; bytes?: unknown; size?: unknown }[];
  toc?: { title: string; chapter: number; depth: number; fragment: string }[];
  search_index?: unknown;
}
export interface ValidatedPdfPageManifest {
  version: 2; kind: "pdf-pages"; page_count: number; pages?: undefined;
  codec?: "webp" | "jxl" | "png" | "mixed";
  images?: unknown; source_format?: unknown; source_sha256?: unknown;
  toc?: { title: string; page: number; depth: number }[];
  ocr?: { p: number; o: string; os: string; ob: number; [key: string]: unknown }[];
}
export interface ValidatedPdfOcrManifest {
  version: 1; kind: "pdf-ocr"; complete: true; source_sha256: string;
  profile: unknown; page_count: number; source_format?: unknown;
  pages: { p: number; o: string; w?: string; j?: string; r?: string; [key: string]: unknown }[];
  book_text: { path: string; sha256: string; bytes: number; [key: string]: unknown };
  page_manifest?: { path: string; [key: string]: unknown };
}
export interface ValidatedPdfOcrPage {
  version: 1; kind: "pdf-ocr-page"; page: number; width: number; height: number;
  // Array.prototype.some skips holes; a non-JSON caller can supply a sparse box.
  blocks: { t: string; b: unknown[] }[];
}
export interface ByteBudget {
  reserve(bytes: number): void;
  release(bytes: number): void;
  readonly used: number;
  readonly remaining: number;
}
export interface SecurityApi {
  validateChapterManifest(input: unknown): ValidatedChapterManifest;
  validatePdfPageManifest(input: unknown): ValidatedPdfPageManifest;
  validatePdfOcrManifest(input: unknown): ValidatedPdfOcrManifest;
  validatePdfOcrPage(input: unknown, pageNumber: number): ValidatedPdfOcrPage;
}
export interface SecurityRoot { VoiceOfMLReaderSecurity?: SecurityApi }
