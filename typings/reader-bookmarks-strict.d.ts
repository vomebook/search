import type { BookmarkEntry, ReaderStoreStrictApi } from './reader-store-strict';

declare global {
  var VoiceOfMLReaderStore: ReaderStoreStrictApi;
}
import type { ChapterPosition, FoliatePosition, ProgressState } from './reader-progress-strict';

export interface BookmarkSnapshot extends ProgressState {
  locator: string; label: string; excerpt: string; progress: number;
  page: number; pageOffset: number; scrollTop: number; htmlScrollTop: number;
}
export type StoredBookmark = BookmarkEntry;
export interface BookmarkContext {
  params: URLSearchParams; isReaderOverlayFrame(): boolean;
  capability: { mode?: string | null | undefined }; pageAtMarker(): (HTMLElement & { _bookmarkTextItems?: { y: number; text: string }[] }) | null;
  bookmarkRibbon: HTMLElement; viewport: HTMLElement; content: HTMLElement;
  excerptFromCaret(doc: Document, root: Node, x: number, y: number): string;
  foliateContinuous: boolean; foliateSectionRoot(article: Element): Element | ShadowRoot;
  readerProgressPercent(): number; navigationState: { currentChapterIndex: number };
  beginReaderNavigation(): number; isReaderGenerationCurrent(kind: string, generation: number): boolean;
  foliateSectionLoader: ((index: number) => Promise<HTMLElement | null>) | null;
  waitForReader(delay: number, force: boolean): Promise<void>;
  foliateScrollAnchors: { invalidate(): void; remember(): void };
  syncFoliateScrollLocation(): void; updateTocCurrentMark(): void; updateProgressTools(): void;
  scheduleSave(): void; setReaderPanelOpen(open: boolean, focus: boolean): void;
  reportNavigationError(error: unknown, generation: number): void;
  epubBook: { sections?: { linear?: string }[] } | null;
  panelState: { showingAllBookmarks: boolean }; sourceUrl: string;
  navigateReader(url: unknown, entry: StoredBookmark): void;
  restoreFormat(mode: string, entry: StoredBookmark): void;
  bookmarksAllButton: HTMLButtonElement; emptyPanel(list: Element, message: string): void;
  filterPanel(panel: Element | null): void; openBookmarkPopover(invoker: HTMLElement, entry: StoredBookmark): void;
  mediaElement: HTMLMediaElement | null; formatMediaTime(time: number): string;
  syncCurrentPageFromMarker(): void; captureFoliateBookmarkPosition(): FoliatePosition | null;
  captureChapterPosition(): ChapterPosition | null; documentState: { pageCount: number; page: number };
  readerPageScrollTop(shell: Element): number; htmlFrame: HTMLIFrameElement | null;
  bookmarkExcerpt(): string; bookmarkPopover: HTMLElement; bookmarkInertSiblings: Map<HTMLElement, boolean>;
  pdfDocument: { _pdfInfo?: { readerPageCountPending?: boolean } } | null;
  bookmarkInvoker: HTMLElement | null; pendingBookmarkSnapshot: BookmarkSnapshot | null;
  captureBookmarkSnapshot(): BookmarkSnapshot; updatePanelState(update: { editingBookmark: StoredBookmark | null }): void;
  bookmarkLabelInput: HTMLInputElement; bookmarkExcerptInput: HTMLInputElement | HTMLTextAreaElement;
  setBookmarkDialogModal(open: boolean): void;
  nextReaderGeneration(kind: string): number;
}
