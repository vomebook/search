interface SearchExecutionView {
  searchId: number; intent: number; requestId: number;
  page: number; _loadedPage: number; _pendingPage: number;
  _resultBackend: "api" | "local" | null; _initialActive: boolean;
  _deferredAppendWhileDragging: boolean; dataLoaded: boolean; useLocalMode: boolean;
  resultCount: number; apiAvailable: boolean;
}
interface SearchExecutionPatch {
  page?: number; _pendingPage?: number; _resultBackend?: "api" | "local";
  dataLoaded?: boolean; isLoading?: boolean; resultsSkeletonActive?: boolean;
}
interface SearchExecutionParams {
  page: number; folderMatchMode?: string | null; signal?: AbortSignal;
  [key: string]: unknown;
}
interface SearchExecutionDependencies {
  readView(): SearchExecutionView; update(patch: SearchExecutionPatch): void;
  signal(create: boolean): AbortSignal; setLocalMode(enabled: boolean): void;
  clearPrefetch(): void;
  pendingLocal(page: number, append: boolean | undefined): Promise<VoiceOfMLSearchWindowPageData> | false | undefined;
  loadLocal(): Promise<boolean>; searchLocal(params: SearchExecutionParams): Promise<VoiceOfMLSearchWindowPageData>;
  searchAPI(params: SearchExecutionParams, append: boolean | undefined, requestId: number): Promise<boolean>;
  retry(append?: boolean): void; applyPage(data: VoiceOfMLSearchWindowPageData, append: boolean | undefined): boolean;
  clearUnavailableResults(): void; renderUnavailable(waiting: boolean): void;
  renderPage(append: boolean | undefined): void; visualLoading(value: boolean): void;
  prefetch(): void; warmConnection(): void; syncURL(): void; notify(message: string): void;
  updateStatus(): void; finishPaging(ok: boolean, error: unknown): void; updatePaging(): void;
}
declare var VoiceOfMLSearchExecutionPolicy: {
  backend(view: SearchExecutionView, append: boolean | undefined, folderMatchMode: string | null | undefined): "api" | "local" | "unavailable" | "local-fallback";
};
declare var VoiceOfMLSearchExecution: { create(deps: SearchExecutionDependencies): {
  execute(params: SearchExecutionParams, append: boolean | undefined, id: number, intent: number): void;
  local(params: SearchExecutionParams, append: boolean | undefined, id: number): Promise<void>;
}};
