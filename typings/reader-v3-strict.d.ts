export interface Resource { bucket: string; path: string; role: string; sha256: string; bytes: number; kind?: string }
export interface DatasetPrimary { kind: 'dataset-source'; repo: string; path: string; revision: string; sha256: string; bytes: number; role: string }
export interface Partition { start: number; end: number; resource: Resource; complete?: boolean }
export interface TextEntry { page: number; generation: string; page_identity: string; quality: string; processing: string; resource: Resource }
export interface TextLayer {
  version: number; kind: 'pdf-text-layer'; source_sha256: string; page: number; generation: string; raw_sha256: string; page_identity: string;
  offset_unit: string; text: string; revision: string; quality: string; processing: string;
  parent_generation?: string; acceptances?: unknown[]; geometry: { width: number; height: number; coordinate_space: string };
  regions: { id: string; order: number; start: number; end: number; text: string; box: number[]; quad: number[][]; writing_mode: string; direction: string }[];
}
export interface TextIndex { version: number; kind: string; complete: boolean; source_sha256: string; page_count: number; generation: string; revision: string; offset_unit: string; partitions: Partition[]; book_text: Resource; search_partitions?: Partition[] }
export interface TextPartition { version: number; kind: string; source_sha256: string; generation: string; start: number; end: number; pages: TextEntry[] }
export interface ReadingManifest {
  version: number; kind: string; source_sha256: string; generation: string; page_count: number; source_key: string;
  primary: { kind: string; status: string; resource: Resource | DatasetPrimary };
  preview: { complete: boolean; page_count: number; partitions: Partition[]; ready_pages: number; status?: string };
  page_map: Resource; text_layer?: Resource; components: { document: string; preview: string; text: string };
}
export interface PageMap { version: number; kind: string; source_sha256: string; pages: { page: number; identity: string; width: number; height: number; rotation: number; crop_box: number[]; media_box: number[] }[] }
export interface RepositoryOptions { readJson(url: string, ref: Resource): Promise<unknown> | unknown; resourceUrl(ref: Resource): string; signal?: AbortSignal; pageCount: number; sourceSha: string }
