interface SearchPositionRestorePage extends VoiceOfMLSearchWindowPageData {
  anchor_index?: number | undefined;
}
interface SearchPositionRestoreTask {
  key: string; controller: AbortController; position: SearchPosition;
  backend?: string | undefined;
  lookup?: SearchPositionRestorePage | null | undefined;
  ready: Map<number, SearchPositionRestorePage>; page: number; results: unknown[];
  preview?: boolean; cachedPages?: Map<number, SearchPositionRestorePage>;
  failed?: boolean; error?: Error;
}
interface SearchPositionRestoreInput {
  key: string; position: SearchPosition; previous?: SearchPositionRestoreTask | null | undefined;
  backend?: string | undefined;
}
interface SearchPositionRestorationHost {
  isCurrent(task: SearchPositionRestoreTask): boolean;
  readViewport(key: string): Promise<SearchPositionViewport | null>;
  fetchPage(query: {pageSize: number; resultBackend?: string}, page: number, signal: AbortSignal, anchorId?: string): Promise<SearchPositionRestorePage>;
  validatePage: typeof VoiceOfMLSearchWindowPage.validate;
  showPreview(viewport: SearchPositionViewport | null, position: SearchPosition, task: SearchPositionRestoreTask): void;
  isDragging(): boolean;
  capturePreviewAnchor(): Readonly<{index: number; offset: number; anchorId: string}> | null;
  stableId(record: unknown): string; estimatedHeight(): number;
  release(): void; applyPreview(snapshot: SearchResultSnapshot): void;
  snapshots: Pick<SearchSnapshotStore, 'put' | 'trim'>;
  restoreSnapshot(key: string): void; completed(): void;
  failed(message: string): void; notify(message: string): void;
}
declare var VoiceOfMLPositionRestoration: {
  createTask(input: SearchPositionRestoreInput): SearchPositionRestoreTask;
  create(host: SearchPositionRestorationHost): {
    run(task: SearchPositionRestoreTask, viewport?: SearchPositionViewport | null): Promise<void>;
  };
};
