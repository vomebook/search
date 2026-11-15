export interface StoreHistoryInput {
  url: string;
  title?: unknown;
  extension?: unknown;
  lastReadAt?: unknown;
  [key: string]: unknown;
}
export type HistoryEntry = StoreHistoryInput & {
  schemaVersion: number;
  title: string;
  extension: string;
  lastReadAt: number;
};
export interface BookmarkInput {
  id: string;
  url: string;
  label?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
}
export type BookmarkEntry = BookmarkInput & {
  schemaVersion: number;
  label: string;
  createdAt: number;
};
export type StoreChange =
  | { type: "history"; url: string; lastReadAt: number }
  | { type: "history-remove"; url: string }
  | { type: "history-clear" }
  | { type: "bookmark"; url: string; id: string }
  | { type: "bookmark-remove"; id: string };
export type LocalStoreMessage = StoreChange & { remote: false };
// BroadcastChannel data is untrusted and is spread without validation at runtime.
export type RemoteStoreMessage = { remote: true; [key: string]: unknown };
export type StoreMessage = LocalStoreMessage | RemoteStoreMessage;
export interface ReaderStoreStrictApi {
  readonly DB_NAME: string;
  readonly DB_VERSION: number;
  readonly MAX_ENTRIES: number;
  readonly SCHEMA_VERSION: number;
  readonly STORE_VERSION: string;
  get(url: string): Promise<HistoryEntry | null>;
  put(entry: StoreHistoryInput): Promise<void>;
  list(limit?: number): Promise<HistoryEntry[]>;
  isHistoryFull(): Promise<boolean>;
  remove(url: string): Promise<void>;
  clearHistory(): Promise<void>;
  putBookmark(entry: BookmarkInput): Promise<void>;
  listBookmarks(url: string): Promise<BookmarkEntry[]>;
  listAllBookmarks(): Promise<BookmarkEntry[]>;
  removeBookmark(id: string): Promise<void>;
  subscribe(listener: (message: StoreMessage) => void): () => boolean | void;
  dispose(): void;
}
