export interface TocEntry {
  label: string;
  /** One-based destination; null means there is no destination. */
  page?: number | null;
  href?: string;
  chapterIndex?: number;
  sectionIndex?: number;
  depth?: number;
  group?: boolean;
  target?: Element | null;
  activate(generation: number): unknown;
}
export interface HeadingLocationCache {
  root: HTMLElement;
  entries: TocEntry[];
  at(marker: number, scroll: number): number;
  dispose(): void;
}
export interface TocVirtualState {
  entries: TocEntry[];
  matches: number[];
  query: string;
  list: HTMLElement;
  panelView: HTMLElement;
  render(): void;
  destroy(): void;
}
export interface TocContext {
  readerRuntime: {
    update(kind: 'navigation', patch: Partial<{ tocEntries: TocEntry[]; currentChapterIndex: number }>): unknown;
    events: { on(kind: string, listener: (event: unknown, kind: string) => void): () => void };
    track(cleanup: () => void): unknown;
  };
  documentState: { zoom: number; pageCount: number; page: number };
  htmlFrame: HTMLIFrameElement | null;
  viewport: HTMLElement;
  content: HTMLElement;
  capability: { mode?: string | null };
  headingLocationCache: HeadingLocationCache | null;
  navigationState: { tocEntries: unknown[]; currentChapterIndex: number };
  updateNavigationState(patch: Partial<{ tocEntries: TocEntry[]; currentChapterIndex: number }>): unknown;
  updateTocCurrentMark(): void;
  beginReaderNavigation(): number;
  isReaderGenerationCurrent(kind: string, generation: number): boolean;
  updateProgressTools(): void;
  setReaderPanelOpen(open: boolean, focus?: boolean): void;
  reportNavigationError(error: unknown, generation: number): void;
  navigateTocEntry(index: number): Promise<void>;
  tocVirtualState: TocVirtualState | null;
  TOC_VIRTUAL_ROW_HEIGHT: number;
  highlightPanelItem(row: HTMLElement, query: string): void;
  readerLifecycle: { disposed: boolean };
  readerAbortController: AbortController;
  readerRestorationPromise: Promise<object | null> | null;
  readerHasHistory: boolean;
  restorationFailed: boolean;
  panelState: { open: boolean };
  readerPanelInteractionSerial: number;
  readerUiHistoryState: string;
  selectPanel(name: string): void;
  sourceUrl: string;
  downloadUrl: string;
  chapterManifestUrl: string | null;
  TOC_VIRTUALIZATION_THRESHOLD: number;
  filterPanel(panel: Element | null, options: { resetScroll: boolean }): void;
  updateReadingProgressSummary(): void;
  placeReadingProgress(): void;
}
