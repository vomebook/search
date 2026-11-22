type ReaderAssetMap = Record<string, unknown>;
interface ReaderAssetConvertedPending { snapshot: ReaderAssetMap; promise: Promise<void> | null }
interface ReaderAssetState {
  assets: ReaderAssetMap | null; pending: Promise<ReaderAssetMap> | null; retryAt: number;
  converted: VoiceOfMLResultRecord[] | null; byRepo: Record<string, VoiceOfMLResultRecord[]> | null;
  convertedPending: ReaderAssetConvertedPending | null;
}
interface ReaderAssetPaintDependencies {
  getSearchViewKey(): string; canWaitForPaint(): boolean;
  resultsList(): HTMLElement | null; isFirstViewReady(key: string): boolean;
}
interface ReaderAssetDependencies extends ReaderAssetPaintDependencies {
  bucketBase: string; buildRecordLink(record: VoiceOfMLResultRecord): string;
}
interface ReaderAssetSchedulingState {
  delayUntilPaint: boolean; parseWake: (() => void) | null; channel: MessageChannel | null;
}
interface ReaderAssetScheduling {
  state: ReaderAssetSchedulingState;
  yieldConvertedReaderBuild(): Promise<void>;
  waitForReaderAssetFirstPaint(signal: AbortSignal, targetKey: string | null): Promise<void>;
}
interface ReaderAssetTransport {
  state: { compressedLimit: number; expandedLimit: number };
  fetchReaderAssetMap(deferDecode?: boolean): Promise<ReaderAssetMap>;
}
interface ReaderAssetController {
  state: ReaderAssetState; scheduling: ReaderAssetScheduling; transport: ReaderAssetTransport;
  loadReaderAssets(deferDecode?: boolean): Promise<ReaderAssetMap>;
  applyReaderAsset<T extends VoiceOfMLResultRecord>(record: T, repo: string, relativePath: string, originalLink: string): T;
  getConvertedReaderRecords(repo?: string): Promise<VoiceOfMLResultRecord[]>;
}
declare var VoiceOfMLReaderAssetScheduling: { create(deps: ReaderAssetPaintDependencies): ReaderAssetScheduling };
declare var VoiceOfMLReaderAssetTransport: { create(deps: ReaderAssetPaintDependencies, scheduling: ReaderAssetScheduling): ReaderAssetTransport };
declare var VoiceOfMLReaderAssets: { create(deps: ReaderAssetDependencies): ReaderAssetController };
