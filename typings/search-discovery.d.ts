interface VoiceOfMLDiscoveryRecord {
  File?: string; Extension?: string; Repo?: string; Folder?: string[] | null;
  Link?: string; link?: string; ReaderExtension?: string;
}
interface VoiceOfMLRandomDiscoveryDependencies {
  readView(): {dataLoaded: boolean; repoFull: string | null; repo: string | null; mode: string};
  requests: {id: number};
  button(): HTMLElement | null | undefined;
  apiBase: string;
  nativeCount(): number;
  loadReaderAssets(): Promise<unknown>;
  getConvertedReaderRecords(repo: string): Promise<VoiceOfMLDiscoveryRecord[]>;
  localRecord(repo: string, readerOnly: boolean): Promise<{record?: VoiceOfMLDiscoveryRecord | null} | null>;
  ensureLocalDataLoaded(): Promise<boolean>;
  fetchStatus(url: string, timeout: number): Promise<{available?: boolean} | null>;
  getRecordLink(rec: VoiceOfMLDiscoveryRecord): string;
  getReaderLink(rec: VoiceOfMLDiscoveryRecord, returnUrl: string): string;
  navigateToReader(url: string, returnUrl: string): boolean;
  downloadFile(filename: string, link: string, options: {skipCheck: boolean}): Promise<boolean>;
  showToast(message: string): void;
  getRandomLocal(readerOnly: boolean): Promise<VoiceOfMLDiscoveryRecord | null>;
  fetchRandomReaderRecord(url: string, id: number, returnUrl: string): Promise<VoiceOfMLDiscoveryRecord | null | undefined>;
  openReaderRecord(rec: VoiceOfMLDiscoveryRecord | null | undefined, returnUrl: string): boolean;
}
declare var VoiceOfMLRandomDiscovery: {create(deps: VoiceOfMLRandomDiscoveryDependencies): {
  randomBook(): Promise<void>; randomTxt(): Promise<void>;
  getRandomLocal(readerOnly: boolean): Promise<VoiceOfMLDiscoveryRecord | null>;
  fetchRandomReaderRecord(url: string, id: number, returnUrl: string): Promise<VoiceOfMLDiscoveryRecord | null | undefined>;
  openReaderRecord(rec: VoiceOfMLDiscoveryRecord | null | undefined, returnUrl?: string): boolean;
  updateRandomTxtVisibility(): Promise<void>;
}};
