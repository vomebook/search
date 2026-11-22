interface SearchPositionRestorePage extends VoiceOfMLSearchWindowPageData {
  anchor_index?: number | undefined;
}
interface SearchPositionRestoreTask {
  key: string; controller: AbortController; position: SearchPosition;
  backend?: SearchResultBackend | undefined;
  lookup?: SearchPositionRestorePage | null | undefined;
  ready: Map<number, SearchPositionRestorePage>;
  preview?: boolean; cachedPages?: Map<number, SearchRecentPage>;
  failed?: boolean; error?: Error;
}
interface SearchPositionRestoreOptions {
  position?: SearchPosition | null;
  viewport?: SearchPositionViewport | null | undefined;
  backend?: SearchResultBackend | null | undefined;
}
interface SearchPositionRestoreInput {
  key: string; position: SearchPosition; previous: SearchPositionRestoreTask | null;
  backend: SearchResultBackend | null | undefined;
}
interface SearchPositionRestorationHost {
  currentKey(): string;
  getPosition(key: string): SearchPosition | undefined;
  noteSearchIntent(): void;
  retireSearch(): (() => boolean) | null;
  detachWindow(): AbortController | undefined;
  status(phase: 'started' | 'cancelled' | 'preview' | 'finished' | 'failed', message: string): void;
  readViewport(key: string): Promise<SearchPositionViewport | null>;
  lookupPage(query: VoiceOfMLSearchViewProjection, signal: AbortSignal, anchorId: string, backend?: SearchResultBackend): Promise<{data: SearchPositionRestorePage; backend: SearchResultBackend}>;
  fetchPage(query: VoiceOfMLSearchViewProjection & {resultBackend: SearchResultBackend}, page: number, signal: AbortSignal): Promise<SearchPositionRestorePage>;
  validatePage: typeof VoiceOfMLSearchWindowPage.validate;
  isDragging(): boolean;
  capturePreviewAnchor(): Readonly<{index: number; offset: number; anchorId: string}> | null;
  stableId(record: unknown): string; estimatedHeight(): number;
  applyPreview(snapshot: SearchResultSnapshot): void;
  snapshots: Pick<SearchSnapshotStore, 'cancelClone' | 'put' | 'remove' | 'putRestored' | 'trim'>;
  restoreSnapshot(key: string, preview?: boolean): void;
  notify(message: string): void;
}
declare var VoiceOfMLPositionRestoration: {
  create(host: SearchPositionRestorationHost): {
    readonly current: Readonly<SearchPositionRestoreTask> | null;
    readonly entry: number;
    start(key: string, options?: SearchPositionRestoreOptions): boolean;
    cancel(): void;
    resume(canRetry: (key: string, backend: SearchResultBackend | undefined) => boolean): boolean;
    rememberPreviewPage(page: number, data: SearchRecentPage): void;
  };
};
