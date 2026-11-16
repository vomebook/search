interface VoiceOfMLRouteState {
  mode: string; repo: string | null; browserPath: string; query: string; sort: string;
  filterRepos: string[]; filterExtensions: string[]; filterFolderSelfs: string[]; filterFolderSubtrees: string[];
  filterMinSize: number | null; filterMaxSize: number | null;
  searchFolders: boolean; exact: boolean; useLocalMode: boolean; recordHistory: boolean; useMirrorLinks: boolean;
  leftSidebarOpen: boolean; rightSidebarOpen: boolean; wide: boolean;
}
interface VoiceOfMLRouteOptions { includeQuery?: boolean; displaySizes?: boolean }
type VoiceOfMLRouteParams = Record<string, string | string[] | undefined> & { min_size?: string; max_size?: string };
interface VoiceOfMLRouteProjection {
  query: string; queryTruncated: boolean; filterRepos: string[]; filterExtensions: string[] | null;
  browserPath: string; filterFolderSelfs: string[]; filterFolderSubtrees: string[]; sort: string;
  searchFolders: boolean; exact: boolean; useLocalMode: boolean; recordHistory: boolean; useMirrorLinks: boolean;
  leftSidebarOpen: boolean; rightSidebarOpen: boolean; wide: boolean;
}
interface VoiceOfMLRouterDependencies {
  readState(): VoiceOfMLRouteState;
  buildParams(options?: VoiceOfMLRouteOptions): URLSearchParams;
  readerOpen(): boolean;
  currentURL(): string;
  setHash(url: string): void;
  clearBrowserPath(): void;
  replaceURL(url: string): void;
  commitAppliedURL(url: string): void;
  persistSession(): void;
}
declare var VoiceOfMLRoute: {
  parse(hash: string): { mode: string; repo: string | null; params: VoiceOfMLRouteParams };
  buildParams(state: VoiceOfMLRouteState, formatSize: (value: number) => string | null, options?: VoiceOfMLRouteOptions): URLSearchParams;
  url(mode: string, repo: string | null | undefined, params: URLSearchParams): string;
  project(params: VoiceOfMLRouteParams, mode: string, initialized: boolean): VoiceOfMLRouteProjection;
};
declare var VoiceOfMLRouter: { create(deps: VoiceOfMLRouterDependencies): {
  navigate(mode: string, repo?: string | null, folder?: string): void;
  sync(): void;
}};
