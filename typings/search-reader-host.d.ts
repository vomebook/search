interface ReaderReturnPosition {
  route: string; viewKey: string; top: number; index: number; offset: number;
  focus: { id: string; start: number | null; end: number | null; direction: "forward" | "backward" | "none" | null } | null;
  resultFocus?: { index: number; key: string };
}
interface ReaderReturnDependencies {
  readView(): { hasContainer: boolean; containerHeight: number; resultCount: number; total: number;
    loading: boolean; loadedPage: number; positionRestore: { preview: boolean | undefined; key: string } | null; routeRevision: number };
  hasResult(index: number): boolean;
  getViewKey(): string; getTop(): number; setTop(top: number): void;
  ensureHeights(): void; findIndex(top: number): number; getOffset(index: number): number;
  getTotalHeight(): number; invalidateWindow(): void; renderVisible(): void; updateTrack(): void;
  handoffReady(saved: ReaderReturnPosition): boolean; restoreScroll(rendered: boolean, top: boolean): void;
}
interface ReaderReturnController {
  capture(): ReaderReturnPosition | null; ready(saved: ReaderReturnPosition): boolean;
  restore(windowRendered?: boolean, restoreTop?: boolean): void;
  restoreFocus(saved: ReaderReturnPosition): void;
  restoreHandoff(navigation: ReturnType<SearchReaderNavigationApi['createNavigation']>): void;
  readonly scroll: ReaderReturnPosition | null;
  setScroll(value: ReaderReturnPosition | null): void; invalidate(): void; cancelOnScroll(): void;
}
// The snapshot is an opaque identity handle; only the host reads its payload.
interface ReaderHostSnapshot { readonly results: readonly unknown[]; readonly loadedPage: number }
interface ReaderHostMessage {
  origin: string; source: MessageEventSource | null;
  data: { type?: string; state?: string; theme?: string; url?: string;
    progress?: {url?: unknown; closeTime?: unknown} | null };
}
interface ReaderHostDependencies {
  hashRoute: boolean; position: ReaderReturnController;
  createNavigation(options: {resume(url: string): void; close(): void}): ReturnType<SearchReaderNavigationApi['createNavigation']>;
  buildParams(): URLSearchParams; readQuery(): string; currentParams(): URLSearchParams;
  getViewKey(): string; captureScroll(): ReaderReturnPosition | null; restoreScroll(): void;
  saveSnapshot(key: string): ReaderHostSnapshot | null;
  snapshotChanged(snapshot: ReaderHostSnapshot, key: string): boolean; restoreSnapshot(key: string): void;
  routeChanged(): boolean; applyRoute(preserve: boolean): void; prepareSearch(): void; closeMobileSidebars(): void;
  applyTheme(theme: "dark" | "light"): void;
  navigate(url: string): void; handleMessage(event: ReaderHostMessage): void;
  syncFolder(url: string): string; normalizeReturn(url: string): string;
  openOverlay(url: URL, addHistory?: boolean): void; closeOverlay(focus?: boolean, scroll?: boolean): void; reconcile(): void;
}
declare var VoiceOfMLReaderReturn: { create(deps: ReaderReturnDependencies): ReaderReturnController };
declare var VoiceOfMLReaderHost: { create(deps: ReaderHostDependencies): {
  readonly navigation: ReturnType<SearchReaderNavigationApi['createNavigation']>;
  readonly keys: readonly string[]; readonly overlay: HTMLIFrameElement | null;
  readonly closing: boolean; readonly uiState: string; readonly returnSnapshot: ReaderHostSnapshot | null;
  currentReaderSearchParams(): URLSearchParams; normalizeReaderReturnUrl(raw: string): string;
  syncReaderFolderFilter(raw: string): string;
  closeReaderOverlay(focus?: boolean, scroll?: boolean): boolean;
  openReaderOverlay(url: URL, addHistory?: boolean): void; reconcileSearchDestination(): void;
  restoreReaderOverlay(state: {voiceReaderOverlay?: boolean; readerUrl?: string} | null): void;
  handleReaderMessage(event: ReaderHostMessage): void; navigateToReader(raw: string, returnUrl?: string, fromSidebar?: boolean): boolean;
  restoreReaderFromSession(): void;
} };
