// Minimal DOM surface used for painting. Structural types keep this module
// checkable in workers without requiring the DOM library.
export type TextNode = typeof globalThis extends { Text: { prototype: infer T } } ? T : WorkerTextNode;
export type Shell = typeof globalThis extends { HTMLElement: { prototype: infer T } } ? T : WorkerShell;
interface WorkerTextNode { data: string }
interface WorkerShell {
  querySelectorAll(selectors: string): { forEach(callback: (node: { remove(): void }) => void): void };
  querySelector(selectors: string): { ownerDocument: PaintDocument } | null;
  ownerDocument: PaintDocument;
  appendChild(node: PaintElement): unknown;
  getBoundingClientRect(): PaintRect;
}
interface PaintRect { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface PaintElement {
  className: string;
  dataset: { [key: string]: string | undefined };
  style: object;
  setAttribute(name: string, value: string): void;
}
interface PaintDocument {
  createElement(name: 'span'): PaintElement;
  createTreeWalker(root: { ownerDocument: PaintDocument }, whatToShow: number): { nextNode(): unknown; currentNode: object };
  createRange(): {
    setStart(node: TextNode, offset: number): void;
    setEnd(node: TextNode, offset: number): void;
    getClientRects(): Iterable<PaintRect>;
  };
}
export interface Span {
  start: number;
  end: number;
  box: number[];
  block?: unknown;
  precision?: unknown;
}
export interface TextMapping { text: string; text_spans?: Span[] }
export interface TextPage extends TextMapping { page: number }
export interface Book { pages: TextPage[] }
export interface Box { box: number[]; block?: unknown; precision?: unknown }
export interface Hit {
  page: number;
  start: number;
  length: number;
  boxes: Box[];
  snippet: { text: string; matchStart: number; matchLength: number; prefix: string; suffix: string };
}
export interface ResultPage { total: number; offset: number; pageSize: number; results: Hit[] }
export interface SearchIndex { readonly total: number; page(offset?: number, pageSize?: number): ResultPage }
export interface Options {
  current?: () => boolean;
  yieldTask?: () => Promise<unknown>;
  progress?: ((index: SearchIndex, scanned: number, total: number) => Promise<unknown> | void) | null;
}
export interface Checkpoint { ordinal: number; pageIndex: number; start: number; end: number }
export interface Projection { end: number; point: number }
export interface ProjectionPage extends Projection { text: string; pageIndex: number; checkpoints: Map<number, Projection> }
