export interface ProgressState {
  id?: string;
  url?: string;
  page?: number;
  pageOffset?: number;
  pageOffsetFraction?: number;
  zoom?: number;
  mediaTime?: number;
  htmlScrollTop?: number;
  htmlReplySource?: string;
  htmlOpenReplies?: number[];
  scrollTop?: number;
  chapterIndex?: number;
  chapterManifest?: string;
  chapterOffset?: number;
}
export interface ChapterPosition extends ProgressState { chapterIndex: number; chapterManifest: string; chapterOffset: number }
export interface ProgressContext {
  readerLifecycle: { disposed: boolean };
  readerAbortController: AbortController;
  readerRuntime: { cancel(id: number): void; schedule(callback: () => void, delay: number): number };
  saveDeadline: number; saveTimer: number; saveProgress(event?: Event): Promise<unknown>;
  documentState: { restorationReady: boolean; pageCount: number; page: number; title: string; zoom: number };
  validSource(url: string): boolean; sourceUrl: string; historySuppressed: boolean;
  pdfDocument: { _pdfInfo?: { readerPageCountPending?: boolean } } | null;
  mediaElement: (HTMLMediaElement & { _readerSourceRetry?: boolean }) | null;
  syncCurrentPageFromMarker(): void; content: HTMLElement; viewport: HTMLElement;
  readerPageScrollTop(shell: Element): number; htmlFrame: HTMLIFrameElement | null;
  currentReaderUrl(): URL;
  captureChapterPosition(): ChapterPosition | null; extension: string;
  showDownloadFeedback(message: string, duration: number): void;
  lastSavedProgress: string; progressSaveChain: Promise<void>;
  readerContentReady: boolean; navigationState: { tocEntries: unknown[]; currentChapterIndex: number };
  progressTools: HTMLElement; capability: { mode?: string | null | undefined }; chapterManifestUrl: string | null;
  params: URLSearchParams; restorationFailed: boolean; readerHasHistory: boolean;
  readerRestorationPromise: Promise<ProgressState | null> | null; readerRestorationLoaded: boolean;
  readerRestorationEntry: ProgressState | null; awaitReader<T>(promise: Promise<T>): Promise<T>;
  waitForReader(delay?: number): Promise<void>; bookmarkRibbon: HTMLElement;
  pageNavigationLockUntil: number; pageAtMarker(): HTMLElement | null;
  updateDocumentState(state: { page?: number; restoredEntry?: ProgressState | null }): void;
  pageInput: HTMLInputElement; updateTocCurrentMark(): void; updateProgressTools(): void;
  markerFrame: number; refreshNearbyPdfPages(): void; syncHeadingLocation(): void; scheduleSave(): void;
  beginReaderNavigation(): number; isReaderGenerationCurrent(kind: string, generation: number): boolean;
  restoreChapterPosition(entry: ProgressState, generation: number, progressFraction?: number): Promise<boolean>;
  restoreProgressState(entry: ProgressState, generation: number): Promise<boolean>;
  goToPage(page: number, generation: number): Promise<boolean>;
  consumeBookmarkHandoff(entry: ProgressState): void; reportNavigationError(error: unknown, generation: number): void;
  formatAdapters: { active: { restore(entry: ProgressState, generation: number): unknown } | null };
  zoomChangedByUser: boolean; setZoom(zoom: number, persist: boolean): void;
  readingProgressSummary: HTMLElement; readerProgressPercent(): number; progressSeeking: boolean;
  progressRange: HTMLInputElement; progressPercent: HTMLElement; adjacentTocIndex(direction: number): number;
  chapterPrev: HTMLButtonElement; chapterNext: HTMLButtonElement; progressUndo: HTMLElement;
  previousProgressState: ProgressState | null; updateReadingProgressSummary(): void; placeReadingProgress(): void;
  trackReaderResource(cleanup: () => void): () => void; readerAbortError(): Error;
  epubSeekPromise: Promise<boolean | void>;
  captureProgressState(): ProgressState | null;
  chapterManifestLoader: import('./reader-chapter-format-strict').ChapterLoader | null;
  navigateTocEntry(index: number, options: { closePanel: boolean }): Promise<void>;
}
