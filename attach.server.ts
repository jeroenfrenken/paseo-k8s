import {
  type EnvironmentId,
  type Overview,
  type Pod,
  type PluginAttachmentItemLike,
  type Workload,
} from "./contracts";
import { buildOverview, connectionFor, fetchPodLogs } from "./collect.server";
import { listEnvironments } from "./config.server";

const SNAPSHOT_TTL_MS = 20_000;
const MAX_RESULTS = 10;
const LOG_LINES = 80;
/** Per-pod tail when bundling a whole workload, which has several pods. */
const WORKLOAD_LOG_LINES = 50;
const WORKLOAD_LOG_PODS = 4;
/** Ceiling on log reads for one search, so a broad query cannot stampede. */
const LOG_BUDGET = 24;

interface CacheEntry {
  at: number;
  overview: Promise<Overview>;
}
const cache = new Map<EnvironmentId, CacheEntry>();

/**
 * The picker re-searches on every keystroke, so the cluster listing is cached
 * briefly. Logs are still fetched live, but only for the handful of results
 * that actually get returned.
 */
function snapshot(environmentId: EnvironmentId): Promise<Overview> {
  const existing = cache.get(environmentId);
  const now = Date.now();
  if (existing && now - existing.at < SNAPSHOT_TTL_MS) return existing.overview;

  const overview = buildOverview(environmentId, null).catch((error: Error) => {
    cache.delete(environmentId);
    throw error;
  });
  cache.set(environmentId, { at: now, overview });
  return overview;
}

function score(name: string, needle: string): number {
  if (needle === "") return 0;
  const lower = name.toLowerCase();
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  if (lower.includes(needle)) return 2;
  return 3;
}

const UNHEALTHY = new Set(["down", "degraded", "progressing"]);

/**
 * Which pods are worth spending the log budget on: broken first, then live
 * ones, and finished pods (completed Jobs, migrations) last — their logs are
 * rarely what you are asking about.
 */
const LOG_PRIORITY: Record<string, number> = {
  down: 0,
  degraded: 1,
  progressing: 2,
  healthy: 3,
  unknown: 4,
};

/** Short, lowercase cluster tag for the narrow picker rows. */
function shortEnvironment(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "-").slice(0, 12);
}

/**
 * The attachment picker is a fixed-width combobox, so long pod names get
 * ellipsized — and two pods of the same Deployment differ only in their final
 * suffix, so a truncated tail would make them indistinguishable. Collapse the
 * ReplicaSet hash in the middle instead, which is the least informative part.
 * The full name is still what goes into `identifier` and the attached text.
 */
function compactPodName(name: string): string {
  if (name.length <= 32) return name;
  const match = /^(.*)-([0-9a-z]{8,10})-([0-9a-z]{5})$/.exec(name);
  return match ? `${match[1]}-…-${match[3]}` : name;
}

export function podText(pod: Pod, overview: Overview, logs: string): string {
  const events = overview.events
    .filter((event) => event.object.endsWith(`/${pod.name}`))
    .slice(0, 8)
    .map((event) => `- ${event.reason} (${event.count}×): ${event.message}`);

  return [
    `# Pod ${pod.namespace}/${pod.name}`,
    `Environment: ${overview.label} (${overview.contextName})`,
    `Status: ${pod.phase}${pod.reason ? ` — ${pod.reason}` : ""}`,
    `Containers ready: ${pod.readyContainers}/${pod.totalContainers}`,
    `Restarts: ${pod.restarts}`,
    `Node: ${pod.node ?? "unscheduled"}`,
    `Containers: ${pod.containerNames.join(", ") || "unknown"}`,
    pod.cpuMilli !== null ? `CPU: ${pod.cpuMilli.toFixed(1)}m` : null,
    pod.memoryBytes !== null ? `Memory: ${(pod.memoryBytes / 1024 / 1024).toFixed(1)}MiB` : null,
    `Created: ${pod.createdAt ?? "unknown"}`,
    "",
    events.length > 0 ? `## Recent warning events\n${events.join("\n")}` : "## Recent warning events\n(none)",
    "",
    `## Last ${LOG_LINES} log lines`,
    logs.trim() === "" ? "(no output)" : logs,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function workloadText(
  workload: Workload,
  overview: Overview,
  logsByPod: Map<string, string> = new Map(),
): string {
  const pods = overview.pods.filter((pod) => pod.ownerKey === workload.key);
  const events = overview.events
    .filter((event) => pods.some((pod) => event.object.endsWith(`/${pod.name}`)))
    .slice(0, 8)
    .map((event) => `- ${event.reason} (${event.count}×): ${event.message}`);

  // Logs from every pod that was read, each labelled, so an agent asked about
  // "the api pods" gets all of them rather than one arbitrary pod.
  const logSections = pods
    .filter((pod) => logsByPod.has(pod.key))
    .map((pod) => {
      const body = (logsByPod.get(pod.key) ?? "").trim();
      return `### ${pod.name}\n${body === "" ? "(no output)" : body}`;
    });

  return [
    `# ${workload.kind} ${workload.namespace}/${workload.name}`,
    `Environment: ${overview.label} (${overview.contextName})`,
    `Replicas: ${workload.ready}/${workload.desired} ready, ${workload.updated} updated, ${workload.available} available`,
    `Health: ${workload.health}`,
    workload.message ? `Condition: ${workload.message}` : null,
    `Restarts across pods: ${workload.restarts}`,
    `Images:\n${workload.images.map((image) => `  - ${image}`).join("\n") || "  (none)"}`,
    `Created: ${workload.createdAt ?? "unknown"}`,
    "",
    `## Pods (${pods.length})`,
    pods.length === 0
      ? "(none)"
      : pods
          .map(
            (pod) =>
              `- ${pod.name} — ${pod.phase}${pod.reason ? ` (${pod.reason})` : ""}, ` +
              `${pod.readyContainers}/${pod.totalContainers} ready, ${pod.restarts} restarts, node ${pod.node ?? "?"}`,
          )
          .join("\n"),
    "",
    events.length > 0 ? `## Recent warning events\n${events.join("\n")}` : "## Recent warning events\n(none)",
    logSections.length > 0
      ? `\n## Logs, last ${WORKLOAD_LOG_LINES} lines per pod (${logSections.length} of ${pods.length} pods)\n\n${logSections.join("\n\n")}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

interface Candidate {
  environmentId: EnvironmentId;
  overview: Overview;
  pod?: Pod;
  workload?: Workload;
  rank: number;
}

/**
 * Search pods and workloads across both environments and return them as
 * composer attachments, each carrying enough context (status, events, logs)
 * to prompt an agent without any copy-paste.
 */
export async function searchAttachments(query: string): Promise<{ items: PluginAttachmentItemLike[] }> {
  const needle = query.trim().toLowerCase();

  const overviews = await Promise.all(
    listEnvironments()
      .filter((environment) => environment.kubeconfig !== "")
      .map(async (environment) => {
        try {
          return { environmentId: environment.id, overview: await snapshot(environment.id) };
        } catch {
          // An unconfigured or unreachable cluster simply contributes nothing.
          return null;
        }
      }),
  );

  const candidates: Candidate[] = [];
  for (const entry of overviews) {
    if (!entry) continue;
    const { environmentId, overview } = entry;
    for (const workload of overview.workloads) {
      const rank = score(workload.name, needle);
      if (rank === 3) continue;
      candidates.push({ environmentId, overview, workload, rank });
    }
    for (const pod of overview.pods) {
      const rank = score(pod.name, needle);
      if (rank === 3) continue;
      candidates.push({ environmentId, overview, pod, rank });
    }
  }

  candidates.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    // Surface trouble first: a broken pod is usually what you meant to ask about.
    const leftBad = UNHEALTHY.has(left.pod?.health ?? left.workload?.health ?? "") ? 0 : 1;
    const rightBad = UNHEALTHY.has(right.pod?.health ?? right.workload?.health ?? "") ? 0 : 1;
    if (leftBad !== rightBad) return leftBad - rightBad;
    const leftName = left.pod?.name ?? left.workload?.name ?? "";
    const rightName = right.pod?.name ?? right.workload?.name ?? "";
    return leftName.localeCompare(rightName);
  });

  const selected = candidates.slice(0, MAX_RESULTS);

  let logBudget = LOG_BUDGET;
  const takeBudget = () => (logBudget > 0 ? (logBudget -= 1, true) : false);

  const items = await Promise.all(
    selected.map(async (candidate): Promise<PluginAttachmentItemLike> => {
      const { environmentId, overview } = candidate;
      const base = overview.serverUrl;

      if (candidate.pod) {
        const pod = candidate.pod;
        const logs = takeBudget()
          ? await podLogTail(environmentId, pod, LOG_LINES)
          : "(logs skipped: too many results, narrow the search)";
        return {
          id: `${environmentId}:pod:${pod.key}`,
          identifier: `${environmentId}/${pod.namespace}/${pod.name}`,
          title: compactPodName(pod.name),
          // Kept short on purpose: the picker is narrow and truncates.
          subtitle: [
            shortEnvironment(overview.label),
            pod.namespace,
            pod.reason ?? pod.phase,
            pod.restarts > 0 ? `↻${pod.restarts}` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(" · "),
          url: `${base}/api/v1/namespaces/${encodeURIComponent(pod.namespace)}/pods/${encodeURIComponent(pod.name)}`,
          text: podText(pod, overview, logs),
          resourceType: "kubernetes-pod",
        };
      }

      const workload = candidate.workload!;
      const ownPods = overview.pods
        .filter((pod) => pod.ownerKey === workload.key)
        .sort((left, right) => (LOG_PRIORITY[left.health] ?? 5) - (LOG_PRIORITY[right.health] ?? 5))
        .slice(0, WORKLOAD_LOG_PODS)
        .filter(() => takeBudget());

      const logsByPod = new Map<string, string>(
        await Promise.all(
          ownPods.map(
            async (pod) =>
              [pod.key, await podLogTail(environmentId, pod, WORKLOAD_LOG_LINES)] as [string, string],
          ),
        ),
      );

      return {
        id: `${environmentId}:workload:${workload.key}`,
        identifier: `${environmentId}/${workload.namespace}/${workload.name}`,
        title: workload.name,
        subtitle: [
          shortEnvironment(overview.label),
          workload.namespace,
          workload.kind,
          `${workload.ready}/${workload.desired}`,
        ].join(" · "),
        url: `${base}/apis/apps/v1/namespaces/${encodeURIComponent(workload.namespace)}/${workload.kind.toLowerCase()}s/${encodeURIComponent(workload.name)}`,
        text: workloadText(workload, overview, logsByPod),
        resourceType: "kubernetes-workload",
      };
    }),
  );

  return { items };
}

/** Fetch the log tail used in a pod's context bundle, tolerating failure. */
export async function podLogTail(
  environmentId: EnvironmentId,
  pod: Pod,
  lines: number = LOG_LINES,
): Promise<string> {
  try {
    const result = await fetchPodLogs(
      environmentId,
      pod.namespace,
      pod.name,
      pod.containerNames[0] ?? null,
      lines,
      false,
    );
    return result.error
      ? `(logs unavailable: ${result.error})`
      : result.lines.map((line) => line.text).join("\n");
  } catch (error) {
    return `(logs unavailable: ${(error as Error).message})`;
  }
}

export { snapshot as cachedOverview };

export function primeAttachmentCache(): void {
  for (const environment of listEnvironments()) {
    try {
      connectionFor(environment.id);
      void snapshot(environment.id);
    } catch {
      // Not configured yet — nothing to prime.
    }
  }
}
