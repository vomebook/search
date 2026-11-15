export type Chapter = import('./reader-security-strict').ValidatedChapterManifest['chapters'][number];
export interface TocItem { title: string; chapter: number; depth: number; fragment: string }
export type ChapterManifest = import('./reader-security-strict').ValidatedChapterManifest;
export interface ChapterSearchIndex { path: string; bytes: number; sha256: string; [key: string]: unknown }
export interface TocEntry {
  label: string; chapterIndex: number; fragment: string; depth: number;
  activate(generation: number): Promise<boolean>; target?: Element | null;
}
export interface ChapterPosition { chapterIndex: number; chapterManifest: string; chapterOffset: number }
export type ChapterLoader = ((index: number) => Promise<Element | null>) & { count: number };
export interface ChapterFormatContext {
  chapterManifestUrl: string; sourceUrl: string; viewport: HTMLElement; content: HTMLElement; status: HTMLElement;
  capability: { mode?: string | null };
  readerRuntime: { currentGeneration(kind: string): number };
  readerAbortController: AbortController;
  chapterManifestObserver: IntersectionObserver | null;
  chapterManifestCleanup: (() => void) | null;
  chapterManifestLoader: ChapterLoader | null;
  chapterSearchConfiguration: { chapters: Chapter[]; index: ChapterSearchIndex & {url: string} } | null;
  readerRestorationEntry: ChapterPosition | null;
  navigationState: { tocEntries: unknown[] };
  foliateScrollAnchors: ReaderScrollAnchorManager;
  assertReaderActive(): void;
  trustedReaderAssetManifestUrl(url: string): string | null;
  trustedChapterUrl(path: string, base: string): string | null;
  trustedChapterResourceUrl(value: string, base: string, attribute: string, manifestBase: string): string | null;
  trustedChapterReferenceUrl(value: string | null, base: string | null, manifestBase: string): {url: string; fragment: string} | null;
  readerContentUrl(url: string): string;
  isReaderGenerationCurrent(kind: string, generation: number): boolean;
  setToc(entries: TocEntry[]): void;
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
  markReaderContentReady(): void;
}
