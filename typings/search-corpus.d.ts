// The existing Worker protocol carries different result shapes per command.
// Validation and interpretation remain at the Worker and host call sites.
type VoiceOfMLCorpusResult = any;
interface VoiceOfMLCorpusDependencies {
  protocol: number;
  requestTimeout: number;
  loadTimeout: number;
  createWorker(): Worker | null;
  corpusURL(): string;
}
interface VoiceOfMLCorpusPending {
  worker: Worker;
  resolve(value: VoiceOfMLCorpusResult): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  expire(): void;
  cleanup(): void;
  deadline: number;
}
interface VoiceOfMLCorpusEpoch {
  worker: Worker | null;
  recovery: Promise<{worker: Worker | null; metadata: VoiceOfMLCorpusResult}> | null;
  bootstrap: Promise<VoiceOfMLCorpusResult> | null;
}
interface VoiceOfMLCorpusClient {
  request(type: string, payload?: Record<string, any>, timeoutMs?: number, signal?: AbortSignal | null): Promise<VoiceOfMLCorpusResult>;
  post(type: string, payload?: Record<string, any>, timeoutMs?: number, signal?: AbortSignal | null, worker?: Worker | null): Promise<VoiceOfMLCorpusResult>;
  ensure(): Promise<Worker>;
  terminate(error?: unknown, worker?: Worker | null): void;
  expireRequests(): void;
  inspect(): {worker: Worker | null; starting: boolean; bootstrapping: boolean;
    restartCount: number; consecutiveRestarts: number; pending: {id: number; deadline: number}[]};
}
declare var VoiceOfMLCorpusClient: {
  create(deps: VoiceOfMLCorpusDependencies): VoiceOfMLCorpusClient;
  makeWorkerError(code: string, message?: string): Error & {code: string};
};
