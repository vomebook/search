interface SearchBootstrapView {
  page: number; pageSize: number; query: string; sort: string; searchFolders: boolean; exact: boolean;
  repoFilters: number; extensionFilters: number;
  folderSelfFilters: number; folderSubtreeFilters: number;
  minSize: number | null; maxSize: number | null;
  mode: string; repo: string | null; repoFull: string | null;
}
interface SearchInitialPayload {
  results: unknown[]; page?: number; page_size?: number; total?: number; generation?: unknown; mode?: string; repo?: string;
}
interface SearchInitialPage {
  results: unknown[]; total: number; page: number; page_size: number; generation: unknown;
}
interface SearchBootstrapDependencies {
  view(): SearchBootstrapView; intent(): number; viewKey(): string;
  eligible(): boolean; payloadURL(): string;
  cache: BoundedResponseCache<{data: SearchInitialPayload; time: number}>;
  cachedResponse(): SearchInitialPayload | null;
  cloneData<T>(data: T): T; identity(data: object): object | undefined;
  fetchJSON(url: string, timeout: number): Promise<SearchInitialPayload | null>;
  tryPayload(mode: string, repo: string | null, intent: number): Promise<boolean>;
  applyPayload(data: SearchInitialPayload | null, intent: number, acquiredAt?: number | null): boolean;
  cancelSearch(): boolean; commitPage(data: SearchInitialPayload): SearchInitialPage;
  cacheResponse(page: SearchInitialPage, acquiredAt: number): void;
  markUnverified(record: unknown, page: SearchInitialPage): void;
  renderPage(): void; syncRoute(): void; prefetch(): void; scheduleLocalData(): void; search(): void;
}
declare var VoiceOfMLInitialPayload: {
  eligible(view: SearchBootstrapView): boolean;
  url(view: SearchBootstrapView, base: string): string;
  accepts(data: SearchInitialPayload | null, view: SearchBootstrapView): boolean;
};
declare var VoiceOfMLSearchBootstrap: { create(deps: SearchBootstrapDependencies): {
  apply(data: SearchInitialPayload | null, intent: number, acquiredAt?: number | null): boolean;
  tryPayload(mode: string, repo: string | null, intent: number): Promise<boolean>;
  fresh(intent: number): Promise<boolean>;
}};
