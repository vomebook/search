export interface TocEntry {
  label: string;
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
  createHeadingLocationCache(root: HTMLElement, entries: TocEntry[]): HeadingLocationCache;
  updateNavigationState(patch: Partial<{ tocEntries: TocEntry[]; currentChapterIndex: number }>): unknown;
  updateTocCurrentMark(): void;
  beginReaderNavigation(): number;
  foliateContinuous: boolean;
  activateFoliateTocEntry(entry: TocEntry, generation: number, options: { closePanel: boolean }): Promise<unknown>;
  isReaderGenerationCurrent(kind: string, generation: number): boolean;
  updateProgressTools(): void;
  setReaderPanelOpen(open: boolean, focus?: boolean): void;
  reportNavigationError(error: unknown, generation: number): void;
  navigateTocEntry(index: number): Promise<void>;
  tocVirtualState: TocVirtualState | null;
  TOC_VIRTUAL_ROW_HEIGHT: number;
  createTocRow(entry: TocEntry, index: number): HTMLElement;
  highlightPanelItem(row: HTMLElement, query: string): void;
  readerLifecycle: { disposed: boolean };
  readerAbortController: AbortController;
  panelState: { open: boolean };
  readerPanelInteractionSerial: number;
  readerUiHistoryState: string;
  selectPanel(name: string): void;
  cleanTocLabel(value: unknown): string;
  chapterManifestUrl: string | null;
  TOC_VIRTUALIZATION_THRESHOLD: number;
  renderVirtualToc(): void;
  filterPanel(panel: Element | null, options: { resetScroll: boolean }): void;
  updateReadingProgressSummary(): void;
  placeReadingProgress(): void;
}
