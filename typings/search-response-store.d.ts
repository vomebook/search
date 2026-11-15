interface SearchResponseStoreDependencies {
  limit: number;
  ttl: number;
  getSearchViewKey(): string;
  rememberSearchPageMetadata(data: unknown): void;
}
interface SearchResponseStore {
  cache: BoundedResponseCache<{time: number; data: VoiceOfMLSearchWindowPageData}>;
  pendingWrites: Map<string, {data: VoiceOfMLSearchWindowPageData; viewKey: string}>;
  cloneSearchData<T>(data: T): T;
  getCachedSearchResponse(key: string): VoiceOfMLSearchWindowPageData | null;
  cancelPendingSearchCacheWrites(): void;
  setCachedSearchResponse(key: string, data: VoiceOfMLSearchWindowPageData, defer?: boolean): void;
}
declare var VoiceOfMLSearchResponseStore: {create(deps: SearchResponseStoreDependencies): SearchResponseStore};
