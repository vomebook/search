export type GenerationKind = "search" | "navigation";
export interface TocEntry { target?: Element | null; label: string }
export interface TextPart { node: Text; start: number; end: number }
export interface Offset { node?: Text; parent: HTMLElement; start: number; end: number }
export interface LiveOffset extends Offset { node: Text }
export interface HighlightOffset { node: Text; start: number; end: number }
export interface Checkpoint { target: HTMLElement; start: number }
export type HeadingLookup = (offset: number) => { label: string | undefined } | null;
export interface SnapshotData { text: string; offsets: Offset[]; breaks: number[]; headingLookup: HeadingLookup | null; checkpoints: Checkpoint[]; toc: unknown[] }
export interface Snapshot { root: Element | ShadowRoot; current(): boolean; resume(): void; pause(): void; dispose(): void; readonly value: SnapshotData | null; set(data: SnapshotData): void }
export interface Locator { current(): boolean; boundaries(): Checkpoint[]; seed(boundaries: Checkpoint[]): void; build(offsets: Offset[]): void; checkpoint(offset: number): Checkpoint | null; pause(): void; resume(): void; dispose(): void }
export interface Snippet { text: string; matchStart: number; matchLength: number; prefix: string; suffix: string }
export interface Result { target?: HTMLElement; location: string; snippet: Snippet; activate(generation?: number): Promise<boolean> }
export interface Page { total: number; offset: number; pageSize: number; results: Result[] }
export interface Options {
  content: HTMLElement;
  runtime: { events: { on(name: "generation", listener: (event: unknown) => void): () => void }; currentGeneration(kind: GenerationKind): number };
  isCurrent(kind: GenerationKind, generation: number): boolean;
  yieldTask(): Promise<unknown>;
  getTocEntries(): unknown[];
  unwrapRoot(root: Element): Element | ShadowRoot;
  publishPage(page: Page, loader: (offset: number) => Page, partial: boolean): void;
}
export interface Match { index: number; value: string }
export interface Group { start: number; end: number; skip: number; count: number }
