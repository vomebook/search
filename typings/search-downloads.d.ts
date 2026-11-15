interface SearchDownloadItem { filename: string; link: string }
interface SearchDownloadBatch {
  items: SearchDownloadItem[]; next: number; started: number; failed: SearchDownloadItem[];
  blockedFailures: SearchDownloadItem[]; skippedUncertain: SearchDownloadItem[];
  uncertain: SearchDownloadItem[]; retry: boolean; cancelled: boolean; done: boolean;
  abortController: AbortController;
}
interface SearchDownloadQueueActions {
  acknowledge(link: string): void; cancel(): void; retry(): void; close(): void;
}
interface SearchDownloadBatchDependencies {
  downloadFileDetailed(filename: string, link: string, options: {quiet: boolean; batch: SearchDownloadBatch}): Promise<"started" | "failed" | "uncertain" | "cancelled">;
  showToast(message: string): void;
  render(batch: SearchDownloadBatch | null, uncertain: SearchDownloadItem[], actions: SearchDownloadQueueActions, reset?: boolean): void;
}
interface SearchDownloadBatches extends SearchDownloadQueueActions {
  readonly batch: SearchDownloadBatch | null;
  readonly uncertain: SearchDownloadItem[];
  start(items: SearchDownloadItem[], retry?: boolean): void;
  onUncertain(filename: string, link: string): void;
  render(): void; isActive(): boolean;
}
declare var VoiceOfMLDownloadBatch: {create(deps: SearchDownloadBatchDependencies): SearchDownloadBatches};
declare var VoiceOfMLDownloadQueue: {render: SearchDownloadBatchDependencies["render"]};
