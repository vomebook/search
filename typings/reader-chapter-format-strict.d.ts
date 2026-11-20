export type Chapter = import('./reader-security-strict').ValidatedChapterManifest['chapters'][number];
export interface TocItem { title: string; chapter: number; depth: number; fragment: string }
export type ChapterManifest = import('./reader-security-strict').ValidatedChapterManifest;
export interface ChapterSearchIndex { path: string; bytes: number; sha256: string; [key: string]: unknown }
export interface TocEntry {
  label: string; chapterIndex: number; fragment: string; depth: number;
  activate(generation: number): Promise<boolean>; target?: Element | null;
}
export interface ChapterArticle extends HTMLElement { _chapterSearchHead?: Node | null }
export interface ChapterLoader {
  (index: number): Promise<ChapterArticle | null>;
  count: number;
  progressTarget(fraction: number): { chapterIndex: number; fraction: number };
  progressFraction(): number;
}
export interface ChapterFormatContext {
  chapterManifestUrl: string; sourceUrl: string; viewport: HTMLElement; content: HTMLElement; status: HTMLElement;
  capability: { mode?: string | null };
  readerRuntime: { currentGeneration(kind: string): number };
  readerAbortController: AbortController;
  chapterManifestObserver: IntersectionObserver | null;
  chapterManifestCleanup: (() => void) | null;
  chapterManifestLoader: ChapterLoader | null;
  chapterSearchConfiguration: import('./reader-chapter-search-strict').Configuration | null;
  readerRestorationEntry: import('./reader-progress-strict').ProgressState | null;
  navigationState: { tocEntries: unknown[] };
  chapterScrollAnchors: ReaderScrollAnchorManager;
  assertReaderActive(): void;
  trustedReaderAssetManifestUrl(url: string): string | null;
  trustedChapterUrl(path: string, base: string): string | null;
  trustedChapterResourceUrl(raw: string, base: string, manifestBase: string): string | null;
  trustedChapterReferenceUrl(value: string | null, base: string | null, manifestBase: string): {url: string; fragment: string} | null;
  readerContentUrl(url: string): string;
  isReaderGenerationCurrent(kind: string, generation: number): boolean;
  setToc(entries: TocEntry[]): unknown[];
  fetchReaderUrl(url: string, init: {signal: AbortSignal; priority: 'high' | 'low'}): Promise<Response>;
  parseChapterDocument(text: string): Document;
  alignReaderDestination(anchor: Element): void;
  holdReaderDestination(anchor: Element): void;
  syncHeadingLocation(): void;
  updateProgressTools(): void;
  scheduleSave(): void;
  beginReaderNavigation(): number;
  reportNavigationError(error: unknown, generation: number): void;
  trackReaderResource(cleanup: () => void): unknown;
  getInitialReaderRestoration(): Promise<unknown>;
  awaitReader<T>(promise: Promise<T>): Promise<T>;
  markReaderContentReady(): void;
}
