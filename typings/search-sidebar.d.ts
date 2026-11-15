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
  repos: VoiceOfMLFilterCount[]; extensions: VoiceOfMLFilterCount[];
  selectedRepos: string[]; selectedExtensions: string[]; tree: VoiceOfMLFilterFolder[];
  apiAvailable: boolean; dataLoaded: boolean;
}
interface VoiceOfMLFilterDependencies {
  readView(): VoiceOfMLFilterView;
  elements: {repoSection: HTMLElement; repoList: VoiceOfMLCheckboxContainer; folderSection: HTMLElement; folderTree: VoiceOfMLFolderElement; extList: HTMLElement};
  tree: VoiceOfMLFolderTree; lists: VoiceOfMLFilterList; orderedExtensions: string[];
  cache: Map<string, VoiceOfMLFilterFolder[]>;
  initial(repo: string | null): Promise<{repos?: VoiceOfMLFilterCount[]; folders?: VoiceOfMLSidebarFolder[]} | null>;
  fetchRepos(): Promise<VoiceOfMLFilterCount[]>;
  fetchExtensions(repo: string | null): Promise<VoiceOfMLFilterCount[]>;
  fetchFolders(repo: string | null, full?: string | null): Promise<VoiceOfMLFilterFolder[] | null>;
  localFolders(repo: string | null): Promise<{tree?: VoiceOfMLFilterFolder[]} | null>;
  extensionCounts(repo: string | null): Record<string, number>;
  hasExtensionCounts(): boolean;
  publishRepos(repos: VoiceOfMLFilterCount[]): void; publishExtensions(extensions: VoiceOfMLFilterCount[]): void;
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
declare var VoiceOfMLSidebarFilters: {create(deps: VoiceOfMLFilterDependencies): VoiceOfMLFilterController};
