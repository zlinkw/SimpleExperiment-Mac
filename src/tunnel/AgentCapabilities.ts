export const expectedAgentApiVersion = "1";

export interface AgentHealthResponse {
  schemaVersion: 1;
  agentVersion: string;
  apiVersion: string;
  mode: "realtime";
  startedAt: string;
  serverTime: string;
  uptimeSeconds: number;
  projectRoot: string;
  agentInstallDir?: string;
  schedulerDependencies?: unknown;
  status: "ok" | "degraded";
}

export interface AgentCapabilitiesResponse {
  schemaVersion: 1;
  apiVersion: string;
  agentVersion: string;
  endpoints: {
    health: boolean;
    snapshot: boolean;
    websocketEvents: boolean;
    sseEvents: boolean;
    gpuHistory?: boolean;
    logsTail: boolean;
    fileList: boolean;
    fileDownload: boolean;
    fileRangeDownload: boolean;
    fileUploadChunk: boolean;
    fileTransferStatus: boolean;
    actions: boolean;
  };
  limits: {
    maxUploadChunkBytes: number;
    maxDownloadChunkBytes?: number;
    maxConcurrentTransfers: number;
    maxPathLength?: number;
  };
  auth: {
    required: boolean;
    scheme: "none" | "bearer" | "session_nonce";
  };
}

export interface FileCapabilitiesResponse {
  schemaVersion: 1;
  rootPolicy: "project_root_only";
  supportsList: boolean;
  supportsStat: boolean;
  supportsDownload: boolean;
  supportsRangeDownload: boolean;
  supportsUploadChunk: boolean;
  /** Present only on Agents that can cancel a chunked upload and prove it settled. */
  supportsUploadCancel?: boolean;
  supportsSha256: boolean;
  supportsResume: boolean;
  maxUploadChunkBytes: number;
  safeRoots: string[];
}

export interface AgentApiCompatibility {
  pluginExpectedApiVersion: string;
  agentApiVersion: string;
  compatible: boolean;
  missingEndpoints: string[];
  unsupportedFeatures: string[];
  requiredAgentUpgrade: boolean;
}

const requiredEndpoints: Array<keyof AgentCapabilitiesResponse["endpoints"]> = [
  "health",
  "snapshot",
  "sseEvents",
  "fileList",
  "fileDownload",
  "fileUploadChunk",
  "fileTransferStatus",
  "actions",
];

export function validateAgentHealth(value: unknown): value is AgentHealthResponse {
  const item = value as Partial<AgentHealthResponse>;
  return Boolean(
    item &&
    item.schemaVersion === 1 &&
    item.agentVersion &&
    item.apiVersion &&
    item.mode === "realtime" &&
    item.serverTime &&
    item.status,
  );
}

export function validateAgentCapabilities(value: unknown): value is AgentCapabilitiesResponse {
  const item = value as Partial<AgentCapabilitiesResponse>;
  return Boolean(item && item.schemaVersion === 1 && item.apiVersion && item.agentVersion && item.endpoints && item.limits && item.auth);
}

export function validateFileCapabilities(value: unknown): value is FileCapabilitiesResponse {
  const item = value as Partial<FileCapabilitiesResponse>;
  return Boolean(item && item.schemaVersion === 1 && item.rootPolicy === "project_root_only" && Array.isArray(item.safeRoots));
}

export function checkAgentApiCompatibility(
  capabilities: AgentCapabilitiesResponse,
  expectedApiVersion = expectedAgentApiVersion,
): AgentApiCompatibility {
  const missingEndpoints = requiredEndpoints.filter((key) => !capabilities.endpoints[key]);
  const unsupportedFeatures: string[] = [];
  if (!capabilities.endpoints.websocketEvents) unsupportedFeatures.push("websocketEvents");
  if (!capabilities.endpoints.fileRangeDownload) unsupportedFeatures.push("fileRangeDownload");

  const expectedMajor = expectedApiVersion.split(".")[0];
  const agentMajor = String(capabilities.apiVersion).split(".")[0];
  const majorCompatible = expectedMajor === agentMajor;
  return {
    pluginExpectedApiVersion: expectedApiVersion,
    agentApiVersion: capabilities.apiVersion,
    compatible: majorCompatible && missingEndpoints.length === 0,
    missingEndpoints,
    unsupportedFeatures,
    requiredAgentUpgrade: !majorCompatible || missingEndpoints.length > 0,
  };
}
