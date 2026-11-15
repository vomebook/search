import type { Book, Hit, SearchIndex } from './reader-book-text-strict';
import type { PartitionReference } from '../static/reader/search/reader-pdf-partition-config.mjs';
import type { SearchPartition } from '../static/reader/search/reader-pdf-partition-shape.mjs';

export interface Configuration {
  url: string; bytes: number; sha256: string; pageCount: number;
  sourceSha?: string; generation?: string; partitions?: PartitionReference[];
}
export type Message = { type: 'init'; configuration: Configuration } | { type: 'cancel' } |
  { type: 'search'; id: number; query: unknown } |
  { type: 'page'; id: number; session: number; offset: number } |
  { type: 'prefetch'; id: number };
export interface Index {
  page(offset?: number): import('./reader-book-text-strict').ResultPage | Promise<import('./reader-book-text-strict').ResultPage>;
}
export interface Session { id: number; index: Index }
export interface Retained { number: number; part: SearchPartition; local: SearchIndex }
export type FirstHits = (Hit & {textGeneration: unknown})[];
export type CompactBook = Book;
export type PrefetchOutcome = {packed: Uint8Array<ArrayBuffer>} | {error: unknown};
export type Progress = (index: Index, scanned: number, pages: number) => Promise<void>;
