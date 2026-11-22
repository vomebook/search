declare namespace ReaderSearchBackends {
  type GenerationKind = "search" | "navigation";
  interface Snippet { text: string; matchStart: number; matchLength: number; prefix: string; suffix: string }
  interface ChapterResult { chapterIndex: number; start: number; length: number; location: string; snippet: Snippet }
  interface DomResult { location: string; snippet: Snippet; activate(generation: number): Promise<boolean> }
  interface PdfResult { page: number; start: number; length: number; boxes: { box: number[]; block?: unknown; precision?: string }[]; snippet: Snippet; textGeneration?: string }
  type Result = ChapterResult | DomResult | PdfResult;
  interface Page<T = Result> { total: number; offset: number; pageSize: number; results: T[] }
  interface ChapterProgress extends Page<ChapterResult> { scanned: number; chapters: number }
  type ChapterConfiguration = import('./reader-chapter-search-strict').Configuration;
  interface TextPart { node: Text; start: number; end: number }
  interface ChapterArticle extends HTMLElement { _chapterSearchHead?: Node | null }
  interface ChapterClient {
    failed: boolean;
    dispose(): void;
    cancel(): void;
    page(offset: number): Promise<Page<ChapterResult>>;
    search(query: string, progress: (page: ChapterProgress) => void): Promise<Page<ChapterResult>>;
  }
  interface ChapterModule {
    createChapterSearch(configuration: ChapterConfiguration): ChapterClient;
    chapterTextMap(roots: (Node | null)[], textProfile?: string): { text: string; parts(start: number, end: number, body: Node): TextPart[] };
  }
  interface Context {
    readerRuntime: { update(kind: "search", patch: SearchPatch): unknown; currentGeneration(kind: GenerationKind): number };
    isReaderGenerationCurrent(kind: GenerationKind, generation: number): boolean;
    chapterSearchModulePromise: Promise<ChapterModule> | null;
    chapterSearchConfiguration: ChapterConfiguration | null;
    chapterSearchClient: ChapterClient | null;
    applyChapterSearchPage(page: Page<ChapterResult>): void;
    renderFullSearchResults(): void;
    fullSearchStatus: HTMLElement;
    chapterManifestLoader: ((index: number) => Promise<ChapterArticle | null>) | null;
    clearFullSearchMarks(): void;
    highlightTextParts(parts: TextPart[]): HTMLElement[];
    chapterScrollAnchors: { invalidate(): void; remember(): void };
    navigationState: { tocEntries: unknown[] };
    updateNavigationState(patch: { currentChapterIndex: number }): unknown;
    updateTocCurrentMark(): void;
    updateProgressTools(): void;
    scheduleSave(): void;
    viewport: HTMLElement;
    searchState: { query: string };
    capability: { mode: string | null };
    ocrManifestUrl: string | null;
    pdfDocument: ReaderPdfSearch.PdfDocument | null;
    fullSearchController: { resetBackendResults(): void };
    content: HTMLElement;
    htmlFrame: HTMLIFrameElement | null;
    fullSearchSession: { page: Page | null; pageLoader: ((offset: number, generation?: number) => Promise<Page>) | null };
    fullSearchPageOffset(total: number, offset: number, pageSize: number): number;
    waitForReader(delay?: number, force?: boolean): Promise<unknown>;
    fullSearchDomMatches(root: HTMLElement, fallback: string, query: string, generation: number): Promise<DomResult[]>;
    fullSearchPdfMatches(query: string, generation: number): Promise<unknown>;
    searchConcentratedPdf(query: string, generation: number): Promise<DomResult[]>;
  }
  interface SearchPatch { results?: Result[]; index?: number }
}
declare module "*/reader-chapter-search.mjs" {
  export const createChapterSearch: ReaderSearchBackends.ChapterModule["createChapterSearch"];
  export const chapterTextMap: ReaderSearchBackends.ChapterModule["chapterTextMap"];
}
