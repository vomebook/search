interface PagesPrefetchGroup extends AbortController {
  groupKey: string; active: Map<number, Promise<void> | Promise<VoiceOfMLSearchWindowPageData>>; attempted: Set<number>;
  cacheWaits?: Map<number, {controller: AbortController; urgent: boolean}>;
}

interface PagesSearchRecord extends VoiceOfMLResultRecord {
  Link?: string; Path?: string; ReaderLink?: string; ReaderChapterManifest?: string;
  ReaderPdfDocument?: string; ReaderOcrManifest?: string; ReaderOcrMode?: string; extension?: string;
}
interface PagesSidebarFile extends VoiceOfMLSidebarFile { link?: string }

interface PagesCorpusMetadata {
  repos: VoiceOfMLFilterCount[]; extensions: VoiceOfMLFilterCount[];
  extensionsByRepo: Record<string, VoiceOfMLFilterCount[]>;
  reader: {available: boolean; count: number; byRepo: Record<string, number>};
}
interface PagesCorpusPage {
  records: unknown[]; total: number; page: number; pageSize: number;
  snapshot_generation: string; anchor_index?: number;
}
interface PagesWindowQuery extends VoiceOfMLSearchViewProjection {
  resultBackend?: SearchResultBackend | null | undefined;
}
interface PagesSearchParams extends SearchExecutionParams {}
interface PagesSearchState extends Omit<VoiceOfMLRouteState, 'wide'> {
  repoFull: string | null; page: number; pageSize: number; total: number;
  results: (PagesSearchRecord | null | undefined)[];
  isMobile: boolean; isDark: boolean; isLoading: boolean; hasMore: boolean;
  extensionList: string[]; folderTree: VoiceOfMLFilterFolder[] | null;
  folderTreeCollapsed: Record<string, boolean>; sessionRestored: boolean; dataLoaded: boolean;
  resultsSkeletonActive: boolean; _pendingPage: number; _loadedPage: number;
  _pageCache: Record<number, (VoiceOfMLResultRecord | null | undefined)[]>;
  _initialActive: boolean; _deferredAppendWhileDragging: boolean;
  _resultBackend?: SearchResultBackend | null; _pagingAppendScrollTop?: number | null;
}

// Elements populated by cacheDOM from the search page. The two legacy position
// controls may be absent in the current shell.
interface PagesSearchDOM {
  announcement: HTMLElement; headerTitle: HTMLElement; headerLogo: HTMLAnchorElement;
  searchBox: HTMLElement; searchInput: HTMLInputElement;
  hamburgerBtn: HTMLButtonElement; settingsBtn: HTMLButtonElement; themeBtn: HTMLButtonElement; mobileToggleBtn: HTMLButtonElement;
  themeIconLight: SVGSVGElement; themeIconDark: SVGSVGElement; mobileIconPhone: SVGSVGElement; mobileIconDesktop: SVGSVGElement;
  leftSidebar: HTMLElement; rightSidebar: HTMLElement; sidebarContent: HTMLElement; sidebarTitle: HTMLElement;
  sidebarBackBtn: HTMLButtonElement; sidebarExpandBtn: HTMLButtonElement;
  resultsList: HTMLElement; resultsContainer: HTMLElement; emptyState: HTMLElement; emptyDesc: HTMLElement;
  emptyRandomBtn: HTMLButtonElement; resultCount: HTMLElement; clearFiltersBtn: HTMLButtonElement;
  sortSelect: HTMLSelectElement; mirrorLinksToggle: HTMLInputElement; loadInfo: HTMLElement;
  mobileSelectedCount: HTMLElement; totalCount: HTMLElement;
  currentResultPosition: HTMLInputElement; resultPositionDisplay: HTMLElement | null;
  scrollTrack: HTMLElement; scrollThumb: HTMLElement;
  hitokoto: HTMLElement; randomBookBtn: HTMLButtonElement; randomTxtBtn: HTMLButtonElement;
  overlay: HTMLElement; toast: HTMLElement; filterRepoSection: HTMLElement; filterRepoList: HTMLElement;
  repoFilterCancel: HTMLButtonElement; filterFolderSection: HTMLElement; filterFolderTree: HTMLElement;
  folderFilterCancel: HTMLButtonElement; filterExtList: HTMLElement; extFilterCancel: HTMLButtonElement;
  filterMinSize: HTMLInputElement; filterMaxSize: HTMLInputElement; filterMinUnit: HTMLSelectElement; filterMaxUnit: HTMLSelectElement;
  closeFiltersBtn: HTMLButtonElement; folderSelectAll: HTMLButtonElement; folderDeselectAll: HTMLButtonElement;
  folderToggleAll: HTMLButtonElement; extSelectAll: HTMLButtonElement; extDeselectAll: HTMLButtonElement;
  searchFoldersToggle: HTMLInputElement; exactSearchToggle: HTMLInputElement; exactSearchSection: HTMLElement;
  localModeToggle: HTMLInputElement; historyToggle: HTMLInputElement; historyDropdown: HTMLElement;
  returnToPositionBtn: HTMLButtonElement; backToTopBtn: HTMLButtonElement; retryPositionBtn: HTMLButtonElement;
  positionRestoreStatus: HTMLElement;
  multiToggleLabel: HTMLElement; multiSelectToggle: HTMLInputElement; multiActionBar: HTMLElement;
  multiCopyLinks: HTMLButtonElement; multiBatchDownload: HTMLButtonElement; multiSelectAll: HTMLButtonElement;
  multiSelectedCount: HTMLElement; multiDeselect: HTMLButtonElement;
}
