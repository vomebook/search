export interface ProgressState {
  id?: string;
  url?: string;
  page?: number;
  pageOffset?: number;
  zoom?: number;
  mediaTime?: number;
  htmlScrollTop?: number;
  scrollTop?: number;
  foliateSection?: number;
  foliateOffset?: number;
  foliateTocIndex?: number;
  chapterIndex?: number;
  chapterManifest?: string;
  chapterOffset?: number;
}
export interface FoliatePosition extends ProgressState { foliateSection: number; foliateOffset: number; foliateTocIndex: number }
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
  currentReaderUrl(): URL; captureFoliateBookmarkPosition(): FoliatePosition | null;
  captureChapterPosition(): ChapterPosition | null; extension: string;
  showDownloadFeedback(message: string, duration: number): void;
  lastSavedProgress: string; progressSaveChain: Promise<void>;
  loadingStatus: HTMLElement; navigationState: { tocEntries: { group?: boolean }[]; currentChapterIndex: number };
  progressTools: HTMLElement; capability: { mode?: string | null | undefined }; chapterManifestUrl: string | null;
  params: URLSearchParams; restorationFailed: boolean;
  readerRestorationPromise: Promise<ProgressState | null> | null; readerRestorationLoaded: boolean;
  readerRestorationEntry: ProgressState | null; awaitReader<T>(promise: Promise<T>): Promise<T>;
  waitForReader(delay?: number): Promise<void>; foliateContinuous: boolean;
  epubBook: { sections?: { linear?: string }[] } | null; bookmarkRibbon: HTMLElement;
  pageNavigationLockUntil: number; pageAtMarker(): HTMLElement | null;
  updateDocumentState(state: { page?: number; restoredEntry?: ProgressState | null }): void;
  pageInput: HTMLInputElement; updateTocCurrentMark(): void; updateProgressTools(): void;
  markerFrame: number; refreshNearbyPdfPages(): void; syncHeadingLocation(): void; scheduleSave(): void;
  beginReaderNavigation(): number; isReaderGenerationCurrent(kind: string, generation: number): boolean;
  restoreChapterPosition(entry: ProgressState, generation: number): Promise<boolean>;
  restoreProgressState(entry: ProgressState, generation: number): Promise<boolean>;
  restoreFoliateBookmarkPosition(entry: ProgressState, generation: number): Promise<boolean>;
  goToPage(page: number, generation: number): Promise<boolean>;
  consumeBookmarkHandoff(entry: ProgressState): void; reportNavigationError(error: unknown, generation: number): void;
  formatAdapters: { active: { restore(entry: ProgressState, generation: number): unknown } };
  zoomChangedByUser: boolean; setZoom(zoom: number, persist: boolean): void;
  restoreInitialPosition(entry: ProgressState | null, generation: number): Promise<void>;
  readingProgressSummary: HTMLElement; readerProgressPercent(): number; progressSeeking: boolean;
  progressRange: HTMLInputElement; progressPercent: HTMLElement; adjacentTocIndex(direction: number): number;
  chapterPrev: HTMLButtonElement; chapterNext: HTMLButtonElement; progressUndo: HTMLElement;
  previousProgressState: ProgressState | null; updateReadingProgressSummary(): void; placeReadingProgress(): void;
  trackReaderResource(cleanup: () => void): () => void; readerAbortError(): Error;
  epubSeekFrame: number; epubSeekTarget: { percent: number; generation: number } | null;
  epubSeekPromise: Promise<boolean | void>; seekFoliateProgress(percent: number, generation: number): Promise<void>;
  captureProgressState(): ProgressState | null;
  chapterManifestLoader: (((index: number) => Promise<Element | null>) & { count: number }) | null;
  navigateTocEntry(index: number, options: { closePanel: boolean }): Promise<void>;
}
