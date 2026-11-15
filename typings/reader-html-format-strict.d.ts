export interface CssOptions { strict?: boolean; keepBlobImports?: boolean; blobImports?: {url: string; media: string}[] | null; nonce?: string }
export interface HtmlDocumentData { html: string; discourse: boolean; spreadsheet: boolean }
export interface HeadingTocEntry { label: string; depth: number; target: Element; activate(): void }
export interface PreparedText { response: Response | Promise<Response>; engines?: Promise<unknown> }
export interface PreparedHtml { response: Promise<Response>; engine: Promise<unknown> }
export interface HtmlFormatContext {
  EPUB_HTML_TAGS: ReadonlySet<string>; EPUB_HTML_VOID_TAGS: ReadonlySet<string>;
  DISCOURSE_POST_SELECTOR: string; DISCOURSE_TITLE_SELECTOR: string;
  HTML_FRAME_STYLE: string; DISCOURSE_HTML_STYLE: string; SPREADSHEET_HTML_STYLE: string;
  downloadUrl: string; sourceUrl: string; content: HTMLElement; status: HTMLElement;
  documentState: {title: string; zoom: number}; htmlFrame: HTMLIFrameElement | null;
  normalizeEpubDocument(doc: Document): Document;
  sanitizeReaderDocument(doc: Document, options?: {preserveEpubStyles?: boolean; keepBlobImports?: boolean}): Document;
  sanitizeEpubDocument(doc: Document): Document;
  buildDiscourseDocument(text: string): string | null; sanitizeOfflineHtml(text: string): string;
  prepareHtmlDocument(text: string): HtmlDocumentData; buildHtmlFrameSource(data: HtmlDocumentData): string;
  fetchReaderResponse(): Promise<Response>; renderPlainText(response: Response): Promise<void>;
  readPreparedBytes(response: Response | Promise<Response>, engine: Promise<unknown> | undefined): Promise<Uint8Array>;
  detectTextEncoding(bytes: Uint8Array, hint: string): string; detectHtmlEncoding(bytes: Uint8Array, hint: string): string;
  headingTocEntries(root: ParentNode): HeadingTocEntry[]; setToc(entries: HeadingTocEntry[]): void;
  markReaderContentReady(): void; assertReaderActive(): void;
  isReaderOverlayFrame(): boolean; navigateReader(url: string): void;
  settleReaderImages(doc: Document, timeout: number): Promise<void>; waitForSpreadsheetImages(frame: HTMLIFrameElement): Promise<void>;
  repairHtmlContrast(frame: HTMLIFrameElement): void; trackReaderResource(cleanup: () => void): () => void;
  readerAbortError(): Error; handleReaderPositionChange(event: Event): void; handleReaderKeydown(event: KeyboardEvent): void;
  handleReaderOutsideClick(event: MouseEvent): void; beginReaderNavigation(event: Event): void;
  installReaderTapSelectionClear(body: HTMLElement, doc: Document): void;
}
