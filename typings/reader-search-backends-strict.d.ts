declare namespace ReaderSearchBackends {
  type GenerationKind = "search" | "navigation";
  interface Snippet { text: string; matchStart: number; matchLength: number; prefix: string; suffix: string }
  interface ChapterResult { chapterIndex: number; start: number; length: number; location: string; snippet: Snippet }
  interface FoliateResult { location: string; cfi: string; occurrence: number; snippet: Snippet }
  interface DomResult { target?: HTMLElement; location: string; snippet: Snippet; activate(generation: number): Promise<boolean> }
  interface DomTarget { target: HTMLElement | undefined }
  interface PdfResult { page: number; start: number; length: number; boxes: { box: number[]; block?: unknown; precision?: string }[]; snippet: Snippet; textGeneration?: string }
  type Result = ChapterResult | FoliateResult | DomResult | PdfResult;
  interface Page<T = Result> { total: number; offset: number; pageSize: number; results: T[] }
  interface ChapterProgress extends Page<ChapterResult> { scanned: number; chapters: number }
  type ChapterConfiguration = import('./reader-chapter-search-strict').Configuration;
  interface TextPart { node: Text; start: number; end: number }
  interface ChapterArticle extends HTMLElement { _chapterSearchHead: Node | null }
  interface ChapterClient {
    failed: boolean;
    dispose(): void;
    search(query: string, progress: (page: ChapterProgress) => void): Promise<Page<ChapterResult>>;
  }
  interface ChapterModule {
    createChapterSearch(configuration: ChapterConfiguration): ChapterClient;
    chapterTextMap(roots: (Node | null)[], textProfile?: string): { text: string; parts(start: number, end: number, body: Node): TextPart[] };
  }
  interface FoliateItem { cfi: string; excerpt?: { pre: string; match: string; post: string } }
  interface FoliateGroup { index: number; count: number; label: string; subitems: FoliateItem[] }
  type Anchor = (source: Document) => Range;
  interface FoliateNode extends HTMLElement { _resolveSearchAnchor?: ((anchor: Anchor) => TextPart[] | null) | null }
  interface Rendition {
    search(options: { query: string; index?: number; offset?: number; limit: number; lean: boolean; current: () => boolean }): AsyncIterable<FoliateGroup>;
    resolveNavigation?(cfi: string): Promise<{ index: number; anchor?: Anchor } | null>;
  }
  interface Context {
    readerRuntime: { update(kind: "search", patch: SearchPatch): unknown; currentGeneration(kind: GenerationKind): number };
    isReaderGenerationCurrent(kind: GenerationKind, generation: number): boolean;
    updateSearchState(patch: SearchPatch): unknown;
    publishSearchResults(generation: number, results: Result[]): unknown;
    chapterSearchModulePromise: Promise<ChapterModule> | null;
    chapterSearchModule(): Promise<ChapterModule>;
    chapterSearchConfiguration: ChapterConfiguration | null;
    chapterSearchClient: ChapterClient | null;
    applyChapterSearchPage(page: Page<ChapterResult>): void;
    renderFullSearchResults(): void;
    fullSearchStatus: HTMLElement;
    chapterManifestLoader: ((index: number) => Promise<ChapterArticle | null>) | null;
    clearFullSearchMarks(): void;
    highlightTextParts(parts: TextPart[]): HTMLElement[];
    foliateScrollAnchors: { invalidate(): void; remember(): void };
    navigationState: { tocEntries: unknown[] };
    updateNavigationState(patch: { currentChapterIndex: number }): unknown;
    updateTocCurrentMark(): void;
    updateProgressTools(): void;
    scheduleSave(): void;
    epubRendition: Rendition | null;
    epubBook: { sections?: { linear?: string }[] } | null;
    foliateSectionLoader: ((index: number) => Promise<FoliateNode | null>) | null;
    foliateSectionRoot(node: FoliateNode): Element | ShadowRoot;
    viewport: HTMLElement;
    searchState: { query: string };
    capability: { mode: string | null };
    ocrManifestUrl: string | null;
    content: HTMLElement;
    htmlFrame: HTMLIFrameElement | null;
    fullSearchSession: { page: Page | null; pageLoader: ((offset: number, generation?: number) => Promise<Page>) | null };
    fullSearchPageOffset(total: number, offset: number, pageSize: number): number;
    waitForReader(delay?: number, force?: boolean): Promise<unknown>;
    fullSearchDomMatches(root: Element | ShadowRoot, fallback: string, query: string, generation: number, progressive: boolean, occurrence: number, navigationGeneration: number): Promise<DomTarget[]>;
    fullSearchDomMatches(root: HTMLElement, fallback: string, query: string, generation: number, progressive?: boolean): Promise<DomResult[]>;
    fullSearchPdfMatches(query: string, generation: number): Promise<unknown>;
    searchConcentratedPdf(query: string, generation: number): Promise<DomResult[]>;
    fullSearchFoliateMatches(query: string, generation: number): Promise<FoliateResult[]>;
    searchChapterBook(query: string, generation: number): Promise<void>;
  }
  interface SearchPatch { results?: Result[]; index?: number }
}
declare module "*/reader-chapter-search.mjs" {
  export const createChapterSearch: ReaderSearchBackends.ChapterModule["createChapterSearch"];
  export const chapterTextMap: ReaderSearchBackends.ChapterModule["chapterTextMap"];
}
