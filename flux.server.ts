import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvironmentId, FluxKind, FluxResource, FluxSnapshot } from "./contracts";
import { connectionFor } from "./collect.server";
import { apiGet, type ListResponse, type ObjectMeta } from "./k8s-api.server";
import { expandHome } from "./kubeconfig.server";
import { resolveBinary, runShellCommand } from "./exec.server";

const LIST_LIMIT = 500;
const GIT_TIMEOUT_MS = 10_000;
const MAX_COMMITS = 20;

/** Every Flux kind we surface, with the API path it lives at. */
const FLUX_KINDS: { kind: FluxKind; apiPath: string }[] = [
  { kind: "GitRepository", apiPath: "/apis/source.toolkit.fluxcd.io/v1/gitrepositories" },
  { kind: "HelmRepository", apiPath: "/apis/source.toolkit.fluxcd.io/v1/helmrepositories" },
  { kind: "Kustomization", apiPath: "/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations" },
  { kind: "HelmRelease", apiPath: "/apis/helm.toolkit.fluxcd.io/v2/helmreleases" },
  { kind: "ImagePolicy", apiPath: "/apis/image.toolkit.fluxcd.io/v1beta2/imagepolicies" },
];

interface FluxCondition {
  type?: string;
  status?: string;
  message?: string;
  reason?: string;
  lastTransitionTime?: string;
}

interface FluxObject {
  metadata?: ObjectMeta;
  spec?: {
    suspend?: boolean;
    path?: string;
    url?: string;
    ref?: { branch?: string; tag?: string };
    chart?: { spec?: { chart?: string; version?: string } };
    imageRepositoryRef?: { name?: string };
    sourceRef?: { name?: string; kind?: string };
  };
  status?: {
    lastAppliedRevision?: string;
    lastAttemptedRevision?: string;
    latestImage?: string;
    artifact?: { revision?: string; lastUpdateTime?: string };
    conditions?: FluxCondition[];
    history?: { chartVersion?: string }[];
  };
}

function readyCondition(object: FluxObject): FluxCondition | undefined {
  return (object.status?.conditions ?? []).find((condition) => condition.type === "Ready");
}

function describeSource(kind: FluxKind, object: FluxObject): string | null {
  switch (kind) {
    case "Kustomization":
      return object.spec?.path ?? null;
    case "HelmRelease": {
      const chart = object.spec?.chart?.spec;
      return chart?.chart ? `${chart.chart}${chart.version ? `@${chart.version}` : ""}` : null;
    }
    case "GitRepository":
      return object.spec?.url ? `${object.spec.url}${object.spec.ref?.branch ? `#${object.spec.ref.branch}` : ""}` : null;
    case "HelmRepository":
      return object.spec?.url ?? null;
    case "ImagePolicy":
      return object.spec?.imageRepositoryRef?.name ?? null;
  }
}

function describeRevision(kind: FluxKind, object: FluxObject): string | null {
  if (kind === "Kustomization") return object.status?.lastAppliedRevision ?? null;
  if (kind === "HelmRelease") {
    return object.status?.history?.[0]?.chartVersion ?? object.status?.lastAttemptedRevision ?? null;
  }
  return object.status?.artifact?.revision ?? null;
}

function shape(kind: FluxKind, object: FluxObject): FluxResource | null {
  const name = object.metadata?.name;
  const namespace = object.metadata?.namespace;
  if (!name || !namespace) return null;

  const condition = readyCondition(object);
  const suspended = object.spec?.suspend === true;

  return {
    key: `${kind}/${namespace}/${name}`,
    kind,
    name,
    namespace,
    ready: suspended ? null : condition ? condition.status === "True" : null,
    suspended,
    message: (condition?.message ?? "").trim(),
    revision: describeRevision(kind, object),
    source: describeSource(kind, object),
    lastReconciled: condition?.lastTransitionTime ?? object.status?.artifact?.lastUpdateTime ?? null,
    latestImage: object.status?.latestImage ?? null,
  };
}

/** Where the GitOps repo is checked out, so revisions can be named. */
export function fluxRepoPath(configured: string | null): string | null {
  const candidates = [
    process.env.PASEO_K8S_FLUX_REPO ? expandHome(process.env.PASEO_K8S_FLUX_REPO) : null,
    configured ? expandHome(configured) : null,
    path.join(os.homedir(), "flux"),
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, ".git"))) return candidate;
  }
  return null;
}

function git(repo: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const binary = resolveBinary("git");
  if (!binary) return Promise.resolve({ ok: false, out: "git was not found." });
  return new Promise((resolve) => {
    execFile(binary, ["-C", repo, ...args], { timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      resolve({ ok: !error, out: (stdout ?? "").trim() });
    });
  });
}

/**
 * Compare the revision the cluster has applied against the local clone, so the
 * panel can say "you have N commits master has not picked up yet".
 * Read-only: never fetches, never mutates the working tree.
 */
export async function gitStatus(repo: string, clusterRevision: string | null): Promise<FluxSnapshot["git"]> {
  const branch = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const base: NonNullable<FluxSnapshot["git"]> = {
    repoPath: repo,
    branch: branch.ok ? branch.out : null,
    headSha: head.ok ? head.out.slice(0, 7) : null,
    clusterRevisionKnown: false,
    aheadCount: 0,
    commits: [],
    note: null,
  };

  // Flux revisions look like `master@sha1:<40 hex>`.
  const sha = clusterRevision ? (/([0-9a-f]{40})/.exec(clusterRevision)?.[1] ?? null) : null;
  if (!sha) return { ...base, note: "The cluster has not reported a git revision yet." };

  const known = await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  if (!known.ok) {
    return {
      ...base,
      note: "The deployed commit is not in this clone yet — run `git fetch` in the repo to compare.",
    };
  }

  const count = await git(repo, ["rev-list", "--count", `${sha}..HEAD`]);
  const log = await git(repo, ["log", "--no-decorate", "--format=%h %s", `-${MAX_COMMITS}`, `${sha}..HEAD`]);
  const commits = log.ok && log.out !== ""
    ? log.out.split("\n").map((line) => {
        const space = line.indexOf(" ");
        return space < 0
          ? { sha: line, subject: "" }
          : { sha: line.slice(0, space), subject: line.slice(space + 1) };
      })
    : [];

  return {
    ...base,
    clusterRevisionKnown: true,
    aheadCount: count.ok ? Number(count.out) || 0 : commits.length,
    commits,
    note: null,
  };
}

export async function buildFluxSnapshot(
  environmentId: EnvironmentId,
  configuredRepo: string | null,
): Promise<FluxSnapshot> {
  const { connection } = connectionFor(environmentId);
  const warnings: string[] = [];
  let missing = 0;

  const groups = await Promise.all(
    FLUX_KINDS.map(async ({ kind, apiPath }) => {
      try {
        const response = await apiGet<ListResponse<FluxObject>>(connection, `${apiPath}?limit=${LIST_LIMIT}`);
        return (response.items ?? [])
          .map((item) => shape(kind, item))
          .filter((item): item is FluxResource => item !== null);
      } catch (error) {
        const message = (error as Error).message;
        // A 404 here just means that Flux component is not installed.
        if (message.startsWith("404")) missing += 1;
        else warnings.push(`${kind}: ${message}`);
        return [];
      }
    }),
  );

  const resources = groups.flat();
  const clusterRevision =
    resources.find((resource) => resource.kind === "GitRepository")?.revision ??
    resources.find((resource) => resource.kind === "Kustomization")?.revision ??
    null;

  const repo = fluxRepoPath(configuredRepo);

  return {
    environmentId,
    available: missing < FLUX_KINDS.length,
    fetchedAt: new Date().toISOString(),
    clusterRevision,
    resources,
    git: repo ? await gitStatus(repo, clusterRevision) : null,
    warnings,
  };
}

const KUBECTL_KIND: Record<FluxKind, string> = {
  GitRepository: "gitrepository",
  HelmRepository: "helmrepository",
  Kustomization: "kustomization",
  HelmRelease: "helmrelease",
  ImagePolicy: "imagepolicy",
};

/**
 * Flux actions go through kubectl rather than a raw PATCH, so they reuse the
 * command bar's allowlist and land in the shell transcript as an audit trail.
 * `reconcile` is the standard annotation poke; suspend/resume flip spec.suspend.
 */
export function fluxAction(input: {
  environmentId: EnvironmentId;
  action: "reconcile" | "suspend" | "resume";
  kind: FluxKind;
  name: string;
  namespace: string;
}) {
  const target = `${KUBECTL_KIND[input.kind]}/${input.name}`;
  const scope = `-n ${input.namespace}`;
  const command =
    input.action === "reconcile"
      ? `kubectl annotate --overwrite ${target} ${scope} reconcile.fluxcd.io/requestedAt=${new Date().toISOString()}`
      : `kubectl patch ${target} ${scope} --type=merge -p '{"spec":{"suspend":${input.action === "suspend"}}}'`;

  return runShellCommand({
    environmentId: input.environmentId,
    command,
    namespace: input.namespace,
    // Pinned: a Flux action is a fixed kubectl call, never a user shell line.
    mode: "allowlist",
    allowedBinaries: ["kubectl"],
  });
}
