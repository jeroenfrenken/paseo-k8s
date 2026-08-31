import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { ClusterConnection } from "./kubeconfig.server";

const REQUEST_TIMEOUT_MS = 15_000;

interface StatusLike {
  message?: string;
  reason?: string;
}

/** Carries the API server's own message so callers can show it without the URL. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, apiPath: string, detail: string) {
    super(`${status} on ${apiPath}: ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** GET a path on the API server and return the raw body. */
export function apiGetText(connection: ClusterConnection, apiPath: string): Promise<string> {
  const url = new URL(connection.server + apiPath);
  const secure = url.protocol === "https:";
  const transport = secure ? https : http;

  const headers: Record<string, string> = { accept: "application/json" };
  if (connection.token) headers.authorization = `Bearer ${connection.token}`;
  else if (connection.basicAuth) headers.authorization = `Basic ${connection.basicAuth}`;

  return new Promise<string>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "GET",
        headers,
        ...(secure
          ? {
              ca: connection.ca,
              cert: connection.cert,
              key: connection.key,
              servername: connection.servername,
              rejectUnauthorized: !connection.insecure,
            }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            let detail = body.slice(0, 300);
            try {
              const parsed = JSON.parse(body) as StatusLike;
              if (parsed.message) detail = parsed.message;
            } catch {
              // keep the raw snippet
            }
            reject(new ApiError(status, apiPath, detail));
            return;
          }
          resolve(body);
        });
      },
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s on ${apiPath}`));
    });
    request.on("error", (error: Error) => reject(error));
    request.end();
  });
}

/** GET a path on the API server and parse the JSON body. */
export async function apiGet<T>(connection: ClusterConnection, apiPath: string): Promise<T> {
  const body = await apiGetText(connection, apiPath);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Malformed JSON from ${apiPath}`);
  }
}

/** Scope a collection path to one namespace, or leave it cluster-wide. */
export function scoped(prefix: string, namespace: string | null, resource: string, query = ""): string {
  const base = namespace ? `${prefix}/namespaces/${encodeURIComponent(namespace)}/${resource}` : `${prefix}/${resource}`;
  return query ? `${base}?${query}` : base;
}

export interface ObjectMeta {
  uid?: string;
  name?: string;
  namespace?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  ownerReferences?: { kind?: string; name?: string }[];
}

export interface ListResponse<T> {
  items?: T[];
}

export interface WorkloadResource {
  metadata?: ObjectMeta;
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    template?: { spec?: { containers?: { image?: string }[] } };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    currentReplicas?: number;
    desiredNumberScheduled?: number;
    numberReady?: number;
    updatedNumberScheduled?: number;
    numberAvailable?: number;
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
  };
}

export interface PodResource {
  metadata?: ObjectMeta;
  spec?: { nodeName?: string; containers?: { name?: string }[] };
  status?: {
    phase?: string;
    reason?: string;
    containerStatuses?: {
      ready?: boolean;
      restartCount?: number;
      state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
    }[];
  };
}

export interface EventResource {
  metadata?: ObjectMeta;
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  involvedObject?: { kind?: string; name?: string };
}

export interface MetricsResource {
  metadata?: ObjectMeta;
  containers?: { name?: string; usage?: { cpu?: string; memory?: string } }[];
  usage?: { cpu?: string; memory?: string };
}

export interface NodeResource {
  metadata?: ObjectMeta;
  spec?: { unschedulable?: boolean; taints?: { key?: string; effect?: string }[] };
  status?: {
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
    nodeInfo?: { kubeletVersion?: string };
    conditions?: { type?: string; status?: string; reason?: string }[];
  };
}

export interface VersionResponse {
  gitVersion?: string;
  major?: string;
  minor?: string;
}
