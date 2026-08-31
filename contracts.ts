import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Shared RPC contracts. This module is imported by both the daemon side
 * (index.ts) and the UI side (main.client.tsx), so it must never import
 * anything from node: — keep it to zod and the plugin SDK.
 */

/** Cluster ids are user-chosen slugs; there is no fixed set of environments. */
export const EnvironmentIdSchema = z.string().min(1);
export type EnvironmentId = z.infer<typeof EnvironmentIdSchema>;

export const EnvironmentSchema = z.object({
  id: EnvironmentIdSchema,
  label: z.string(),
  /** Absolute path to a kubeconfig file. `~` is expanded. */
  kubeconfig: z.string(),
  /** Context to use inside that kubeconfig; null means `current-context`. */
  context: z.string().nullable(),
  /** Namespace the panel opens on; null means "all namespaces". */
  namespace: z.string().nullable(),
  /** Marks the cluster as production: red accent, and shown as such everywhere. */
  isProduction: z.boolean(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

/** Turn a label into a stable, unique id. */
export function slugifyEnvironmentId(label: string, taken: readonly string[] = []): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "cluster";
  if (!taken.includes(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base}-${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export const SettingsSchema = z.object({
  /** Optional checkout of the GitOps repo, for naming deployed revisions. */
  fluxRepoPath: z.string().nullable(),
  /** Binaries the command bar may run in allowlist mode. */
  commandAllowlist: z.array(z.string()),
  /**
   * How the command bar executes what you type.
   *  - `allowlist`: split into argv, first word must be allowlisted, no shell.
   *  - `bash`: the whole line goes to `bash -lc`.
   */
  commandMode: z.enum(["allowlist", "bash"]),
  /** Seconds before a command is killed. */
  commandTimeoutSeconds: z.number(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  fluxRepoPath: null,
  commandAllowlist: ["kubectl", "helm", "kustomize"],
  commandMode: "allowlist",
  commandTimeoutSeconds: 60,
};

export const ConfigStateSchema = z.object({
  settings: SettingsSchema,
  /** Convenience mirror of settings.fluxRepoPath. */
  fluxRepoPath: z.string().nullable(),
  /** The clusters.json the daemon is currently reading and writing. */
  configPath: z.string(),
  configExists: z.boolean(),
  /** Where the environment list came from. */
  source: z.enum(["config-file", "env-var", "discovered", "empty"]),
  environments: z.array(EnvironmentSchema),
  /** Non-fatal problems, e.g. "staging kubeconfig not found". */
  issues: z.array(z.object({ environmentId: z.string(), message: z.string() })),
});
export type ConfigState = z.infer<typeof ConfigStateSchema>;

export const KubeconfigInfoSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  contexts: z.array(z.string()),
  currentContext: z.string().nullable(),
  error: z.string().nullable(),
});
export type KubeconfigInfo = z.infer<typeof KubeconfigInfoSchema>;

export const ConnectionCheckSchema = z.object({
  ok: z.boolean(),
  serverUrl: z.string().nullable(),
  contextName: z.string().nullable(),
  version: z.string().nullable(),
  authMethod: z.string().nullable(),
  message: z.string(),
});

export const HealthSchema = z.enum(["healthy", "progressing", "degraded", "down", "unknown"]);
export type Health = z.infer<typeof HealthSchema>;

export const WorkloadSchema = z.object({
  key: z.string(),
  kind: z.enum(["Deployment", "StatefulSet", "DaemonSet"]),
  name: z.string(),
  namespace: z.string(),
  desired: z.number(),
  ready: z.number(),
  updated: z.number(),
  available: z.number(),
  restarts: z.number(),
  images: z.array(z.string()),
  createdAt: z.string().nullable(),
  health: HealthSchema,
  message: z.string().nullable(),
  /** Summed across the workload's pods; null when metrics-server is absent. */
  cpuMilli: z.number().nullable(),
  memoryBytes: z.number().nullable(),
});
export type Workload = z.infer<typeof WorkloadSchema>;

export const PodSchema = z.object({
  key: z.string(),
  name: z.string(),
  namespace: z.string(),
  phase: z.string(),
  readyContainers: z.number(),
  totalContainers: z.number(),
  restarts: z.number(),
  node: z.string().nullable(),
  createdAt: z.string().nullable(),
  health: HealthSchema,
  reason: z.string().nullable(),
  ownerKey: z.string().nullable(),
  containerNames: z.array(z.string()),
  cpuMilli: z.number().nullable(),
  memoryBytes: z.number().nullable(),
});
export type Pod = z.infer<typeof PodSchema>;

export const LOG_TAIL_OPTIONS = [100, 500, 2000] as const;

export const PodLogsSchema = z.object({
  namespace: z.string(),
  pod: z.string(),
  /** Empty when the pod has a single container and none was requested. */
  container: z.string(),
  previous: z.boolean(),
  tailLines: z.number(),
  fetchedAt: z.string(),
  lines: z.array(z.object({ timestamp: z.string().nullable(), text: z.string() })),
  /** Set when the API server refused; `lines` is empty in that case. */
  error: z.string().nullable(),
});
export type PodLogs = z.infer<typeof PodLogsSchema>;

export const NodeSchema = z.object({
  key: z.string(),
  name: z.string(),
  roles: z.array(z.string()),
  ready: z.boolean(),
  schedulable: z.boolean(),
  kubeletVersion: z.string().nullable(),
  createdAt: z.string().nullable(),
  health: HealthSchema,
  cpuMilli: z.number().nullable(),
  cpuCapacityMilli: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  memoryCapacityBytes: z.number().nullable(),
  podCount: z.number(),
  conditions: z.array(z.string()),
});
export type ClusterNode = z.infer<typeof NodeSchema>;

export const ClusterEventSchema = z.object({
  key: z.string(),
  type: z.string(),
  reason: z.string(),
  message: z.string(),
  object: z.string(),
  namespace: z.string(),
  count: z.number(),
  lastSeen: z.string().nullable(),
});
export type ClusterEvent = z.infer<typeof ClusterEventSchema>;

export const OverviewSchema = z.object({
  environmentId: EnvironmentIdSchema,
  label: z.string(),
  serverUrl: z.string(),
  contextName: z.string(),
  version: z.string().nullable(),
  namespace: z.string().nullable(),
  fetchedAt: z.string(),
  summary: z.object({
    workloads: z.number(),
    healthy: z.number(),
    degraded: z.number(),
    desiredReplicas: z.number(),
    readyReplicas: z.number(),
    pods: z.number(),
    restarts: z.number(),
    warnings: z.number(),
  }),
  phases: z.object({
    running: z.number(),
    pending: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    unknown: z.number(),
  }),
  workloads: z.array(WorkloadSchema),
  pods: z.array(PodSchema),
  nodes: z.array(NodeSchema),
  events: z.array(ClusterEventSchema),
  /** True when metrics-server answered, so the UI can hide empty CPU columns. */
  metricsAvailable: z.boolean(),
  /** True when the Flux CRDs are installed, so the tab chooser can say so. */
  fluxAvailable: z.boolean(),
  /** Partial-failure notes, e.g. RBAC denied DaemonSets. */
  warnings: z.array(z.string()),
});
export type Overview = z.infer<typeof OverviewSchema>;

/** Mirrors the SDK's PluginAttachmentItem so the handler can be typed. */
export const AttachmentItemSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  url: z.url(),
  text: z.string(),
  resourceType: z.string(),
});
export type PluginAttachmentItemLike = z.infer<typeof AttachmentItemSchema>;

export const searchClusterAttachments = defineRpc({
  name: "k8s.attachments.search",
  // The picker supplies the typed query; keep it optional so an empty open works.
  input: z.object({ query: z.string().optional() }),
  output: z.object({ items: z.array(AttachmentItemSchema) }),
});

export const AgentTargetsSchema = z.object({
  /** Projects a fresh workspace can be created in. */
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      rootPath: z.string(),
      /** Only git projects can get a worktree. */
      supportsWorktree: z.boolean(),
    }),
  ),
  /** The daemon's provider catalogue, each with its selectable models. */
  providers: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      models: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          description: z.string().nullable(),
          isDefault: z.boolean(),
        }),
      ),
    }),
  ),
  error: z.string().nullable(),
});

export const listAgentTargets = defineRpc({
  name: "k8s.agent.targets",
  input: z.object({}),
  output: AgentTargetsSchema,
});

export const launchAgent = defineRpc({
  name: "k8s.agent.launch",
  input: z.object({
    environmentId: EnvironmentIdSchema,
    /** Selection key from the list: `Deployment/ns/name`, `ns/pod`, `Node/name`. */
    resourceKey: z.string(),
    projectId: z.string(),
    /** A fresh workspace is always created; this picks how it is isolated. */
    isolation: z.enum(["worktree", "directory"]),
    provider: z.string(),
    instruction: z.string(),
  }),
  output: z.object({
    ok: z.boolean(),
    agentId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    title: z.string().nullable(),
    message: z.string(),
  }),
});

export const getConfig = defineRpc({
  name: "k8s.config.get",
  input: z.object({}),
  output: ConfigStateSchema,
});

export const saveConfig = defineRpc({
  name: "k8s.config.save",
  input: z.object({
    environments: z.array(EnvironmentSchema),
    settings: SettingsSchema.optional(),
  }),
  output: ConfigStateSchema,
});

/** Point the plugin at a different clusters.json instead of the default path. */
export const pointAtConfigFile = defineRpc({
  name: "k8s.config.point",
  input: z.object({ path: z.string() }),
  output: ConfigStateSchema,
});

export const resetConfigPointer = defineRpc({
  name: "k8s.config.reset",
  input: z.object({}),
  output: ConfigStateSchema,
});

/** Read a kubeconfig from disk so the UI can offer a context picker. */
export const inspectKubeconfig = defineRpc({
  name: "k8s.kubeconfig.inspect",
  input: z.object({ path: z.string() }),
  output: KubeconfigInfoSchema,
});

export const checkConnection = defineRpc({
  name: "k8s.connection.check",
  input: z.object({ environmentId: EnvironmentIdSchema }),
  output: ConnectionCheckSchema,
});

export const listNamespaces = defineRpc({
  name: "k8s.namespaces.list",
  input: z.object({ environmentId: EnvironmentIdSchema }),
  output: z.object({ namespaces: z.array(z.string()) }),
});

export const getPodLogs = defineRpc({
  name: "k8s.pod.logs",
  input: z.object({
    environmentId: EnvironmentIdSchema,
    namespace: z.string(),
    pod: z.string(),
    container: z.string().nullable(),
    tailLines: z.number(),
    /** Read the previous, terminated container — the one that crash-looped. */
    previous: z.boolean(),
  }),
  output: PodLogsSchema,
});

export const DEFAULT_ALLOWED_BINARIES = ["kubectl", "helm", "kustomize"] as const;

export const CommandResultSchema = z.object({
  /** Exactly what was executed, for the transcript header. */
  display: z.string(),
  environmentId: EnvironmentIdSchema,
  kubeconfig: z.string(),
  contextName: z.string().nullable(),
  namespace: z.string().nullable(),
  mode: z.enum(["allowlist", "bash"]),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  /** Set when the command was refused before running (allowlist, missing binary). */
  refused: z.string().nullable(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const runCommand = defineRpc({
  name: "k8s.command.run",
  input: z.object({
    environmentId: EnvironmentIdSchema,
    command: z.string(),
    namespace: z.string().nullable(),
  }),
  output: CommandResultSchema,
});

export const FluxKindSchema = z.enum([
  "GitRepository",
  "HelmRepository",
  "Kustomization",
  "HelmRelease",
  "ImagePolicy",
]);
export type FluxKind = z.infer<typeof FluxKindSchema>;

export const FluxResourceSchema = z.object({
  key: z.string(),
  kind: FluxKindSchema,
  name: z.string(),
  namespace: z.string(),
  /** null when the resource has no Ready condition yet. */
  ready: z.boolean().nullable(),
  suspended: z.boolean(),
  message: z.string(),
  /** Applied git revision, chart version, or artifact revision. */
  revision: z.string().nullable(),
  /** Path, chart name or repository URL — whatever identifies the input. */
  source: z.string().nullable(),
  lastReconciled: z.string().nullable(),
  /** ImagePolicy only: the newest image the policy resolves to. */
  latestImage: z.string().nullable(),
});
export type FluxResource = z.infer<typeof FluxResourceSchema>;

export const GitStatusSchema = z.object({
  repoPath: z.string(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  /** Cluster revision found in the local clone? */
  clusterRevisionKnown: z.boolean(),
  aheadCount: z.number(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
  note: z.string().nullable(),
});

export const FluxSnapshotSchema = z.object({
  environmentId: EnvironmentIdSchema,
  /** False when the Flux CRDs are not installed at all. */
  available: z.boolean(),
  fetchedAt: z.string(),
  clusterRevision: z.string().nullable(),
  resources: z.array(FluxResourceSchema),
  git: GitStatusSchema.nullable(),
  warnings: z.array(z.string()),
});
export type FluxSnapshot = z.infer<typeof FluxSnapshotSchema>;

export const getFlux = defineRpc({
  name: "k8s.flux.get",
  input: z.object({ environmentId: EnvironmentIdSchema }),
  output: FluxSnapshotSchema,
});

export const runFluxAction = defineRpc({
  name: "k8s.flux.action",
  input: z.object({
    environmentId: EnvironmentIdSchema,
    action: z.enum(["reconcile", "suspend", "resume"]),
    kind: FluxKindSchema,
    name: z.string(),
    namespace: z.string(),
  }),
  output: CommandResultSchema,
});

export const ToolReportSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      path: z.string().nullable(),
      version: z.string().nullable(),
      /** How much the panel needs it. Nothing here is needed to browse. */
      requirement: z.enum(["recommended", "optional"]),
      /** What having it unlocks. */
      purpose: z.string(),
      /** Shown only when it is missing. */
      installHint: z.string(),
    }),
  ),
});
export type ToolReport = z.infer<typeof ToolReportSchema>;

export const checkTooling = defineRpc({
  name: "k8s.tooling.report",
  input: z.object({}),
  output: ToolReportSchema,
});

export const getToolingStatus = defineRpc({
  name: "k8s.tooling.status",
  input: z.object({}),
  output: z.object({
    allowed: z.array(z.object({ name: z.string(), path: z.string().nullable(), version: z.string().nullable() })),
    shellPath: z.string().nullable(),
  }),
});

export const getOverview = defineRpc({
  name: "k8s.overview",
  input: z.object({
    environmentId: EnvironmentIdSchema,
    namespace: z.string().nullable(),
  }),
  output: OverviewSchema,
});
