export interface PortableSiteZipWorkerStartRequest {
  type: "start";
  generatedAt: string;
  totalFiles: number;
}

export interface PortableSiteZipWorkerFileRequest {
  type: "file";
  index: number;
  path: string;
  contents: Uint8Array<ArrayBuffer>;
}

export type PortableSiteZipWorkerRequest =
  PortableSiteZipWorkerStartRequest | PortableSiteZipWorkerFileRequest;

export interface PortableSiteZipWorkerReadyResponse {
  type: "ready";
}

export interface PortableSiteZipWorkerChunkResponse {
  type: "chunk";
  data: Uint8Array<ArrayBuffer>;
  final: boolean;
}

export interface PortableSiteZipWorkerProgressResponse {
  type: "progress";
  completedFiles: number;
  totalFiles: number;
}

export interface PortableSiteZipWorkerErrorResponse {
  type: "error";
  message: string;
}

export type PortableSiteZipWorkerResponse =
  | PortableSiteZipWorkerReadyResponse
  | PortableSiteZipWorkerChunkResponse
  | PortableSiteZipWorkerProgressResponse
  | PortableSiteZipWorkerErrorResponse;
