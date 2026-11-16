interface VoiceOfMLResultRecord {
  File?: string; Extension?: string; Repo?: string; Folder?: string[] | null;
  Size?: number | string | null; ReaderExtension?: string;
}
interface VoiceOfMLResultRowDependencies {
  readView(): {query: string; searchFolders: boolean; mode: string};
  escapeHTML: typeof escapeHTML; highlightText: typeof highlightText; formatSize: typeof formatSize;
  getFileIconType(extension: string | undefined): string | object;
  getRecordLink(record: VoiceOfMLResultRecord): string;
  getCopyableLink(link: string): string;
  getRecordPath(record: VoiceOfMLResultRecord): string; getPreviewLink(path: string): string;
  readerAction(record: VoiceOfMLResultRecord, link: string): {url: string; label: string};
  icons: Record<string, string>;
  templates: Map<number, HTMLDivElement>; contentVersion(): number;
  placeholder(index: number): HTMLDivElement; bindRecord(row: HTMLDivElement, record: VoiceOfMLResultRecord): void;
}
declare var VoiceOfMLResultRows: {create(deps: VoiceOfMLResultRowDependencies): {
  buildHTML(record: VoiceOfMLResultRecord, index: number): string;
  createRow(record: VoiceOfMLResultRecord | null | undefined, index: number): HTMLDivElement;
}};
interface VoiceOfMLResultSelection {indices: Record<number, boolean>; lastIndex: number}
interface VoiceOfMLResultInteractionDependencies {
  elements: {
    resultsList: HTMLElement; sidebarContent: HTMLElement;
    multiSelectToggle: HTMLInputElement | null; multiCopyLinks: HTMLElement | null;
    multiBatchDownload: HTMLElement | null; multiDeselect: HTMLElement | null; multiSelectAll: HTMLElement | null;
  };
  selection: VoiceOfMLResultSelection;
  hasRecord(index: number): boolean;
  selectionRecords(): unknown[]; resultCount(): number;
  updateSelectionUI(): void;
  getSelectedFiles(): {filename: string; link: string}[];
  getCopyableLink(link: string): string;
  startDownloadBatch(files: {filename: string; link: string}[]): void;
  showToast(message: string): void;
  retryWindowPage(page: number): boolean;
  recordForRow(row: Element | null): VoiceOfMLResultRecord | undefined;
  freshReaderLink(record: VoiceOfMLResultRecord): string;
  downloadFile(filename: string, link: string, options?: {button: HTMLElement}): Promise<boolean>;
  navigateToReader(url: string | undefined): void;
  navigateRepo(repo: string | null | undefined, path?: string | undefined): void;
  currentRepo(): string | null;
  buildSearchURLParams(options?: {displaySizes: boolean}): URLSearchParams;
  renderBrowser(folder: string): void;
}
declare var VoiceOfMLResultInteractions: {create(deps: VoiceOfMLResultInteractionDependencies): {
  installSelection(): void; installDelegation(): void;
}};
