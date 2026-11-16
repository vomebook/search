// Worker messages are untrusted until the host interprets each command result.
type VoiceOfMLCorpusResult = unknown;
interface VoiceOfMLCorpusDependencies {
  protocol: number; requestTimeout: number; loadTimeout: number;
  createWorker(): Worker | null; corpusURL(): string;
}
interface VoiceOfMLCorpusPending {
  worker: Worker; resolve(value: unknown): void; reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>; expire(): void; cleanup(): void; deadline: number;
}
interface VoiceOfMLCorpusEpoch {
  worker: Worker | null;
  recovery: Promise<{worker: Worker | null; metadata: unknown}> | null;
  bootstrap: Promise<unknown> | null;
}
interface VoiceOfMLCorpusClient {
  request(type: string, payload?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal | null): Promise<unknown>;
  post(type: string, payload?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal | null, worker?: Worker | null): Promise<unknown>;
  ensure(): Promise<Worker>; terminate(error?: unknown, worker?: Worker | null): void; expireRequests(): void;
  inspect(): {worker: Worker | null; starting: boolean; bootstrapping: boolean;
    restartCount: number; consecutiveRestarts: number; pending: {id: number; deadline: number}[]};
}
declare var VoiceOfMLCorpusClient: {
  create(deps: VoiceOfMLCorpusDependencies): VoiceOfMLCorpusClient;
  makeWorkerError(code: string, message?: string): Error & {code: string};
};
