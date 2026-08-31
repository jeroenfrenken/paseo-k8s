import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin";
import {
  getFlux,
  runFluxAction,
  type EnvironmentId,
  type FluxKind,
  type FluxResource,
  type FluxSnapshot,
  type Overview,
} from "./contracts";
import { errorMessage, formatAge, STATUS, withAlpha, type Tokens } from "./theme.client";
import { Banner, Button, Card, SearchField, StatTile } from "./ui.client";

/** Flux revisions look like `master@sha1:<40 hex>`; show the bit humans use. */
function shortRevision(revision: string | null): string {
  if (!revision) return "—";
  const sha = /([0-9a-f]{40})/.exec(revision);
  if (!sha) return revision;
  const branch = revision.split("@")[0];
  return `${branch}@${sha[1].slice(0, 7)}`;
}

function shortImage(image: string | null): string {
  if (!image) return "—";
  const [repository, tag] = image.split(":");
  const name = repository.split("/").pop() ?? repository;
  return tag ? `${name}:${tag}` : name;
}

function statusOf(resource: FluxResource): { color: string; glyph: string; label: string } {
  if (resource.suspended) return { color: STATUS.neutral, glyph: "⏸", label: "Suspended" };
  if (resource.ready === true) return { color: STATUS.good, glyph: "●", label: "Ready" };
  if (resource.ready === false) return { color: STATUS.critical, glyph: "■", label: "Failed" };
  return { color: STATUS.warning, glyph: "▲", label: "Pending" };
}

const SUSPENDABLE: FluxKind[] = ["Kustomization", "HelmRelease", "GitRepository", "HelmRepository"];

const SECTIONS: { title: string; kinds: FluxKind[] }[] = [
  { title: "Sources", kinds: ["GitRepository", "HelmRepository"] },
  { title: "Kustomizations", kinds: ["Kustomization"] },
  { title: "Helm releases", kinds: ["HelmRelease"] },
  { title: "Image automation", kinds: ["ImagePolicy"] },
];

function FluxRow({
  resource,
  pendingImage,
  tokens,
  busy,
  onAction,
}: {
  resource: FluxResource;
  pendingImage: string | null;
  tokens: Tokens;
  busy: boolean;
  onAction: (action: "reconcile" | "suspend" | "resume", resource: FluxResource) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = statusOf(resource);

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: tokens.border, paddingVertical: 7, gap: 5 }}>
      <Pressable onPress={() => setExpanded((value) => !value)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: status.color, fontSize: 10, width: 12 }}>{status.glyph}</Text>
        <Text style={{ color: tokens.ink, fontSize: 12, fontWeight: "500", flexShrink: 1 }} numberOfLines={1}>
          {resource.name}
        </Text>
        <Text style={{ color: tokens.muted, fontSize: 10 }} numberOfLines={1}>
          {resource.namespace}
        </Text>
        <View style={{ flex: 1 }} />
        {pendingImage ? (
          <Text style={{ color: STATUS.warning, fontSize: 10 }}>▲ update pending</Text>
        ) : null}
        <Text style={{ color: tokens.muted, fontSize: 10, fontFamily: tokens.mono }} numberOfLines={1}>
          {resource.kind === "ImagePolicy" ? shortImage(resource.latestImage) : shortRevision(resource.revision)}
        </Text>
        <Text style={{ color: tokens.muted, fontSize: 10, width: 38, textAlign: "right" }}>
          {formatAge(resource.lastReconciled)}
        </Text>
      </Pressable>

      {expanded ? (
        <View style={{ gap: 6, paddingLeft: 20 }}>
          {resource.source ? (
            <Text style={{ color: tokens.muted, fontSize: 10, fontFamily: tokens.mono }}>{resource.source}</Text>
          ) : null}
          {resource.message ? (
            <Text style={{ color: resource.ready === false ? STATUS.critical : tokens.muted, fontSize: 10 }}>
              {resource.message}
            </Text>
          ) : null}
          {pendingImage ? (
            <Text style={{ color: STATUS.warning, fontSize: 10, fontFamily: tokens.mono }}>
              running {shortImage(pendingImage)} → latest {shortImage(resource.latestImage)}
            </Text>
          ) : null}
          {resource.kind === "ImagePolicy" ? null : (
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <Button label="Reconcile" tokens={tokens} disabled={busy} onPress={() => onAction("reconcile", resource)} />
              {SUSPENDABLE.includes(resource.kind) ? (
                resource.suspended ? (
                  <Button label="Resume" tone="primary" tokens={tokens} disabled={busy} onPress={() => onAction("resume", resource)} />
                ) : (
                  <Button label="Suspend" tokens={tokens} disabled={busy} onPress={() => onAction("suspend", resource)} />
                )
              ) : null}
              {busy ? <ActivityIndicator color={tokens.muted} /> : null}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

export function FluxPane({
  environmentId,
  overview,
  tokens,
  compact,
}: {
  environmentId: EnvironmentId;
  overview: Overview | null;
  tokens: Tokens;
  compact: boolean;
}) {
  const load = useRpc(getFlux);
  const act = useRpc(runFluxAction);
  const rpc = useRef({ load, act });
  rpc.current = { load, act };

  const [snapshot, setSnapshot] = useState<FluxSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    rpc.current
      .load({ environmentId })
      .then((result) => {
        if (!active) return;
        setSnapshot(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setSnapshot(null);
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [environmentId, reloadToken]);

  /** Which image each ImagePolicy's workload is actually running right now. */
  const runningByRepository = useMemo(() => {
    const map = new Map<string, string>();
    for (const workload of overview?.workloads ?? []) {
      for (const image of workload.images) {
        const repository = image.split(":")[0];
        if (!map.has(repository)) map.set(repository, image);
      }
    }
    return map;
  }, [overview]);

  function pendingFor(resource: FluxResource): string | null {
    if (resource.kind !== "ImagePolicy" || !resource.latestImage) return null;
    const repository = resource.latestImage.split(":")[0];
    const running = runningByRepository.get(repository);
    if (!running || running === resource.latestImage) return null;
    return running;
  }

  function onAction(action: "reconcile" | "suspend" | "resume", resource: FluxResource) {
    setBusyKey(resource.key);
    setNotice(null);
    rpc.current
      .act({ environmentId, action, kind: resource.kind, name: resource.name, namespace: resource.namespace })
      .then((result) => {
        setNotice(
          result.refused ??
            (result.exitCode === 0
              ? `${action} ${resource.name}: ok`
              : `${action} ${resource.name}: ${(result.stderr || result.stdout).split("\n")[0]}`),
        );
        setReloadToken((token) => token + 1);
      })
      .catch((cause: unknown) => setNotice(errorMessage(cause)))
      .finally(() => setBusyKey(null));
  }

  const needle = query.trim().toLowerCase();
  const matches = (resource: FluxResource) =>
    needle === "" ||
    `${resource.name} ${resource.namespace} ${resource.source ?? ""} ${resource.message}`.toLowerCase().includes(needle);

  const ready = snapshot?.resources.filter((resource) => resource.ready === true).length ?? 0;
  const failed = snapshot?.resources.filter((resource) => resource.ready === false).length ?? 0;
  const suspended = snapshot?.resources.filter((resource) => resource.suspended).length ?? 0;
  const pending = (snapshot?.resources ?? []).filter((resource) => pendingFor(resource) !== null).length;

  return (
    <ScrollView contentContainerStyle={{ padding: compact ? 10 : 14, gap: 12 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <SearchField value={query} onChange={setQuery} placeholder="Search Flux resources…" tokens={tokens} style={{ flex: 1 }} />
        {loading ? <ActivityIndicator color={tokens.muted} /> : null}
        <Button label="Refresh" tokens={tokens} onPress={() => setReloadToken((token) => token + 1)} />
      </View>

      {error ? <Banner tone="critical" title="Could not read Flux" lines={[error]} tokens={tokens} /> : null}
      {snapshot && !snapshot.available ? (
        <Banner tone="warning" title="Flux is not installed in this cluster" lines={["No Flux CRDs answered."]} tokens={tokens} />
      ) : null}
      {snapshot?.warnings.length ? (
        <Banner tone="warning" title="Partial data" lines={snapshot.warnings} tokens={tokens} />
      ) : null}
      {notice ? <Text style={{ color: tokens.muted, fontSize: 11 }}>{notice}</Text> : null}

      {snapshot ? (
        <>
          <Card tokens={tokens}>
            <Text style={{ color: tokens.muted, fontSize: 11 }}>Deployed revision</Text>
            <Text style={{ color: tokens.ink, fontSize: compact ? 18 : 22, fontWeight: "600", fontFamily: tokens.mono }}>
              {shortRevision(snapshot.clusterRevision)}
            </Text>
            {snapshot.git ? (
              snapshot.git.note ? (
                <Text style={{ color: STATUS.warning, fontSize: 11 }}>▲ {snapshot.git.note}</Text>
              ) : snapshot.git.aheadCount === 0 ? (
                <Text style={{ color: STATUS.good, fontSize: 11 }}>
                  ● {snapshot.git.branch} in {snapshot.git.repoPath} is in sync
                </Text>
              ) : (
                <View style={{ gap: 3 }}>
                  <Text style={{ color: STATUS.warning, fontSize: 11 }}>
                    ▲ {snapshot.git.aheadCount} commit{snapshot.git.aheadCount === 1 ? "" : "s"} in{" "}
                    {snapshot.git.branch} not applied yet
                  </Text>
                  {snapshot.git.commits.map((commit) => (
                    <Text key={commit.sha} style={{ color: tokens.muted, fontSize: 10, fontFamily: tokens.mono }} numberOfLines={1}>
                      {commit.sha} {commit.subject}
                    </Text>
                  ))}
                </View>
              )
            ) : (
              <Text style={{ color: tokens.muted, fontSize: 11 }}>
                No local checkout found — set fluxRepoPath in clusters.json to compare against git.
              </Text>
            )}
          </Card>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <StatTile label="Ready" value={String(ready)} tokens={tokens} />
            <StatTile label="Failed" value={String(failed)} tone={failed > 0 ? STATUS.critical : undefined} tokens={tokens} />
            <StatTile label="Suspended" value={String(suspended)} tone={suspended > 0 ? STATUS.warning : undefined} tokens={tokens} />
            <StatTile label="Image updates" value={String(pending)} tone={pending > 0 ? STATUS.warning : undefined} tokens={tokens} />
          </View>

          {SECTIONS.map((section) => {
            const rows = snapshot.resources.filter(
              (resource) => section.kinds.includes(resource.kind) && matches(resource),
            );
            if (rows.length === 0) return null;
            return (
              <Card key={section.title} tokens={tokens} style={{ gap: 0 }}>
                <Text style={{ color: tokens.ink, fontSize: 13, fontWeight: "600", paddingBottom: 6 }}>
                  {section.title} ({rows.length})
                </Text>
                {rows.map((resource) => (
                  <FluxRow
                    key={resource.key}
                    resource={resource}
                    pendingImage={pendingFor(resource)}
                    tokens={tokens}
                    busy={busyKey === resource.key}
                    onAction={onAction}
                  />
                ))}
              </Card>
            );
          })}

          <Text style={{ color: tokens.muted, fontSize: 10 }}>
            Flux state is cluster-wide and ignores the namespace filter · read {formatAge(snapshot.fetchedAt)} ago
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}
