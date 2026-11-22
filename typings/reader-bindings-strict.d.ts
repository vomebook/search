import type { ReaderContract } from './reader-contract-strict';
import type { BookmarkSnapshot, StoredBookmark } from './reader-bookmarks-strict';
import type { ProgressState } from './reader-progress-strict';

type Disposable = { dispose(): void };
// Session storage is untrusted JSON; only its object shape is checked here.
type SourceData = Record<string, unknown>;
type Caret = { node: Node; offset: number };
export interface SelectionPointer {
  id: number; x: number; y: number; frame: number; page: Element | null;
  anchorNode: Node | null; anchorOffset: number; caret: Caret | null; endX?: number; endY?: number;
}
type Capability = ReturnType<ReaderContract['capability']>;
type Cleanup = (() => void) | { dispose?: () => void } | null | undefined;
export interface ReaderBindingsContext {
  readerRuntime: { track(value: Cleanup): unknown; cancel(id: number): void; update(domain: 'source', value: {id: string; url: string; contentUrl: string; downloadUrl: string; extension: string; metadata: SourceData | null}): unknown; events: {on(type: string, callback: (detail: unknown, type: string) => void): () => void}; negotiate(capability: Capability): Capability; currentGeneration(kind: string): number };
  readerRequestManager: Disposable;
  formatAdapters: Disposable; trackReaderResource(cleanup: () => void): unknown;
  pdfDiagnostics: { snapshot(): unknown }; pdfPageTimings: unknown[];
  readerId: string; localReaderData: SourceData | null; cachedReaderData: SourceData | null; resolvedReaderData: SourceData | null;
  extension: string; sourceUrl: string; contentUrl: string; downloadUrl: string; sourceName: string; params: URLSearchParams; capability: Capability;
  readerLifecycle: {disposed: boolean}; historySuppressed: boolean; saveTimer: number; saveDeadline: number;
  panelState: {showingAllBookmarks: boolean; editingBookmark: StoredBookmark | null}; renderHistory(): void; renderBookmarks(): Promise<unknown>;
  setReaderPhase(phase: string): unknown;
  viewport: HTMLElement; setReaderPanelOpen(open: boolean, focus?: boolean, keyboard?: boolean): void;
  loadingIndicator: HTMLElement; content: HTMLElement;
  updateDocumentState(value: {title: string; zoom: number}): void; documentState: {title: string; zoom: number; pageCount: number; page: number};
  returnUrl: string; returnNavigationToken: string; returnNeedsReload: boolean; returnHistoryKey: string | null; canReturnWithHistory: boolean;
  chapterSearchClient: Disposable | null; pdfV3Repository: Disposable | null; pdfTextLayerRepository: Disposable | null;
  pdfBookSearchClient: Disposable | null; pdfBookSearchPrefetchTimer: number; pdfBookSearchPrefetchPromise: Promise<unknown> | null;
  clearPdfManifestPrefetches(): void; pdfRenderWaiters: {reject(error: Error): void}[]; pdfTextWaiters: {reject(error: Error): void}[]; readerAbortError(): Error; nextReaderGeneration(name: string): number;
  bookmarkPopover: HTMLElement; bookmarkLabelInput: HTMLInputElement; bookmarkExcerptInput: HTMLTextAreaElement;
  bookmarksAllButton: HTMLButtonElement;
  mediaTab: HTMLButtonElement; mediaPanel: HTMLElement; openBookmarkPopover(invoker?: HTMLElement): void;
  pageInverted: boolean; pageInvertToggle: HTMLElement; applyPageInversion(persist?: boolean): void;
  readerThemeToggle: HTMLElement; readerTheme: string; applyReaderTheme(theme: string, persist?: boolean, notify?: boolean): void;
  readerPath: HTMLElement; navigateReaderFolder(event: Event): void; isReaderOverlayFrame(): boolean;
  captureProgressEntry(): (ProgressState & {closeTime?: number}) | null | undefined; lastSavedProgress: string; saveProgress(event?: Event): Promise<unknown>; clearReturnNavigation(): void; normalizeReaderReturnUrl(url: string): string;
  setZoom(value: string | number, persist?: boolean): void; zoomInput: HTMLInputElement; pageInput: HTMLInputElement; goToPage(value: string | number): Promise<boolean>;
  handleReaderKeydown(event: KeyboardEvent): void; turnViewport(direction: number): void;
  handleReaderOutsideClick(event: MouseEvent): void; headingLocationCache: Disposable | null;
  beginReaderNavigation(): number; reportNavigationError(error: unknown, generation: number): void;
  bookmarkRibbon: HTMLElement; closeBookmarkPopover(): void; pendingBookmarkSnapshot: BookmarkSnapshot | null; captureBookmarkSnapshot(): BookmarkSnapshot; currentReaderUrl(): URL; bookmarkInvoker: HTMLElement | null;
  selectPanel(panel: string | undefined): void; updatePanelState(state: {showingAllBookmarks: boolean}): void; setPanelSearchOpen(button: HTMLButtonElement, open: boolean): void; filterPanel(view: Element): void;
  progressSaveChain: Promise<unknown>; progressNotSaved(error: {name: string}): void; disposeReader(): void;
  handleReaderPositionChange(event: Event): void; notePdfScrollIntent(): void;
  installReaderTapSelectionClear(viewport: HTMLElement): void; independentTextCaret(doc: Document, x: number, y: number): Caret | null;
  pdfSelectionPointer: SelectionPointer | null; correctPdfCrossPageSelection(x: number, y: number, pointer: SelectionPointer): void; pdfSelectionBoundaryUpdate: boolean;
  updateProgressTools(): void; stopPdfManifestPrefetch(): void; queuePdfManifestPrefetch(): void;
  progressTools: HTMLElement; readingProgressSummary: HTMLElement; updateReadingProgressSummary(): void; syncTocTab(): void;
  progressSeeking: boolean; previousProgressState: ProgressState | null; captureProgressState(): ProgressState | null; isReaderGenerationCurrent(kind: string, generation: number): boolean; flushEpubSeek(): Promise<unknown>;
  progressRange: HTMLInputElement; progressPercent: HTMLElement; seekProgress(value: string, user: boolean): boolean; progressUndo: HTMLElement; restoreProgressState(state: ProgressState | null): unknown;
  chapterPrev: HTMLElement; chapterNext: HTMLElement; activateChapter(index: number): unknown; adjacentTocIndex(direction: number): number;
  pdfPersistentTextStore: Disposable | null; pdfPersistentTextOpening: Promise<unknown> | null; pdfPersistentTextVersion: string | null; pdfSearchTextCache: {clear(): void}; pdfSearchTextCacheBytes: number;
  registerReaderFormatAdapters(): void; syncCapabilityControls(): void; start(): Promise<unknown>; readerAbortController: AbortController; classifyReaderError(error: unknown): unknown; fail(message: string, code: string): void;
}
declare global {
  interface Math { sumPrecise(values: Iterable<number>): number }
}
