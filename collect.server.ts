import {
  type ClusterEvent,
  type ClusterNode,
  type EnvironmentId,
  type Health,
  type Overview,
  type Pod,
  type Workload,
} from "./contracts";
import { loadConnection, type ClusterConnection } from "./kubeconfig.server";
import {
  ApiError,
  apiGet,
  apiGetText,
  scoped,
  type EventResource,
  type ListResponse,
  type MetricsResource,
  type NodeResource,
  type PodResource,
  type VersionResponse,
  type WorkloadResource,
} from "./k8s-api.server";
import { requireEnvironment } from "./config.server";
import type { PodLogs } from "./contracts";

const LIST_LIMIT = 500;
const EVENT_LIMIT = 40;
/** Ceiling on a single log read, so a chatty container cannot flood the panel. */
const LOG_LIMIT_BYTES = 256_000;

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function connectionFor(
  environmentId: EnvironmentId,
): { connection: ClusterConnection; label: string; isProduction: boolean } {
  const environment = requireEnvironment(environmentId);
  return {
    connection: loadConnection(environment.kubeconfig, environment.context),
    label: environment.label || environment.id,
    isProduction: environment.isProduction,
  };
}

export async function fetchVersion(connection: ClusterConnection): Promise<string | null> {
  const version = await apiGet<VersionResponse>(connection, "/version");
  return version.gitVersion ?? (version.major && version.minor ? `v${version.major}.${version.minor}` : null);
}

export async function fetchNamespaces(connection: ClusterConnection): Promise<string[]> {
  const list = await apiGet<ListResponse<{ metadata?: { name?: string } }>>(
    connection,
    "/api/v1/namespaces?limit=500",
  );
  return (list.items ?? [])
    .map((item) => item.metadata?.name)
    .filter((name): name is string => typeof name === "string")
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Kubernetes CPU quantities: `250m`, `1`, `11074n`, `500u`. Returns millicores.
 */
export function parseCpuMilli(quantity: string | undefined): number | null {
  if (!quantity) return null;
  const match = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(quantity.trim());
  if (!match) return null;
  const value = Number(match[1]);
  switch (match[2]) {
    case "n":
      return value / 1_000_000;
    case "u":
      return value / 1_000;
    case "m":
      return value;
    case "":
      return value * 1000;
    default:
      return null;
  }
}

const MEMORY_UNITS: Record<string, number> = {
  "": 1,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  k: 1000,
};

/** Kubernetes memory quantities: `157572Ki`, `2Gi`, `1000000`. Returns bytes. */
export function parseMemoryBytes(quantity: string | undefined): number | null {
  if (!quantity) return null;
  const match = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(quantity.trim());
  if (!match) return null;
  const unit = MEMORY_UNITS[match[2]];
  return unit === undefined ? null : Number(match[1]) * unit;
}

function sumNullable(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}

function nodeHealth(ready: boolean, schedulable: boolean): Health {
  if (!ready) return "down";
  return schedulable ? "healthy" : "degraded";
}

function shapeNode(resource: NodeResource, podCount: number, usage: MetricsResource | undefined): ClusterNode | null {
  const name = resource.metadata?.name;
  if (!name) return null;

  const conditions = resource.status?.conditions ?? [];
  const ready = conditions.some((condition) => condition.type === "Ready" && condition.status === "True");
  const schedulable = resource.spec?.unschedulable !== true;
  const labels = resource.metadata?.labels ?? {};
  const roles = Object.keys(labels)
    .filter((key) => key.startsWith("node-role.kubernetes.io/"))
    .map((key) => key.slice("node-role.kubernetes.io/".length))
    .filter((role) => role !== "");

  return {
    key: `Node/${name}`,
    name,
    roles: roles.length > 0 ? roles : ["worker"],
    ready,
    schedulable,
    kubeletVersion: resource.status?.nodeInfo?.kubeletVersion ?? null,
    createdAt: resource.metadata?.creationTimestamp ?? null,
    health: nodeHealth(ready, schedulable),
    cpuMilli: parseCpuMilli(usage?.usage?.cpu),
    cpuCapacityMilli: parseCpuMilli(resource.status?.allocatable?.cpu ?? resource.status?.capacity?.cpu),
    memoryBytes: parseMemoryBytes(usage?.usage?.memory),
    memoryCapacityBytes: parseMemoryBytes(
      resource.status?.allocatable?.memory ?? resource.status?.capacity?.memory,
    ),
    podCount,
    conditions: conditions
      .filter((condition) => condition.type !== "Ready" && condition.status === "True")
      .map((condition) => condition.type ?? "")
      .filter((type) => type !== ""),
  };
}

function workloadHealth(desired: number, ready: number, updated: number): Health {
  if (desired === 0) return "unknown";
  if (ready === 0) return "down";
  if (ready < desired) return "degraded";
  if (updated < desired) return "progressing";
  return "healthy";
}

function shapeWorkload(kind: Workload["kind"], resource: WorkloadResource): Workload | null {
  const name = resource.metadata?.name;
  const namespace = resource.metadata?.namespace;
  if (!name || !namespace) return null;

  const status = resource.status ?? {};
  const desired = kind === "DaemonSet" ? (status.desiredNumberScheduled ?? 0) : (resource.spec?.replicas ?? 0);
  const ready = kind === "DaemonSet" ? (status.numberReady ?? 0) : (status.readyReplicas ?? 0);
  const updated = kind === "DaemonSet" ? (status.updatedNumberScheduled ?? 0) : (status.updatedReplicas ?? 0);
  const available = kind === "DaemonSet" ? (status.numberAvailable ?? 0) : (status.availableReplicas ?? 0);

  const failing = (status.conditions ?? []).find(
    (condition) =>
      (condition.type === "Available" && condition.status === "False") ||
      (condition.type === "Progressing" && condition.status === "False"),
  );

  return {
    key: `${kind}/${namespace}/${name}`,
    kind,
    name,
    namespace,
    desired,
    ready,
    updated,
    available,
    restarts: 0,
    images: (resource.spec?.template?.spec?.containers ?? [])
      .map((container) => container.image)
      .filter((image): image is string => typeof image === "string"),
    createdAt: resource.metadata?.creationTimestamp ?? null,
    health: workloadHealth(desired, ready, updated),
    message: failing?.message ?? null,
    cpuMilli: null,
    memoryBytes: null,
  };
}

function podHealth(phase: string, ready: number, total: number, reason: string | null): Health {
  if (reason === "CrashLoopBackOff" || reason === "ImagePullBackOff" || reason === "ErrImagePull") return "down";
  if (phase === "Failed") return "down";
  if (phase === "Succeeded") return "unknown";
  if (phase === "Pending") return "progressing";
  if (phase === "Running") return ready === total && total > 0 ? "healthy" : "degraded";
  return "unknown";
}

function shapePod(resource: PodResource): Pod | null {
  const name = resource.metadata?.name;
  const namespace = resource.metadata?.namespace;
  if (!name || !namespace) return null;

  const containerStatuses = resource.status?.containerStatuses ?? [];
  const total = containerStatuses.length || (resource.spec?.containers?.length ?? 0);
  const ready = containerStatuses.filter((container) => container.ready === true).length;
  const restarts = containerStatuses.reduce((sum, container) => sum + (container.restartCount ?? 0), 0);
  const waiting = containerStatuses.find((container) => container.state?.waiting?.reason)?.state?.waiting?.reason;
  const terminated = containerStatuses.find(
    (container) => container.state?.terminated?.reason && container.state.terminated.reason !== "Completed",
  )?.state?.terminated?.reason;
  const reason = resource.status?.reason ?? waiting ?? terminated ?? null;
  const phase = resource.status?.phase ?? "Unknown";

  return {
    key: `${namespace}/${name}`,
    name,
    namespace,
    phase,
    readyContainers: ready,
    totalContainers: total,
    restarts,
    node: resource.spec?.nodeName ?? null,
    createdAt: resource.metadata?.creationTimestamp ?? null,
    health: podHealth(phase, ready, total, reason),
    reason,
    ownerKey: null,
    containerNames: (resource.spec?.containers ?? [])
      .map((container) => container.name)
      .filter((name): name is string => typeof name === "string"),
    cpuMilli: null,
    memoryBytes: null,
  };
}

function shapeEvent(resource: EventResource): ClusterEvent | null {
  const involved = resource.involvedObject;
  if (!resource.reason) return null;
  return {
    key: resource.metadata?.uid ?? `${resource.metadata?.namespace}/${resource.metadata?.name}`,
    type: resource.type ?? "Warning",
    reason: resource.reason,
    message: (resource.message ?? "").trim(),
    object: involved?.name ? `${involved.kind ?? "Object"}/${involved.name}` : "cluster",
    namespace: resource.metadata?.namespace ?? "",
    count: resource.count ?? 1,
    lastSeen: resource.lastTimestamp ?? resource.eventTime ?? resource.metadata?.creationTimestamp ?? null,
  };
}

function selectorMatches(podLabels: Record<string, string>, matchLabels: Record<string, string>): boolean {
  const entries = Object.entries(matchLabels);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => podLabels[key] === value);
}

const HEALTH_ORDER: Record<Health, number> = { down: 0, degraded: 1, progressing: 2, unknown: 3, healthy: 4 };

export async function buildOverview(
  environmentId: EnvironmentId,
  namespace: string | null,
): Promise<Overview> {
  const { connection, label } = connectionFor(environmentId);
  const warnings: string[] = [];

  async function list<T>(what: string, apiPath: string): Promise<T[]> {
    try {
      const response = await apiGet<ListResponse<T>>(connection, apiPath);
      return response.items ?? [];
    } catch (error) {
      warnings.push(`${what}: ${(error as Error).message}`);
      return [];
    }
  }

  const limit = `limit=${LIST_LIMIT}`;
  // metrics-server and node listing are both optional: a namespace-scoped
  // credential will be refused, and the panel just hides those columns.
  let metricsAvailable = true;
  async function optional<T>(apiPath: string): Promise<T[]> {
    try {
      const response = await apiGet<ListResponse<T>>(connection, apiPath);
      return response.items ?? [];
    } catch {
      return [];
    }
  }

  const [
    version,
    deployments,
    statefulSets,
    daemonSets,
    podResources,
    eventResources,
    nodeResources,
    podMetrics,
    nodeMetrics,
    fluxAvailable,
  ] = await Promise.all([
    fetchVersion(connection).catch((error: Error) => {
      warnings.push(`version: ${error.message}`);
      return null;
    }),
    list<WorkloadResource>("Deployments", scoped("/apis/apps/v1", namespace, "deployments", limit)),
    list<WorkloadResource>("StatefulSets", scoped("/apis/apps/v1", namespace, "statefulsets", limit)),
    list<WorkloadResource>("DaemonSets", scoped("/apis/apps/v1", namespace, "daemonsets", limit)),
    list<PodResource>("Pods", scoped("/api/v1", namespace, "pods", limit)),
    list<EventResource>(
      "Events",
      scoped("/api/v1", namespace, "events", `fieldSelector=type%21%3DNormal&limit=${LIST_LIMIT}`),
    ),
    optional<NodeResource>(`/api/v1/nodes?${limit}`),
    apiGet<ListResponse<MetricsResource>>(
      connection,
      scoped("/apis/metrics.k8s.io/v1beta1", namespace, "pods", limit),
    )
      .then((response) => response.items ?? [])
      .catch(() => {
        metricsAvailable = false;
        return [] as MetricsResource[];
      }),
    optional<MetricsResource>(`/apis/metrics.k8s.io/v1beta1/nodes?${limit}`),
    // One cheap probe so the tab chooser can offer Flux, or explain its absence.
    apiGet<ListResponse<unknown>>(connection, "/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations?limit=1")
      .then(() => true)
      .catch(() => false),
  ]);

  const podUsage = new Map<string, { cpuMilli: number | null; memoryBytes: number | null }>();
  for (const entry of podMetrics) {
    const name = entry.metadata?.name;
    const entryNamespace = entry.metadata?.namespace;
    if (!name || !entryNamespace) continue;
    const containers = entry.containers ?? [];
    podUsage.set(`${entryNamespace}/${name}`, {
      cpuMilli: sumNullable(containers.map((container) => parseCpuMilli(container.usage?.cpu))),
      memoryBytes: sumNullable(containers.map((container) => parseMemoryBytes(container.usage?.memory))),
    });
  }

  const sources: [Workload["kind"], WorkloadResource][] = [
    ...deployments.map((resource): [Workload["kind"], WorkloadResource] => ["Deployment", resource]),
    ...statefulSets.map((resource): [Workload["kind"], WorkloadResource] => ["StatefulSet", resource]),
    ...daemonSets.map((resource): [Workload["kind"], WorkloadResource] => ["DaemonSet", resource]),
  ];

  // Attribute pods to workloads by label selector — pods of a Deployment are
  // owned by its ReplicaSet, so ownerReferences alone would not get us there.
  const workloads: Workload[] = [];
  const selectors: { key: string; namespace: string; matchLabels: Record<string, string> }[] = [];
  for (const [kind, resource] of sources) {
    const workload = shapeWorkload(kind, resource);
    if (!workload) continue;
    workloads.push(workload);
    const matchLabels = resource.spec?.selector?.matchLabels;
    if (matchLabels) {
      selectors.push({ key: workload.key, namespace: workload.namespace, matchLabels });
    }
  }

  const pods: Pod[] = [];
  const restartsByWorkload = new Map<string, number>();
  for (const resource of podResources) {
    const pod = shapePod(resource);
    if (!pod) continue;
    const usage = podUsage.get(pod.key);
    pod.cpuMilli = usage?.cpuMilli ?? null;
    pod.memoryBytes = usage?.memoryBytes ?? null;
    pods.push(pod);
    const podLabels = resource.metadata?.labels ?? {};
    const owner = selectors.find(
      (selector) => selector.namespace === pod.namespace && selectorMatches(podLabels, selector.matchLabels),
    );
    if (owner) {
      pod.ownerKey = owner.key;
      restartsByWorkload.set(owner.key, (restartsByWorkload.get(owner.key) ?? 0) + pod.restarts);
    }
  }
  for (const workload of workloads) {
    workload.restarts = restartsByWorkload.get(workload.key) ?? 0;
    const owned = pods.filter((pod) => pod.ownerKey === workload.key);
    workload.cpuMilli = sumNullable(owned.map((pod) => pod.cpuMilli));
    workload.memoryBytes = sumNullable(owned.map((pod) => pod.memoryBytes));
  }

  const nodeUsage = new Map<string, MetricsResource>();
  for (const entry of nodeMetrics) {
    if (entry.metadata?.name) nodeUsage.set(entry.metadata.name, entry);
  }
  const podsPerNode = new Map<string, number>();
  for (const pod of pods) {
    if (pod.node) podsPerNode.set(pod.node, (podsPerNode.get(pod.node) ?? 0) + 1);
  }
  const nodes = nodeResources
    .map((resource) =>
      shapeNode(
        resource,
        podsPerNode.get(resource.metadata?.name ?? "") ?? 0,
        nodeUsage.get(resource.metadata?.name ?? ""),
      ),
    )
    .filter((node): node is ClusterNode => node !== null)
    .sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name));

  const events = eventResources
    .map((resource) => shapeEvent(resource))
    .filter((event): event is ClusterEvent => event !== null)
    .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))
    .slice(0, EVENT_LIMIT);

  workloads.sort(
    (a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name),
  );
  pods.sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name));

  const phases = { running: 0, pending: 0, succeeded: 0, failed: 0, unknown: 0 };
  for (const pod of pods) {
    if (pod.phase === "Running") phases.running++;
    else if (pod.phase === "Pending") phases.pending++;
    else if (pod.phase === "Succeeded") phases.succeeded++;
    else if (pod.phase === "Failed") phases.failed++;
    else phases.unknown++;
  }

  return {
    environmentId,
    label,
    serverUrl: connection.server,
    contextName: connection.contextName,
    version,
    namespace,
    fetchedAt: new Date().toISOString(),
    summary: {
      workloads: workloads.length,
      healthy: workloads.filter((workload) => workload.health === "healthy").length,
      degraded: workloads.filter((workload) => workload.health === "degraded" || workload.health === "down").length,
      desiredReplicas: workloads.reduce((sum, workload) => sum + workload.desired, 0),
      readyReplicas: workloads.reduce((sum, workload) => sum + workload.ready, 0),
      pods: pods.length,
      restarts: pods.reduce((sum, pod) => sum + pod.restarts, 0),
      warnings: events.length,
    },
    phases,
    workloads,
    pods,
    nodes,
    events,
    metricsAvailable,
    fluxAvailable,
    warnings,
  };
}


export async function fetchPodLogs(
  environmentId: EnvironmentId,
  namespace: string,
  pod: string,
  container: string | null,
  tailLines: number,
  previous: boolean,
): Promise<PodLogs> {
  const { connection } = connectionFor(environmentId);

  const query = new URLSearchParams({
    tailLines: String(Math.max(1, Math.min(5000, Math.trunc(tailLines)))),
    timestamps: "true",
    limitBytes: String(LOG_LIMIT_BYTES),
  });
  if (container) query.set("container", container);
  if (previous) query.set("previous", "true");

  const base: Omit<PodLogs, "lines" | "error"> = {
    namespace,
    pod,
    container: container ?? "",
    previous,
    tailLines,
    fetchedAt: new Date().toISOString(),
  };

  let body: string;
  try {
    body = await apiGetText(
      connection,
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${query.toString()}`,
    );
  } catch (error) {
    // The API server's own wording ("previous terminated container … not found")
    // is what the operator needs; the request URL is not.
    const detail = error instanceof ApiError ? error.detail : (error as Error).message;
    return { ...base, lines: [], error: detail };
  }

  // `timestamps=true` prefixes every line with an RFC3339 stamp and a space.
  const lines = body
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const split = line.indexOf(" ");
      if (split < 0) return { timestamp: null, text: line };
      const head = line.slice(0, split);
      return RFC3339.test(head)
        ? { timestamp: head, text: line.slice(split + 1) }
        : { timestamp: null, text: line };
    });

  return { ...base, lines, error: null };
}
