interface SearchResponseStoreDependencies {
  limit: number;
  ttl: number;
  getSearchViewKey(): string;
  rememberSearchPageMetadata(data: VoiceOfMLSearchWindowPageData): void;
}
interface SearchResponseStore {
  cache: BoundedResponseCache<{time: number; data: VoiceOfMLSearchWindowPageData}>;
  identities: WeakMap<object, object>;
  cloneSearchData<T extends VoiceOfMLSearchWindowPageData>(data: T): T;
  getCachedSearchResponse(key: string): VoiceOfMLSearchWindowPageData | null;
  cancelPendingSearchCacheWrites(): void;
  setCachedSearchResponse(key: string, data: VoiceOfMLSearchWindowPageData, defer?: boolean, acquiredAt?: number): void;
}
declare var VoiceOfMLSearchResponseStore: {create(deps: SearchResponseStoreDependencies): SearchResponseStore};
