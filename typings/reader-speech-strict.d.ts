import type { OcrPayload, PdfPage, TextContent, TextItem, TextTask } from './reader-pdf-text-runtime-strict';
import type { PlaybackSettings, ReadOptions, StartLocator } from './tts-client-strict';

export interface SpeechContext {
  capability: { mode?: string | null } | null;
  sourceUrl: string; contentUrl: string; content: HTMLElement; viewport: HTMLElement;
  htmlFrame: HTMLIFrameElement | null;
  chapterManifestLoader: (((index: number) => Promise<HTMLElement | null>) & { count: number }) | null;
  documentState: { pageCount: number; page: number };
  ocrManifestUrl: string; pdfOcrManifest: object | null;
  pdfDocument: { getPage(page: number): Promise<PdfPage> } | null;
  pdfTextContentCache: Map<number, unknown>; pdfTextContentPromises: Map<number, TextTask>;
  loadPdfOcrPage(page: number, priority: 'low'): Promise<OcrPayload>;
  loadPdfTextContent(page: number, pdfPage: PdfPage, generation: null): Promise<TextContent | TextItem[] | null | undefined>;
  pdfTextContent(items: TextItem[]): string;
  goToPage(page: number): unknown; pageAtMarker(): HTMLElement | null;
  isReaderOverlayFrame(): boolean;
  readerRuntime: { events: { on(name: string, handler: (detail: unknown, type: string) => void): () => void } };
}
export interface SpeechSource {
  units: number; first: number; root(unit: number): Node | null;
  load(unit: number, probing?: boolean): string | Promise<string>;
  ready?: (unit: number) => boolean; locate?: (unit: number) => unknown;
  page?: boolean; frame?: HTMLIFrameElement | null; dom?: boolean;
}
export interface Position { unit: number; offset: number }
export interface Part { unit: number; start: number; end: number; raw: string }
export interface SpeechAdapter {
  base: number; source: SpeechSource; readonly text: string; readonly done: boolean;
  progress(): string; root: Node | null; ensure(length: number): Promise<void>; ensureUnit(unit: number): Promise<void>;
  offsetOf(position: Position): number; locateTop(): Promise<number | null>; partAt(offset: number): Part | null;
  selectionStart(): StartLocator | null; onStart(): void;
  covers(unit: number): boolean; range(start: number, end: number): Range | null;
  follow(start: number): void | Promise<void>; following: boolean; current: number | null; autoUntil: number;
  visible(start: number, range?: Range | null): { inside: boolean; overlaps: boolean } | null;
  userScrolled(): void; inView(offset: number): boolean;
  saveView(): { top: number; frame: number | null }; restoreView(view: { top: number; frame: number | null }): void;
  reveal(offset: number): Promise<void>; offsetAtTop(): number;
}
export interface SpeechPlayer {
  previewLoaded(value: { id: string; title: string; adapter: SpeechAdapter; host: HTMLElement; tools: Element | null; buttonClass: string }): void;
  previewClosed(): void; readFrom(offset: number | StartLocator, options?: ReadOptions): void; stop?(): void; viewChanged?(): void;
  state?(): { playing?: boolean; interrupted?: boolean; active?: boolean; position: number | null; settings?: PlaybackSettings;
    adapter?: { partAt?: (offset: number) => Part | null } | null } | null;
}
