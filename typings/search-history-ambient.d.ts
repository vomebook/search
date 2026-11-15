interface VoiceOfMLSearchHistoryStorePort {
  get(): string[];
  save(list: string[]): void;
}
interface VoiceOfMLSearchHistoryDependencies {
  elements(): {searchInput: HTMLInputElement; searchBox: HTMLElement; historyDropdown: HTMLElement; resultsContainer: HTMLElement};
  store: VoiceOfMLSearchHistoryStorePort;
  escapeHTML(value: string): string;
  recordHistory(): boolean;
  isComposing(): boolean;
  submitSearchQuery(query: string, options: {restore: boolean; blur: boolean}): void;
}
declare var VoiceOfMLSearchHistoryStore: {create(storage: () => Storage): VoiceOfMLSearchHistoryStorePort};
declare var VoiceOfMLSearchHistory: {create(deps: VoiceOfMLSearchHistoryDependencies): {
  addHistoryItem(query: string): void; removeHistoryItem(query: string): void;
  renderDropdown(): void; hideSearchHistory(restoreFocus?: boolean): void; setupSearchHistory(): void;
}};
interface VoiceOfMLQuotationState {
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
  lastAt: number;
  suspended: boolean;
  animation: {el: HTMLElement; chars: string[]; index: number; speed: number; timer: ReturnType<typeof setTimeout> | null} | null;
}
declare var VoiceOfMLQuotation: {create(deps: {element(): HTMLElement}): {setup(): void}};
