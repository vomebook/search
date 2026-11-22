type SearchResultBackend = "api" | "local";
interface SearchPosition {
  version: number; key: string; index: number; offset: number; anchorId: string; loadedPage: number; savedAt: number;
}
interface SearchPositionViewport {
  key: string; savedAt: number; anchorId: string; index: number; total: number;
  generation: string | undefined; resultBackend?: SearchResultBackend | null | undefined;
  estimatedHeight: number; measurementKey: string;
  records: [number, unknown, number][];
}
interface SearchRecentPage extends VoiceOfMLSearchWindowPageData {
  id: [string, number]; key: string; savedAt: number;
  resultBackend?: SearchResultBackend | null | undefined;
}
interface SearchPositionView {
  key: string; total: number; results: unknown[]; resultBackend?: SearchResultBackend | null | undefined;
  window?: {generation?: string | undefined; total: number; pages: Set<number>} | null | undefined;
}
type SearchRecentPageExpected = VoiceOfMLSearchWindowExpected & {query: {pageSize: number; resultBackend?: SearchResultBackend | null | undefined}};
interface SearchPositionGeometry {
  visibleEnd: number; pageSize: number; measurementKey: string; estimatedHeight: number;
  heightAt(index: number): number;
}
interface SearchPositionStorage {
  readonly database: IDBDatabase | null;
  close(): void;
  init(accept: (values: SearchPosition[]) => void): Promise<void>;
  read(name: string, key: IDBValidKey, timeout?: number, signal?: AbortSignal | null): Promise<unknown>;
  writeContent(name: string, values: object[], limit: number, ttl: number): void;
  writePosition(position: SearchPosition, prune: boolean): void;
}
interface SearchPositionPersistence {
  readonly positions: ReadonlyMap<string, SearchPosition>;
  readonly viewports: ReadonlyMap<string, SearchPositionViewport>;
  readonly recentPages: ReadonlyMap<string, SearchRecentPage>;
  init(): Promise<void>;
  getPosition(key: string): SearchPosition | undefined;
  save(position: SearchPosition, capture: () => void): SearchPosition;
  saveViewport(position: SearchPosition, view: SearchPositionView, geometry: SearchPositionGeometry): void;
  saveRecentPages(position: SearchPosition, view: SearchPositionView, visibleEnd: number): void;
  readViewport(key: string): Promise<SearchPositionViewport | null>;
  readRecentPage(key: string, page: number, expected: SearchRecentPageExpected, timeout?: number, signal?: AbortSignal | null): Promise<SearchRecentPage | null>;
  scheduleSave(save: () => void): void; cancelSave(): void;
}
declare var VoiceOfMLPositionPolicy: {
  POSITION_MAX: number; POSITION_TTL: number; VIEWPORT_MAX: number; VIEWPORT_BYTES_MAX: number;
  RECENT_PAGE_MAX: number; RECENT_PAGE_BYTES_MAX: number; RECENT_PAGE_TTL: number;
  validPosition(value: unknown): value is SearchPosition;
  validViewport(value: unknown, position: SearchPosition | null | undefined, stableId: (record: unknown) => string): value is SearchPositionViewport;
  validRecentPage(value: unknown, key: string, page: number, expected: SearchRecentPageExpected): value is SearchRecentPage;
};
declare var VoiceOfMLPositionStorage: {
  create(): SearchPositionStorage;
};
declare var VoiceOfMLSearchPositions: {
  create(deps: {storage: SearchPositionStorage; cloneResult(record: unknown): unknown;
    metadata(record: unknown): {generation?: string | undefined; total: number} | undefined}): SearchPositionPersistence;
};
