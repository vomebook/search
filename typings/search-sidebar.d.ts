interface VoiceOfMLFilterCount {name: string; count?: number | undefined}
interface VoiceOfMLFilterItem {key: string; label: string; count?: number | undefined}
interface VoiceOfMLFilterFolder extends VoiceOfMLFolderSelectionNode {
  name: string; count?: number; children?: VoiceOfMLFilterFolder[] | null;
}
interface VoiceOfMLCheckboxContainer extends HTMLElement {
  _itemsKey?: string; _onChange?: (values: string[]) => void; _hasDelegate?: boolean; _updating?: boolean;
}
interface VoiceOfMLFolderElement extends HTMLElement {
  _folderNode?: VoiceOfMLFilterFolder; _folderPath?: string; _folderDepth?: number;
  _childrenRendered?: boolean; _eventsReady?: boolean; _renderTask?: VoiceOfMLFolderRenderTask | null;
  _transitionCleanup?: ((event: {target: EventTarget | null; propertyName: string}) => void) | null;
  _transitionTimer?: ReturnType<typeof setTimeout> | null;
}
interface VoiceOfMLFolderRenderTask {
  container: VoiceOfMLFolderElement; nodes: VoiceOfMLFilterFolder[]; depth: number; index: number;
  tree: VoiceOfMLFilterFolder[]; route: number;
}
interface VoiceOfMLFolderTreeDependencies {
  container: VoiceOfMLFolderElement; toggleAll: HTMLButtonElement | null;
  readView(): {tree: VoiceOfMLFilterFolder[]; collapsed: Record<string, boolean>; subtrees: string[]; selfs: string[]; mode: string; routeId: number};
  setCollapsed(path: string, collapsed: boolean): void;
  commitSelection(subtrees: string[], selfs: string[]): void;
  notify(message: string): void; escape(value: unknown): string | undefined;
  selection: typeof VoiceOfMLSearchFolderSelection;
}
interface VoiceOfMLFolderTree {
  render(): void; refresh(): void; updateControls(loading?: boolean): void;
  initialize(nodes: VoiceOfMLFilterFolder[] | null | undefined): void;
  setAllCollapsed(collapsed: boolean): void; persistSelection(subtrees: Set<string>, selfs: Set<string>): void;
  selectAll(): void; invertSelection(): void; retain(routeId: number): void; cancel(root?: HTMLElement | null): void;
  animate(children: VoiceOfMLFolderElement, toggle: HTMLElement, expanding: boolean): void; pending(): number;
}
interface VoiceOfMLFilterListDependencies {readSelection(): string[]; escape(value: unknown): string | undefined}
interface VoiceOfMLFilterList {
  renderExtensionTree(container: HTMLElement, items: VoiceOfMLFilterItem[], rest: VoiceOfMLFilterCount[], selected: string[], onChange: (values: string[]) => void): void;
  renderCheckboxList(container: VoiceOfMLCheckboxContainer, items: VoiceOfMLFilterItem[], selected: string[], onChange: (values: string[]) => void): void;
}
interface VoiceOfMLFilterView {
  mode: string; repo: string | null; repoFull: string | null; routeId: number;
  repos: VoiceOfMLFilterCount[];
  selectedRepos: string[]; selectedExtensions: string[]; tree: VoiceOfMLFilterFolder[];
  apiAvailable: boolean; dataLoaded: boolean;
}
interface VoiceOfMLFilterDependencies {
  readView(): VoiceOfMLFilterView;
  elements: {repoSection: HTMLElement; repoList: VoiceOfMLCheckboxContainer; folderSection: HTMLElement; folderTree: VoiceOfMLFolderElement; extList: HTMLElement};
  tree: VoiceOfMLFolderTree; lists: VoiceOfMLFilterList; orderedExtensions: string[];
  cache: Map<string, VoiceOfMLFilterFolder[]>;
  initial(repo: string | null): Promise<VoiceOfMLSidebarEntries | null>;
  fetchRepos(): Promise<VoiceOfMLFilterCount[] | null>;
  fetchExtensions(repo: string | null): Promise<VoiceOfMLFilterCount[] | null>;
  fetchFolders(repo: string | null, full?: string | null): Promise<VoiceOfMLFilterFolder[] | null>;
  localFolders(repo: string | null): Promise<{tree?: VoiceOfMLFilterFolder[]} | null>;
  extensionCounts(repo: string | null): Record<string, number>;
  hasExtensionCounts(): boolean;
  publishExtensions(extensions: VoiceOfMLFilterCount[]): void;
  publishTree(tree: VoiceOfMLFilterFolder[] | null, resetCollapsed?: boolean): void;
  selectRepos(values: string[]): void; selectExtensions(values: string[]): void;
}
interface VoiceOfMLFilterController {
  render(routeId?: number): Promise<void>; renderExtensions(routeId?: number): Promise<void> | void;
  renderRepos(routeId?: number): Promise<void>; retain(routeId: number): void;
  status(): {token: number; done: number};
}
declare var VoiceOfMLSidebarFolderTree: {create(deps: VoiceOfMLFolderTreeDependencies): VoiceOfMLFolderTree};
declare var VoiceOfMLSidebarFilterList: {create(deps: VoiceOfMLFilterListDependencies): VoiceOfMLFilterList};
declare var VoiceOfMLSidebarFilters: {
  create(deps: VoiceOfMLFilterDependencies): VoiceOfMLFilterController;
  bulkExtensions(available: string[], selected: string[], invert: boolean): string[];
};

interface VoiceOfMLSidebarEntries {
  folders?: VoiceOfMLSidebarFolder[] | null; files?: VoiceOfMLSidebarFile[] | null;
  repos?: VoiceOfMLFilterCount[];
}
interface VoiceOfMLSidebarScrollDependencies {content(): HTMLElement; storageKey: string}
interface VoiceOfMLSidebarScrollController {
  keyFor(repo: string | null, path: string): string;
  activate(key: string): void; remember(): void; restore(): void; install(): void;
  readonly activeKey: string; readonly restoring: boolean; readonly positions: Map<string, number>;
}
interface VoiceOfMLSidebarDirectoryViewDependencies {
  content: HTMLElement; sidebar: HTMLElement; scroll: VoiceOfMLSidebarScrollController;
  escape(value: unknown): string | undefined;
  updateHeader(): void; navigate(path: string | undefined): void; setPath(path: string): void;
  markup: Parameters<typeof VoiceOfMLSearchSidebarRender.browserMarkup>[3];
}
interface VoiceOfMLSidebarDirectoryPresentation {
  repos(repos: VoiceOfMLFilterCount[]): void;
  items(list: HTMLElement, data: VoiceOfMLSidebarEntries, repo: string, path: string): void;
  breadcrumb(path: string): HTMLElement; begin(path: string, readRepo: () => string): {list: HTMLElement; currentRepo: string}; message(html: string): void;
}
interface VoiceOfMLSidebarDirectoryView {
  mode: string; repo: string | null; repoFull: string | null; browserPath: string; routeId: number;
  repos: VoiceOfMLFilterCount[]; apiAvailable: boolean; useLocalMode: boolean; dataLoaded: boolean;
}
interface VoiceOfMLSidebarDirectoryDependencies {
  readView(): VoiceOfMLSidebarDirectoryView;
  view: VoiceOfMLSidebarDirectoryPresentation; scroll: VoiceOfMLSidebarScrollController;
  renderRepos(repos: VoiceOfMLFilterCount[]): void; updateHeader(): void;
  initial(repo: string | null): Promise<VoiceOfMLSidebarEntries | null>;
  fetchRepos(): Promise<VoiceOfMLFilterCount[] | null>;
  fetchContents(repo: string | null, path: string): Promise<VoiceOfMLSidebarEntries | null | undefined>;
  localContents(repo: string | null, path: string): Promise<VoiceOfMLSidebarEntries | null | undefined>;
  ensureLocal(force: boolean, silent: boolean): Promise<boolean>;
  cache: Map<string, VoiceOfMLSidebarEntries>;
  refreshAssets(list: HTMLElement, repo: string, path: string, routeId: number | undefined,
    readDisplayed: () => VoiceOfMLSidebarEntries | null, isCurrent?: () => boolean): void;
}
interface VoiceOfMLSidebarDirectoryController {
  render(routeId?: number): void | Promise<void>; repos(routeId?: number): Promise<void>;
  browse(path: string, routeId?: number): Promise<void>; resetRetries(): void;
}
declare var VoiceOfMLSidebarScroll: {create(deps: VoiceOfMLSidebarScrollDependencies): VoiceOfMLSidebarScrollController};
declare var VoiceOfMLSidebarDirectoryView: {create(deps: VoiceOfMLSidebarDirectoryViewDependencies): VoiceOfMLSidebarDirectoryPresentation};
declare var VoiceOfMLSidebarDirectory: {create(deps: VoiceOfMLSidebarDirectoryDependencies): VoiceOfMLSidebarDirectoryController};
