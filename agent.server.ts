import type { EnvironmentId, Overview } from "./contracts";
import { cachedOverview, podLogTail, podText, workloadText } from "./attach.server";
import { formatNodeContext } from "./node-context.server";

/**
 * The slice of PaseoApi this plugin uses.
 *
 * The installed @getpaseo/client is older than the SDK declarations, so
 * `PaseoApi` widens to `any` and the compiler cannot check these calls. Declaring
 * the shape here restores some discipline and documents exactly what we depend on.
 */
export interface AgentCreateOptions {
  config: { provider: string };
  title?: string;
  prompt?: string;
  labels?: Record<string, string>;
}

export interface WorkspaceHandleLike {
  readonly id: string;
  readonly directory: string | null;
  readonly name: string | null;
  agents: { create(options: AgentCreateOptions): Promise<{ id?: string } | string> };
}

export interface ProviderCatalogueSlice {
  snapshot(options?: unknown): Promise<unknown>;
  listAvailable(options?: unknown): Promise<unknown>;
  listModels(provider: string, options?: unknown): Promise<unknown>;
}

export interface PaseoAgentSlice {
  providers: ProviderCatalogueSlice;
  workspaces: {
    list(options?: unknown): Promise<unknown>;
    /** `source` follows the daemon's WorkspaceCreateRequest shape. */
    create(options: { source: Record<string, unknown>; title?: string }): Promise<WorkspaceHandleLike>;
  };
  agents: {
    list(options?: unknown): Promise<unknown>;
  };
}

/**
 * Observed keys from a real `workspaces.list()` response:
 *   id, projectId, projectDisplayName, projectCustomName, projectRootPath,
 *   workspaceDirectory, worktreeSlug, projectKind, workspaceKind, name, title,
 *   pinnedAt, archivingAt, status, statusEnteredAt, activityAt, diffStat, …
 *
 * Note the directory is `workspaceDirectory` here, even though the SDK's
 * PluginWorkspaceSnapshot type calls the same value `directory`. Accept both.
 */
interface WorkspaceLike {
  id?: string;
  name?: string;
  title?: string | null;
  workspaceDirectory?: string;
  directory?: string;
  cwd?: string;
  projectRootPath?: string;
  projectDisplayName?: string;
  projectCustomName?: string;
  projectId?: string;
}

/**
 * Observed shape of `providers.snapshot()`:
 *   { providers: [ { id, label, description, enabled, status, modes: [...] } ] }
 * and of `providers.listModels(id)`:
 *   { provider, models: [ { id, label, description, isDefault } ] }
 */
interface ProviderLike {
  id?: string;
  label?: string;
  enabled?: boolean;
  status?: string;
}

interface ModelLike {
  id?: string;
  label?: string;
  description?: string;
  isDefault?: boolean;
}

export interface ProviderTarget {
  id: string;
  label: string;
  models: { id: string; label: string; description: string | null; isDefault: boolean }[];
}

interface ProjectLike {
  id?: string;
  projectId?: string;
  name?: string;
  displayName?: string;
  projectDisplayName?: string;
  projectCustomName?: string;
  rootPath?: string;
  projectRootPath?: string;
  kind?: string;
  projectKind?: string;
}

export interface ProjectTarget {
  id: string;
  name: string;
  rootPath: string;
  supportsWorktree: boolean;
}

function toProject(entry: ProjectLike): ProjectTarget | null {
  const id = entry.projectId ?? entry.id ?? "";
  if (id === "") return null;
  const kind = entry.projectKind ?? entry.kind ?? "";
  return {
    id,
    name:
      entry.projectCustomName ||
      entry.projectDisplayName ||
      entry.displayName ||
      entry.name ||
      id,
    rootPath: entry.projectRootPath ?? entry.rootPath ?? "",
    supportsWorktree: kind === "git",
  };
}

/**
 * Both list endpoints return `{ requestId, entries, pageInfo }`. The other keys
 * are tolerated because this API is untyped here (see PaseoAgentSlice) and has
 * changed shape across versions — getting this wrong fails silently as "no
 * workspaces found", so accept anything array-shaped.
 */
function unwrap<T>(response: unknown, key: string): T[] {
  if (Array.isArray(response)) return response as T[];
  if (response !== null && typeof response === "object") {
    const record = response as Record<string, unknown>;
    for (const candidate of ["entries", key, "items", "results"]) {
      if (Array.isArray(record[candidate])) return record[candidate] as T[];
    }
  }
  return [];
}

const FALLBACK_PROVIDER: ProviderTarget = {
  id: "claude",
  label: "Claude",
  models: [{ id: "claude-opus-5", label: "Opus 5", description: null, isDefault: true }],
};

/**
 * The real provider catalogue, so the picker offers every model the daemon can
 * actually run. An earlier version derived this from the providers already in
 * use on existing agents, which meant the list was usually just whatever was
 * running — normally Claude alone.
 */
async function loadProviders(paseo: PaseoAgentSlice, errors: string[]): Promise<ProviderTarget[]> {
  let raw: ProviderLike[] = [];
  try {
    raw = unwrap<ProviderLike>(await paseo.providers.snapshot(), "providers");
    if (raw.length === 0) {
      raw = unwrap<ProviderLike>(await paseo.providers.listAvailable(), "providers");
    }
  } catch (error) {
    console.log(`[k8s] providers.snapshot() threw: ${(error as Error).message}`);
  }

  const usable = raw.filter(
    (provider) => provider.id && provider.enabled !== false && provider.status !== "unavailable",
  );
  if (usable.length === 0) {
    errors.push("No agent providers reported by the daemon; falling back to Claude.");
    return [FALLBACK_PROVIDER];
  }

  const withModels = await Promise.all(
    usable.map(async (provider): Promise<ProviderTarget> => {
      const id = provider.id as string;
      let models: ModelLike[] = [];
      try {
        models = unwrap<ModelLike>(await paseo.providers.listModels(id), "models");
      } catch (error) {
        console.log(`[k8s] providers.listModels(${id}) threw: ${(error as Error).message}`);
      }
      return {
        id,
        label: provider.label ?? id,
        models: models
          .filter((model) => typeof model.id === "string")
          .map((model) => ({
            id: model.id as string,
            label: model.label ?? (model.id as string),
            description: model.description ?? null,
            isDefault: model.isDefault === true,
          })),
      };
    }),
  );

  // A provider with no models cannot be launched into, so drop it rather than
  // offering a dead entry.
  const offerable = withModels.filter((provider) => provider.models.length > 0);
  return offerable.length > 0 ? offerable : [FALLBACK_PROVIDER];
}

/** Compact description of an unknown payload, for diagnosing shape mismatches. */
function describeShape(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .map((key) => `${key}:${Array.isArray(record[key]) ? `array(${(record[key] as unknown[]).length})` : typeof record[key]}`)
    .join(", ")}}`;
}

export async function listAgentTargets(paseo: PaseoAgentSlice) {
  const errors: string[] = [];

  // Every launch creates a fresh workspace, so what the UI needs is the list of
  // projects. There is no projects endpoint on PaseoApi, but the workspace
  // listing carries project fields on each entry plus an `emptyProjects` array
  // for projects that have no workspaces yet.
  let projects: ProjectTarget[] = [];
  try {
    const response = await paseo.workspaces.list();
    const entries = unwrap<ProjectLike>(response, "workspaces");
    const empty =
      response !== null && typeof response === "object" && Array.isArray((response as Record<string, unknown>).emptyProjects)
        ? ((response as Record<string, unknown>).emptyProjects as ProjectLike[])
        : [];

    const byId = new Map<string, ProjectTarget>();
    for (const entry of [...entries, ...empty]) {
      const project = toProject(entry);
      if (project && project.rootPath !== "" && !byId.has(project.id)) byId.set(project.id, project);
    }
    projects = [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));

    if (projects.length === 0) {
      const sample = entries[0] ? `first entry keys: ${Object.keys(entries[0]).join(",")}` : "no entries";
      const detail = `workspaces.list() returned ${describeShape(response)}; ${sample}`;
      console.log(`[k8s] ${detail}`);
      errors.push(detail);
    }
  } catch (error) {
    const detail = `workspaces.list() threw: ${(error as Error).message}`;
    console.log(`[k8s] ${detail}`);
    errors.push(detail);
  }

  const providers = await loadProviders(paseo, errors);

  return { projects, providers, error: errors.length > 0 ? errors.join(" · ") : null };
}

/** Rebuild the same context bundle the attachment picker produces. */
async function contextFor(
  environmentId: EnvironmentId,
  resourceKey: string,
): Promise<{ heading: string; body: string; environmentLabel: string } | null> {
  const overview: Overview = await cachedOverview(environmentId);
  const environmentLabel = overview.label;

  const workload = overview.workloads.find((entry) => entry.key === resourceKey);
  if (workload) {
    return {
      environmentLabel,
      heading: `${workload.kind} ${workload.namespace}/${workload.name}`,
      body: workloadText(workload, overview),
    };
  }

  const pod = overview.pods.find((entry) => entry.key === resourceKey);
  if (pod) {
    return {
      environmentLabel,
      heading: `Pod ${pod.namespace}/${pod.name}`,
      body: podText(pod, overview, await podLogTail(environmentId, pod)),
    };
  }

  const node = overview.nodes.find((entry) => entry.key === resourceKey);
  if (node) {
    return { environmentLabel, heading: `Node ${node.name}`, body: formatNodeContext(node, overview) };
  }

  return null;
}

export async function launchAgent(
  paseo: PaseoAgentSlice,
  input: {
    environmentId: EnvironmentId;
    resourceKey: string;
    projectId: string;
    isolation: "worktree" | "directory";
    provider: string;
    instruction: string;
  },
) {
  const failure = (message: string) => ({
    ok: false,
    agentId: null,
    workspaceId: null,
    title: null,
    message,
  });

  const targets = await listAgentTargets(paseo);
  const project = targets.projects.find((entry) => entry.id === input.projectId);
  if (!project) return failure("Pick a project to create the workspace in.");
  if (input.isolation === "worktree" && !project.supportsWorktree) {
    return failure(`${project.name} is not a git project, so it cannot use a worktree.`);
  }

  const context = await contextFor(input.environmentId, input.resourceKey);
  if (!context) return failure("That resource is no longer in the current snapshot — refresh and try again.");

  const instruction = input.instruction.trim() || "Investigate this and tell me what is wrong.";
  const label = context.environmentLabel;
  const title = `${label}: ${context.heading}`;

  const prompt = [
    instruction,
    "",
    `Context below is a live read from the ${label} Kubernetes cluster, captured just now.`,
    "",
    context.body,
  ].join("\n");

  // Matches the shapes the daemon's WorkspaceCreateRequest accepts: a
  // `directory` source needs a path, a `worktree` source branches off the
  // project's default branch.
  const source: Record<string, unknown> =
    input.isolation === "worktree"
      ? { kind: "worktree", projectId: project.id, action: "branch-off" }
      : { kind: "directory", projectId: project.id, path: project.rootPath };

  let workspace: WorkspaceHandleLike;
  try {
    workspace = await paseo.workspaces.create({ source, title });
  } catch (error) {
    return failure(`Could not create a workspace in ${project.name}: ${(error as Error).message}`);
  }

  try {
    const created = await workspace.agents.create({
      config: { provider: input.provider },
      title,
      prompt,
      labels: {
        source: "k8s-plugin",
        environment: input.environmentId,
        resource: input.resourceKey,
      },
    });
    const agentId = typeof created === "string" ? created : (created?.id ?? null);
    return {
      ok: true,
      agentId,
      workspaceId: workspace.id,
      title,
      message: `Agent started in a new ${input.isolation === "worktree" ? "worktree" : "workspace"} on ${project.name}.`,
    };
  } catch (error) {
    return {
      ...failure(`Workspace ${workspace.name ?? workspace.id} was created, but the agent did not start: ${(error as Error).message}`),
      workspaceId: workspace.id,
    };
  }
}
