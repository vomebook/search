export interface FoliateAnchorDocument {
  getElementById(id: string): Element | null;
  querySelector(selector: string): Element | null;
}
export type FoliateAnchor = (document: FoliateAnchorDocument) => Element | null;
export interface FoliateSection {
  linear?: string;
  createDocument(): Promise<Document>;
  resolveResourceHref?(href: string): string;
  resolveHref?(href: string): string;
}
export interface FoliateTarget { index: number; anchor?: FoliateAnchor | null }
export interface FoliateTocItem { href?: string; label?: string; subitems?: FoliateTocItem[] }
export interface FoliateBook {
  sections: FoliateSection[];
  toc?: FoliateTocItem[];
  resolveHref(href: string): Promise<FoliateTarget | null>;
}
export interface FoliateView extends HTMLElement { book: FoliateBook; open(file: File): Promise<void>; goTo(href: string): Promise<unknown> }
export interface FoliateTocEntry {
  label: string; href: string; depth: number; group: boolean; activate(): Promise<unknown>;
  sectionIndex?: number; fragment?: string; anchor?: FoliateAnchor | null; target?: Element | null;
}
export type SearchAnchor = (source: Document) => Range | null;
export type SearchSelection = {node: Text; start: number; end: number};
export type FoliateArticle = HTMLElement & { _resolveSearchAnchor?: ((anchor: SearchAnchor) => SearchSelection[] | null) | null };
export type FoliateLoader = ((index: number) => Promise<FoliateArticle | null>) & {refresh(): void};
export interface FoliateFormatContext {
  content: HTMLElement; viewport: HTMLElement; status: HTMLElement; loadingIndicator: Element;
  sourceUrl: string; extension: string; readerTheme: string;
  readerAbortController: AbortController; foliateContinuous: boolean;
  navigationState: {tocEntries: unknown[]; currentChapterIndex: number};
  foliateWindowFrame: number; foliateScrollFrame: number;
  foliateScrollAnchors: ReaderScrollAnchorManager;
  foliateSectionObserver: IntersectionObserver | null;
  foliateSectionVirtualizer: ReturnType<ReaderVirtualApi['createSectionVirtualizer']> | null;
  foliateSectionLoader: FoliateLoader | null;
  foliateSectionSettler: (() => Promise<unknown>) | null;
  foliateChapterRepository: ReturnType<ReaderChaptersApi['createChapterRepository']>;
  FOLIATE_PREFETCH_MARGIN: number; FOLIATE_LOADED_SECTION_LIMIT: number;
  initialReaderTargetSection: number | null;
  readerRestorationEntry: {foliateSection?: number | null} | null;
  epubRendition: FoliateView | null; epubBook: FoliateBook | null;
  readerRuntime: {track<T extends {dispose(): void}>(resource: T): T};
  foliateSectionRoot(article: Element): Element | ShadowRoot;
  foliateSectionQuery(article: Element, selector: string): Element | null;
  refreshFoliateWindow(): void; syncFoliateScrollLocation(): void; trimFoliateSections(): void;
  scheduleFoliateWindowRefresh(): void; scheduleFoliateScrollSync(): void;
  updateNavigationState(state: {currentChapterIndex: number}): void;
  updateTocCurrentMark(): void; updateProgressTools(): void; scheduleSave(): void;
  beginReaderNavigation(): number; isReaderGenerationCurrent(kind: string, generation: number): boolean;
  waitForReader(delay?: number, background?: boolean): Promise<void>;
  alignReaderDestination(destination: Element, offset: number): unknown;
  holdReaderDestination(destination: Element, offset: number): void; setReaderPanelOpen(open: boolean, focus: boolean): void;
  sanitizeEpubDocument(doc: Document, options: {keepBlobImports: boolean}): Document;
  cloneFoliateDocument(source: Document): {doc: Document; sourceNodes: WeakMap<Node, Node>};
  foliateSearchAnchor(source: Document, nodes: WeakMap<Node, Node>, body: Element, rendered: Element): (anchor: SearchAnchor) => SearchSelection[] | null;
  assertReaderActive(): void; awaitReader<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<Awaited<T>>;
  rewriteFoliateResources(doc: Document, section: FoliateSection): void;
  sanitizeFoliateStyles(nodes: Iterable<Element>): Promise<Element[]>;
  epubContentBody(doc: Document): HTMLElement;
  createFoliateSection(section: FoliateSection, index: number, signal?: AbortSignal, priority?: 'high' | 'low'): Promise<FoliateArticle>;
  setupFoliateWindow(stream: HTMLElement, sections: FoliateSection[]): void;
  foliateTocEntries(view: FoliateView, sections: FoliateSection[]): Promise<FoliateTocEntry[]>;
  trackReaderResource(cleanup: () => void): unknown;
  prepareReaderDocument(tasks: Promise<unknown>[]): {response: Promise<Response>; engines: Promise<unknown>};
  readPreparedBytes(response: Promise<Response>, engines: Promise<unknown>, limit: number): Promise<Uint8Array<ArrayBuffer>>;
  getInitialReaderRestoration(): Promise<unknown>; markReaderContentReady(): void; setToc(entries: FoliateTocEntry[]): void;
}
