interface SearchVirtualState {
  viewKey: string; renderStart: number; renderEnd: number;
  heights: number[]; heightsDirty: boolean; heightTree: number[];
  templateCache: Map<number, HTMLDivElement>; templateCacheKey: string; contentVersion: number;
  measuredWindowKey: string; measuredRowKeys: (string | null)[];
  heightCache: Map<string, {height: number; measurementKey: string}>;
  renderFrame: number; renderAfterScroll: boolean; estimatedHeight: number;
  sparseHeights: boolean; heightBase: number; isDraggingThumb: boolean;
  lastScrollTop: number; lastScrollTime: number; scrollVelocity: number; scrollDirection: number;
  estimateMeasurementKey?: string;
  dragMetrics?: {scrollHeight: number; trackHeight: number; thumbHeight: number} | null;
}
interface SearchVirtualScroll { origin: number; target: number | null }
interface SearchVirtualElements {
  resultsContainer: HTMLElement; resultsList: HTMLElement; multiSelectToggle: HTMLInputElement | null;
}
interface SearchVirtualHeightDependencies {
  results(): (VoiceOfMLResultRecord | null | undefined)[];
  hasWindow(): boolean; cloning(): boolean;
  getHeightMeasurementKey(): string;
  getResultStableId(record: VoiceOfMLResultRecord | null | undefined): string;
}
interface SearchVirtualHeights {
  ensureHeightTree(): void; getVirtualTotalHeight(): number; getVirtualOffset(index: number): number;
  findVirtualIndex(offset: number): number; ensureVirtualHeights(len: number): void;
}
interface SearchVirtualRowsDependencies {
  elements: SearchVirtualElements; total(): number;
  recordForRow(row: Element): VoiceOfMLResultRecord | undefined;
  resetKeyboardIndex(index: number): void;
  ensureResultTemplateCache(): void;
  createResultRow(record: VoiceOfMLResultRecord | null | undefined, index: number): HTMLElement;
  getResultScrollTop(): number; getVirtualOffset(index: number): number; findVirtualIndex(offset: number): number;
}
interface SearchVirtualDependencies extends SearchVirtualHeightDependencies {
  elements: SearchVirtualElements; total(): number; windowTotal(): number;
  restoring(): boolean; loadedPage(): number; pendingEntrance(): boolean; consumeEntrance(): void;
  recordMeasurement(): void;
  recordForRow(row: Element): VoiceOfMLResultRecord | undefined; resetKeyboardIndex(index: number): void;
  ensureResultTemplateCache(): void;
  createResultRow(record: VoiceOfMLResultRecord | null | undefined, index: number): HTMLElement;
  updateCurrentResultPosition(): void; maybeLoadNextPage(): void; updateScrollThumb(): void; updateScrollTrack(): void;
  ensureResultWindowPages(start: number, end: number): void;
  updateVisibleSelection(): void; animateVisibleResultRows(): void;
  rememberDisplayedSearchView(): void; cancelQuickScroll(): void; activateSearchView(): void;
  clearResultTemplateCache(): void;
}
interface SearchVirtualController extends SearchVirtualHeights {
  getResultScrollTop(): number; setResultScrollTop(value: number, restoreWindow?: boolean): void;
  scheduleVirtualRender(scrollIntent?: boolean): void; renderVisible(): boolean;
  resetVirtualScrollState(): void; refreshVirtualAfterAppend(updateView?: boolean): void;
  ensureVirtualViewportCovered(): void;
  measureHeights(start?: number, end?: number, anchor?: {index: number; offset: number} | null): boolean;
}
declare var VoiceOfMLVirtualHeights: {
  createState(): SearchVirtualState;
  create(state: SearchVirtualState, deps: SearchVirtualHeightDependencies): SearchVirtualHeights;
};
declare var VoiceOfMLVirtualRows: {
  create(state: SearchVirtualState, scroll: SearchVirtualScroll, deps: SearchVirtualRowsDependencies): {
    layoutResultScrollSegment(topH: number, endH: number, totalH: number, logicalTop: number): void;
    reconcileVirtualRows(items: (VoiceOfMLResultRecord | null | undefined)[], start: number, end: number, topH: number, bottomH: number): void;
  };
};
declare var VoiceOfMLVirtualResults: {
  segmentHeight: number; create(state: SearchVirtualState, deps: SearchVirtualDependencies): SearchVirtualController;
};
