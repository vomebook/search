export interface ReaderUiDocumentPatch {
  title?: string;
  zoom?: number;
  page?: number;
  pageCount?: number;
  restoredEntry?: unknown;
  restorationReady?: boolean;
}
export interface ReaderUiPanelPatch {
  open?: boolean;
  selected?: string;
  showingAllBookmarks?: boolean;
  editingBookmark?: import('./reader-store-strict').BookmarkEntry | null;
}
export interface ReaderUiScrollAnchor {
  node: Element;
  offset: number;
  generation: number;
}
export interface ReaderUiContext {
  downloadFeedbackTimer: number;
  downloadFeedback: HTMLElement;
  showDownloadFeedback(message: string, duration?: number): void;
  readerRuntime: {
    update(domain: "document", patch: ReaderUiDocumentPatch): boolean;
    update(domain: "panel", patch: ReaderUiPanelPatch): boolean;
  };
  pageInverted: boolean;
  pageInvertToggle: HTMLElement;
  chapterScrollAnchors: { capture(): ReaderUiScrollAnchor | null; restore(anchor: ReaderUiScrollAnchor | null): boolean };
  themeAnimationTimer: number;
  readerTheme: string;
  readerThemeToggle: HTMLElement;
  THEME_MOON_ICON: string;
  THEME_SUN_ICON: string;
  content: HTMLElement;
  capability: { mode?: string | null | undefined };
  pageAtMarker(): HTMLElement | null;
  viewport: HTMLElement;
  updateDocumentState(patch: ReaderUiDocumentPatch): boolean;
  documentState: { zoom: number };
  zoomInput: HTMLInputElement;
  pdfShellWindow: { resize(): void } | null;
  htmlFrame: HTMLIFrameElement | null;
  repairHtmlContrast(frame: HTMLIFrameElement): void;
  pdfDocument: object | null;
  rerenderVisiblePdfPages(): void;
  zoomChangedByUser: boolean;
  scheduleSave(): void;
  tocVirtualState: { query: string; matches: number[]; entries: { label: string }[]; list: HTMLElement; panelView: HTMLElement; render(): void } | null;
  TOC_VIRTUAL_ROW_HEIGHT: number;
  clearSearchHighlights(view: HTMLElement): void;
  highlightPanelItem(item: HTMLElement, query: string): void;
  readerUiHistoryState: string;
  isReaderOverlayFrame(): boolean;
  panelAnimationTimer: number;
  readerPanelInteractionSerial: number;
  selectPanel(name: string): void;
  panelState: { selected: string; open: boolean };
  mediaElement: HTMLMediaElement | null;
  updateTocCurrentMark(): void;
  filterPanel(view: HTMLElement, options?: { resetScroll?: boolean }): void;
  mediaTab: HTMLElement;
  updatePanelState(patch: ReaderUiPanelPatch): boolean;
  progressTools: HTMLElement | null;
  renderBookmarks(): void;
  renderHistory(): Promise<void>;
  mediaPanel: HTMLElement;
  formatMediaTime(time: number): string;
  updateProgressTools(): void;
  nextReaderGeneration(kind: string): number;
  isReaderGenerationCurrent(kind: string, generation: number): boolean;
  navigateReader(url: string, bookmark?: null, resumeHistory?: boolean): void;
  sourceUrl: string;
  historySuppressed: boolean;
  progressSaveChain: Promise<void>;
  emptyPanel(list: Element, message: string): void;
}
