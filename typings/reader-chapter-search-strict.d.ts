export interface Configuration {
  index: { url: string; bytes: number; sha256: string; text_profile?: string | undefined };
  chapters: { index: number; path: string }[];
}
export type Result = import('../static/reader/search/reader-chapter-search-core.mjs').SearchResult;
export interface Page { id: number; session: number; total: number; offset: number; pageSize: number; results: Result[]; progress?: false; error?: undefined }
export interface Progress { id: number; progress: true; total: number; scanned: number; chapters: number; offset: number; pageSize: number; results: Result[] }
export type Response = Page | Progress | { id: number; error: string; progress?: false };
export interface Pending {
  id: number;
  resolve(value: Page): void;
  reject(reason: Error): void;
  progress: ((value: Progress) => void) | null;
}
export interface TextPart { node: Text; start: number; end: number }
export interface Space { node: Text | null; start: number; end: number }
export interface Run extends Space { from: number; to: number; linear: boolean }
