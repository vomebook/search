export interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  fontName: string;
  dir?: string;
  width: number;
  height: number;
}
export interface PdfTextViewport {
  width: number;
  height: number;
  scale: number;
  transform?: number[];
  convertToViewportPoint?: (x: number, y: number) => number[];
}
export interface PdfTextStyle { fontFamily?: string; vertical?: boolean; ascent?: number }
export interface OcrBlock { t?: string; b?: number[] }
export interface TextRegion {
  start: number; end: number; text: string; writing_mode: string;
  direction: string; id: string; mapping_precision: string;
  quad: number[][];
}
export interface IndependentTextPayload { text: string; regions: TextRegion[]; generation: string }
export type VerticalRun = HTMLSpanElement & { _readerVerticalAdvance?: number };
