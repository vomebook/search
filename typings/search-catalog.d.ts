interface CatalogSidebarPayload {
  repo?: string; path?: string; repos?: VoiceOfMLFilterCount[];
  folders?: {n?: string; c?: number}[];
  files?: {n?: string; e?: string; t?: unknown; s?: string | number}[];
}
interface CatalogBootstrap {
  repos?: VoiceOfMLFilterCount[]; extensions?: VoiceOfMLFilterCount[];
  sidebar?: CatalogSidebarPayload;
}
interface PagesCatalogDependencies {
  apiBase: string; apiAvailable(): boolean;
  fetchJSON(url: string, timeout: number, requireOK?: boolean): Promise<unknown>;
  noteApiSuccess(): void; noteApiFailure(): void;
  localWorker(repo: string, path: string): Promise<VoiceOfMLSidebarEntries>;
}
declare var VoiceOfMLCatalogSidebarPayload: {
  normalize(data: unknown, path?: string): unknown;
};
declare var VoiceOfMLCatalogClient: {create(deps: PagesCatalogDependencies): {
  fetchRepos(): Promise<VoiceOfMLFilterCount[] | null>;
  fetchExtensions(repo: string | null): Promise<VoiceOfMLFilterCount[] | null>;
  fetchFolderTree(repo: string | null, cacheKey?: string | null): Promise<VoiceOfMLFilterFolder[] | null>;
  fetchFolderContents(repo: string | null, path: string): Promise<VoiceOfMLSidebarEntries | null | undefined>;
  loadSidebarInitial(repo: string | null): Promise<VoiceOfMLSidebarEntries | null>;
  getFolderContents(repo: string | null, path: string): Promise<VoiceOfMLSidebarEntries | undefined>;
  folderTreeCache: Map<string, VoiceOfMLFilterFolder[]>;
  folderContentsCache: BoundedResponseCache<VoiceOfMLSidebarEntries>;
  browserApiCache: BoundedResponseCache<VoiceOfMLSidebarEntries>;
  browserApiPending: Map<string, Promise<VoiceOfMLSidebarEntries | null>>;
  sidebarInitialCache: Map<string, VoiceOfMLSidebarEntries>;
  sidebarInitialPending: Map<string, Promise<VoiceOfMLSidebarEntries | null>>;
  extensionApiCache: Map<string, VoiceOfMLFilterCount[]>;
  extensionApiPending: Map<string, Promise<VoiceOfMLFilterCount[] | null>>;
  repoApiCache: VoiceOfMLFilterCount[] | null;
  repoApiPending: Promise<VoiceOfMLFilterCount[] | null> | null;
}};
