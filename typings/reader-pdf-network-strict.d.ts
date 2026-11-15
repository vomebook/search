export type PdfRangeCache = ReturnType<typeof import("../static/reader/pdf/reader-pdf-range-cache.mjs").createPdfRangeCache>;
export interface PdfRangeVersion {
  total: number;
  etag: string | null;
}
export interface PdfRangeOptions {
  url: string;
  rangeChunkSize: number;
}
export interface PdfRangeHooks {
  signal: AbortSignal;
  readBytes: (response: Response, limit: number) => Promise<Uint8Array>;
  limit: number;
  rangeLimit?: number;
  rangeCache?: PdfRangeCache | null;
  canPrefetchFirstPage?: () => boolean;
}
export interface PdfRangeBytes { bytes: Uint8Array; }
export interface PdfRangeHint {
  begin: number;
  end: number;
  promise: Promise<unknown>;
  read(from: number, last: number): Promise<PdfRangeBytes | null>;
  onFailure(handler: (error: unknown) => void): void;
}

export interface PdfRateAdmission {
  signal: AbortSignal;
  start: number;
  end: number;
  url: string;
  resolve: () => void;
  reject: (reason: unknown) => void;
}
export interface PdfTiming {
  at: number;
  attempt: number;
  range: number[] | null;
  headersMs: number;
  bodyMs: number;
  bytes: number;
  status?: number;
  serverTiming?: string;
  error?: string;
  totalMs?: number;
}

export interface PdfFetchPolicyOptions {
  idleMs?: number;
  attemptMs?: number;
  initialIdleMs?: number;
  initialTotalMs?: number;
  rateLimitDelayMs?: number;
  rateLimitSpacingMs?: number;
  maxRateLimitDelayMs?: number;
  rateLimitRecoveryMs?: number;
}
