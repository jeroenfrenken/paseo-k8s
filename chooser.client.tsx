import { Pressable, ScrollView, Text, View } from "react-native";
import type { Overview } from "./contracts";
import { STATUS, withAlpha, type Tokens } from "./theme.client";
import { Button, SectionLabel } from "./ui.client";
import { RESOURCE_GLYPHS, RESOURCE_LABELS, type ResourceKind } from "./list.client";

interface ChoiceMeta {
  kind: ResourceKind;
  blurb: string;
  count?: (overview: Overview) => number;
}

const GROUPS: { title: string; choices: ChoiceMeta[] }[] = [
  {
    title: "Summary",
    choices: [{ kind: "overview", blurb: "Availability, pod phases and node pressure" }],
  },
  {
    title: "Workloads",
    choices: [
      { kind: "pods", blurb: "Every pod with live CPU and memory", count: (o) => o.pods.length },
      { kind: "deployments", blurb: "Replica health per Deployment", count: (o) => o.workloads.filter((w) => w.kind === "Deployment").length },
      { kind: "statefulsets", blurb: "Ordered, stateful workloads", count: (o) => o.workloads.filter((w) => w.kind === "StatefulSet").length },
      { kind: "daemonsets", blurb: "One pod per node", count: (o) => o.workloads.filter((w) => w.kind === "DaemonSet").length },
    ],
  },
  {
    title: "Cluster",
    choices: [
      { kind: "nodes", blurb: "Capacity and pressure per node", count: (o) => o.nodes.length },
      { kind: "events", blurb: "Recent warnings, newest first", count: (o) => o.events.length },
    ],
  },
  {
    title: "Delivery",
    choices: [{ kind: "flux", blurb: "Deployed revision, Kustomizations, Helm releases and image updates" }],
  },
];

function Tile({
  kind,
  blurb,
  count,
  disabled,
  tokens,
  onPress,
}: {
  kind: ResourceKind;
  blurb: string;
  count?: number;
  disabled?: boolean;
  tokens: Tokens;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={disabled ? () => {} : onPress}
      style={{
        flexGrow: 1,
        flexBasis: 210,
        maxWidth: 340,
        opacity: disabled ? 0.55 : 1,
        borderWidth: 1,
        borderColor: tokens.border,
        borderRadius: 10,
        backgroundColor: tokens.raised,
        padding: 14,
        gap: 5,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: tokens.accent, fontSize: 13 }}>{RESOURCE_GLYPHS[kind]}</Text>
        <Text style={{ color: tokens.ink, fontSize: 13, fontWeight: "600", flex: 1 }}>{RESOURCE_LABELS[kind]}</Text>
        {count !== undefined ? (
          <Text style={{ color: tokens.muted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{count}</Text>
        ) : null}
      </View>
      <Text style={{ color: tokens.muted, fontSize: 11 }}>{blurb}</Text>
    </Pressable>
  );
}

/** Full-pane picker shown when the `+` in the tab strip is pressed. */
export function TabChooser({
  overview,
  tokens,
  compact,
  onPick,
  onCancel,
}: {
  overview: Overview | null;
  tokens: Tokens;
  compact: boolean;
  onPick: (kind: ResourceKind) => void;
  onCancel: () => void;
}) {
  const fluxAvailable = overview?.fluxAvailable ?? false;

  return (
    <ScrollView contentContainerStyle={{ padding: compact ? 12 : 20, gap: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: tokens.ink, fontSize: compact ? 17 : 20, fontWeight: "600" }}>Add a view</Text>
          <Text style={{ color: tokens.muted, fontSize: 12 }}>
            Open as many as you like — each tab keeps its own search and sort.
          </Text>
        </View>
        <Button label="Cancel" tokens={tokens} onPress={onCancel} />
      </View>

      {GROUPS.map((group) => {
        const isDelivery = group.title === "Delivery";
        return (
          <View key={group.title} style={{ gap: 10 }}>
            <SectionLabel text={group.title} tokens={tokens} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              {group.choices.map((choice) => (
                <Tile
                  key={choice.kind}
                  kind={choice.kind}
                  blurb={choice.blurb}
                  count={overview && choice.count ? choice.count(overview) : undefined}
                  disabled={choice.kind === "flux" && !fluxAvailable}
                  tokens={tokens}
                  onPress={() => onPick(choice.kind)}
                />
              ))}
            </View>
            {isDelivery && !fluxAvailable ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: withAlpha(STATUS.warning, 0.5),
                  backgroundColor: withAlpha(STATUS.warning, 0.08),
                  borderRadius: 9,
                  padding: 12,
                  gap: 4,
                }}
              >
                <Text style={{ color: STATUS.warning, fontSize: 12, fontWeight: "600" }}>
                  ▲ Flux is not installed in this cluster
                </Text>
                <Text style={{ color: tokens.muted, fontSize: 11 }}>
                  The Flux view needs the Flux controllers running. Install them, then reopen this picker:
                </Text>
                <Text style={{ color: tokens.ink, fontSize: 11, fontFamily: tokens.mono }}>
                  flux install    # or: flux bootstrap git --url=… --branch=main --path=./clusters/…
                </Text>
                <Text style={{ color: tokens.muted, fontSize: 11 }}>
                  Docs: fluxcd.io/flux/installation
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

/** Shown the first time the panel runs, before any cluster is configured. */
export function FirstRunScreen({
  discovered,
  tokens,
  compact,
  onOpenSettings,
}: {
  discovered: { label: string; kubeconfig: string }[];
  tokens: Tokens;
  compact: boolean;
  onOpenSettings: () => void;
}) {
  const found = discovered.filter((entry) => entry.kubeconfig !== "");

  return (
    <ScrollView contentContainerStyle={{ padding: compact ? 16 : 28, gap: 16, maxWidth: 620 }}>
      <View style={{ gap: 6 }}>
        <Text style={{ color: tokens.ink, fontSize: compact ? 22 : 28, fontWeight: "600" }}>Connect a cluster</Text>
        <Text style={{ color: tokens.muted, fontSize: 13 }}>
          This panel talks to the Kubernetes API directly using a kubeconfig per environment. Everything it does on
          its own is a read.
        </Text>
      </View>

      <View
        style={{
          borderWidth: 1,
          borderColor: tokens.border,
          borderRadius: 10,
          backgroundColor: tokens.raised,
          padding: 16,
          gap: 12,
        }}
      >
        <SectionLabel text={found.length > 0 ? "Found on this machine" : "Nothing found yet"} tokens={tokens} />
        {found.length > 0 ? (
          found.map((entry) => (
            <View key={entry.label} style={{ gap: 2 }}>
              <Text style={{ color: STATUS.good, fontSize: 12 }}>● {entry.label}</Text>
              <Text style={{ color: tokens.muted, fontSize: 11, fontFamily: tokens.mono }}>{entry.kubeconfig}</Text>
            </View>
          ))
        ) : (
          <Text style={{ color: tokens.muted, fontSize: 12 }}>
            No kubeconfig was discovered. The panel looks in ~/.config/kubernetes-mcp and ~/.kube. Add a path in
            Settings and it will connect.
          </Text>
        )}
        <Button
          label={found.length > 0 ? "Review and connect" : "Open settings"}
          tone="primary"
          tokens={tokens}
          onPress={onOpenSettings}
        />
      </View>

      <View style={{ gap: 6 }}>
        <SectionLabel text="What you get" tokens={tokens} />
        {[
          "Pods, Deployments, StatefulSets, DaemonSets, Nodes and Events with live CPU and memory",
          "Pod logs in a resizable dock, with follow and search",
          "A kubectl command bar with KUBECONFIG already set",
          "Flux delivery state, if Flux is installed",
          "Attach any resource — logs and all — to an agent prompt",
        ].map((line) => (
          <Text key={line} style={{ color: tokens.muted, fontSize: 12 }}>
            ·  {line}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}
