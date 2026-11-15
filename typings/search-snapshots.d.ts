interface SearchSnapshotHeight { height: number; measurementKey: string }
type SearchSnapshotHeightEntry = readonly [string, Readonly<SearchSnapshotHeight>];
interface SearchSnapshotScroll { index: number; offset: number; viewKey?: string }
interface SearchSnapshotView {
  key: string; revision: number; results: unknown[]; total: number; loadedPage: number;
  pageCache: Record<string, unknown>; resultBackend?: string | null;
  window?: {generation?: string | undefined; pages: Iterable<number>; count: number; invalid?: boolean} | null;
}
interface SearchResultSnapshot {
  version: number; key: string; results: unknown[]; total: number; page: number; loadedPage: number;
  pageCache: Record<string, unknown>; resultBackend?: string | null | undefined; hasMore: boolean;
  window: {generation?: string | undefined; pages: number[]; count: number; invalid?: boolean} | null;
  estimatedHeight: number; heightCache: SearchSnapshotHeightEntry[]; heightRecords?: SearchSnapshotHeightEntry[];
  scroll: SearchSnapshotScroll; savedAt: number; bytes?: number;
}
interface SearchSnapshotGeometry {
  revision: number; measurementKey: string; estimatedHeight: number; heightCache: ReadonlyMap<string, SearchSnapshotHeight>;
}
interface SearchSnapshotSource { signature: string; revision: number; resultsBytes: number }
interface SearchSnapshotCloneTask {
  snapshot: SearchResultSnapshot; key: string; results: unknown[]; cursor: number; keys: string[] | null;
  timer: ReturnType<typeof setTimeout> | undefined; frame: number;
  heightAnchor?: {index: number; offset: number} | null;
}
interface SearchSnapshotBudget {
  measure(results: unknown[], sparse?: boolean): number;
  extend(results: unknown[], page: unknown[]): void;
  captureHeights(cache: ReadonlyMap<string, SearchSnapshotHeight>): {entries: SearchSnapshotHeightEntry[]; bytes: number};
  has(results: unknown[]): boolean; invalidate(results: unknown[]): void; remember(results: unknown[], bytes: number): void;
}
interface SearchSnapshotHost {
  cloneResult(result: unknown): unknown;
  measurementKey(): string;
  materialized(task: SearchSnapshotCloneTask, index: number, measurementKey: string): void;
  applyHeights(task: SearchSnapshotCloneTask): void;
  isCurrent(task: SearchSnapshotCloneTask): boolean;
  completed(): void;
}
interface SearchSnapshotStore {
  readonly snapshots: ReadonlyMap<string, SearchResultSnapshot>;
  put(key: string, snapshot: SearchResultSnapshot): void; remove(key: string): void;
  readonly budget: SearchSnapshotBudget;
  readonly cloneTask: SearchSnapshotCloneTask | null;
  source(snapshot: object): SearchSnapshotSource | undefined;
  save(view: SearchSnapshotView, position: SearchSnapshotScroll | null, geometry: SearchSnapshotGeometry): SearchResultSnapshot | null;
  trim(): void; copyPageCache(cache: Record<string, unknown>): Record<string, unknown>;
  cancelClone(): void;
  materializeRange(task: SearchSnapshotCloneTask, start: number, end: number, deferHeights?: boolean, measurementKey?: string | null): void;
  restoreResults(snapshot: SearchResultSnapshot, key: string, pageSize: number, restoreScroll: boolean, preserveRestore: boolean): unknown[];
  startClone(): void;
}
declare var VoiceOfMLSnapshotPolicy: {
  VERSION: number; MAX: number; BYTES_MAX: number; cloneResult(result: unknown): unknown; createBudget(): SearchSnapshotBudget;
};
declare var VoiceOfMLResultSnapshots: {create(host: SearchSnapshotHost): SearchSnapshotStore};
