declare namespace ReaderSearchController {
  interface Snippet { text: string; matchStart: number; matchLength: number; prefix: string; suffix: string }
  interface DomResult { location: string; snippet: Snippet; cfi?: undefined; target?: HTMLElement; activate(generation?: number): Promise<boolean> }
  interface FoliateResult { location: string; snippet: Snippet; cfi: string; occurrence: number }
  type Result = DomResult | FoliateResult;
  interface ChapterResult { location: string; snippet: Snippet; chapterIndex: number; start: number; length: number }
  interface Page<T = Result | ChapterResult> { total: number; offset: number; pageSize: number; results: T[] }
  interface State {
    page: Page | null;
    failedPage: { offset: number; selectLast: boolean | null; query: string } | null;
    complete: boolean;
    pdfInProgress: boolean;
    chapterInProgress: boolean;
    pageLoader: ((offset: number, generation?: number) => Promise<Page<Result>>) | null;
  }
  interface Options {
    document: Document;
    runtime: {
      state: { search: { query: string; results: unknown[]; index: number } };
      currentGeneration(kind: "search"): number;
      events: { on(kind: string, callback: (event: unknown) => void): () => void };
    };
    signal: AbortSignal;
    nextGeneration(): number;
    isCurrent(generation: number): boolean;
    updateSearch(patch: { query?: string; results?: Result[]; index?: number }): unknown;
    backend: {
      mode(): string | null;
      search(query: string, generation: number): Promise<unknown>;
      clearMarks(): void;
      chapterClient(): { cancel(): void; failed: boolean; page(offset: number): Promise<Page<ChapterResult>> } | null;
      pdfClient(): { cancel(): void } | null;
      chapterResult(result: ChapterResult): DomResult;
      activate(result: Result, generation: number): Promise<boolean | void>;
    };
    navigation: { begin(): number; current(generation: number): boolean; reportError(error: unknown, generation: number): void };
    panel: { isOpen(): boolean; serial(): number; show(): void; hide(): void; close(): void; focus(): void };
  }
}
