import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { ClusterEvent, ClusterNode, Overview, Pod, Workload } from "./contracts";
import {
  formatAge,
  formatCpu,
  formatMemory,
  HEALTH_STYLE,
  shortImage,
  STATUS,
  type Tokens,
} from "./theme.client";
import { Button, Meter, StatTile } from "./ui.client";
import { LaunchAgentPanel } from "./launch.client";
import type { EnvironmentId } from "./contracts";

export type Selection =
  | { kind: "workload"; item: Workload }
  | { kind: "pod"; item: Pod }
  | { kind: "node"; item: ClusterNode }
  | { kind: "event"; item: ClusterEvent };

export function resolveSelection(overview: Overview, key: string | null): Selection | null {
  if (!key) return null;
  const workload = overview.workloads.find((entry) => entry.key === key);
  if (workload) return { kind: "workload", item: workload };
  const pod = overview.pods.find((entry) => entry.key === key);
  if (pod) return { kind: "pod", item: pod };
  const node = overview.nodes.find((entry) => entry.key === key);
  if (node) return { kind: "node", item: node };
  const event = overview.events.find((entry) => entry.key === key);
  if (event) return { kind: "event", item: event };
  return null;
}

function Property({ label, value, tokens }: { label: string; value: string; tokens: Tokens }) {
  return (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
      <Text style={{ color: tokens.muted, fontSize: 11, width: 92 }}>{label}</Text>
      <Text style={{ color: tokens.ink, fontSize: 11, flex: 1 }} selectable>
        {value}
      </Text>
    </View>
  );
}

function SectionTitle({ title, tokens }: { title: string; tokens: Tokens }) {
  return (
    <Text style={{ color: tokens.ink, fontSize: 12, fontWeight: "600", marginTop: 4 }}>{title}</Text>
  );
}

/**
 * Right-hand (or, when compact, stacked) detail view for whatever the list has
 * selected. Actions route back up: logs open a dock tab, shell prefills the
 * command bar with something worth running.
 */
export function DetailDrawer({
  selection,
  overview,
  environmentId,
  tokens,
  onClose,
  onOpenLogs,
  onRunCommand,
}: {
  selection: Selection;
  overview: Overview;
  environmentId: EnvironmentId;
  tokens: Tokens;
  onClose: () => void;
  onOpenLogs: (pod: Pod) => void;
  onRunCommand: (command: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const selectionKey =
    selection.kind === "event" ? selection.item.key : selection.item.key;
  const [lastKey, setLastKey] = useState(selectionKey);
  if (lastKey !== selectionKey) {
    setLastKey(selectionKey);
    if (asking) setAsking(false);
  }

  const askable = selection.kind !== "event";
  const defaultInstruction =
    selection.kind === "pod"
      ? "Investigate this pod. Work out why it is unhealthy and what to do about it."
      : selection.kind === "workload"
        ? "Review this workload's health and recent events, and tell me if anything needs attention."
        : "Review this node's pressure and the pods scheduled on it.";

  const header = (() => {
    switch (selection.kind) {
      case "workload":
        return { title: selection.item.name, subtitle: `${selection.item.kind} · ${selection.item.namespace}`, health: HEALTH_STYLE[selection.item.health] };
      case "pod":
        return { title: selection.item.name, subtitle: `Pod · ${selection.item.namespace}`, health: HEALTH_STYLE[selection.item.health] };
      case "node":
        return { title: selection.item.name, subtitle: `Node · ${selection.item.roles.join(", ")}`, health: HEALTH_STYLE[selection.item.health] };
      case "event":
        return { title: selection.item.reason, subtitle: `Event · ${selection.item.object}`, health: HEALTH_STYLE.degraded };
    }
  })();

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 8,
          padding: 12,
          borderBottomWidth: 1,
          borderBottomColor: tokens.border,
        }}
      >
        <Text style={{ color: header.health.color, fontSize: 11, paddingTop: 3 }}>{header.health.glyph}</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: tokens.ink, fontSize: 13, fontWeight: "600" }} numberOfLines={2}>
            {header.title}
          </Text>
          <Text style={{ color: tokens.muted, fontSize: 11 }}>
            {header.subtitle} · {header.health.label}
          </Text>
        </View>
        <Button label="Close" tokens={tokens} onPress={onClose} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
        {askable ? (
          asking ? (
            <LaunchAgentPanel
              environmentId={environmentId}
              resourceKey={selectionKey}
              resourceLabel={header.title}
              defaultInstruction={defaultInstruction}
              tokens={tokens}
              onClose={() => setAsking(false)}
            />
          ) : (
            <View style={{ flexDirection: "row" }}>
              <Button label="✦ Ask an agent" tone="primary" tokens={tokens} onPress={() => setAsking(true)} />
            </View>
          )
        ) : null}

        {selection.kind === "workload" ? (
          <WorkloadDetail
            workload={selection.item}
            pods={overview.pods.filter((pod) => pod.ownerKey === selection.item.key)}
            tokens={tokens}
            onOpenLogs={onOpenLogs}
            onRunCommand={onRunCommand}
          />
        ) : null}
        {selection.kind === "pod" ? (
          <PodDetail pod={selection.item} tokens={tokens} onOpenLogs={onOpenLogs} onRunCommand={onRunCommand} />
        ) : null}
        {selection.kind === "node" ? (
          <NodeDetail node={selection.item} tokens={tokens} onRunCommand={onRunCommand} />
        ) : null}
        {selection.kind === "event" ? <EventDetail event={selection.item} tokens={tokens} /> : null}
      </ScrollView>
    </View>
  );
}

function WorkloadDetail({
  workload,
  pods,
  tokens,
  onOpenLogs,
  onRunCommand,
}: {
  workload: Workload;
  pods: Pod[];
  tokens: Tokens;
  onOpenLogs: (pod: Pod) => void;
  onRunCommand: (command: string) => void;
}) {
  const ratio = workload.desired === 0 ? 0 : workload.ready / workload.desired;
  const health = HEALTH_STYLE[workload.health];
  const flag = `-n ${workload.namespace}`;
  const target = `${workload.kind.toLowerCase()}/${workload.name}`;

  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <StatTile label="Ready" value={`${workload.ready}/${workload.desired}`} tokens={tokens} compact />
        <StatTile label="CPU" value={formatCpu(workload.cpuMilli)} tokens={tokens} compact />
        <StatTile label="Memory" value={formatMemory(workload.memoryBytes)} tokens={tokens} compact />
        <StatTile
          label="Restarts"
          value={String(workload.restarts)}
          tone={workload.restarts > 0 ? STATUS.serious : undefined}
          tokens={tokens}
          compact
        />
      </View>
      <Meter ratio={ratio} color={health.color} height={8} />

      {workload.message ? <Text style={{ color: STATUS.serious, fontSize: 11 }}>◆ {workload.message}</Text> : null}

      <SectionTitle title="Properties" tokens={tokens} />
      <Property label="Kind" value={workload.kind} tokens={tokens} />
      <Property label="Namespace" value={workload.namespace} tokens={tokens} />
      <Property label="Replicas" value={`${workload.desired} desired · ${workload.updated} updated · ${workload.available} available`} tokens={tokens} />
      <Property label="Created" value={`${formatAge(workload.createdAt)} ago`} tokens={tokens} />
      <Property label="Images" value={workload.images.map(shortImage).join("\n") || "—"} tokens={tokens} />

      <SectionTitle title={`Pods (${pods.length})`} tokens={tokens} />
      {pods.map((pod) => {
        const podHealth = HEALTH_STYLE[pod.health];
        return (
          <View key={pod.key} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: podHealth.color, fontSize: 9 }}>{podHealth.glyph}</Text>
            <Text style={{ color: tokens.ink, fontSize: 11, flex: 1 }} numberOfLines={1}>
              {pod.name}
            </Text>
            <Text style={{ color: tokens.muted, fontSize: 10, fontVariant: ["tabular-nums"] }}>
              {pod.readyContainers}/{pod.totalContainers} · ↻{pod.restarts}
            </Text>
            <Button label="Logs" tokens={tokens} onPress={() => onOpenLogs(pod)} />
          </View>
        );
      })}

      <SectionTitle title="Run" tokens={tokens} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Button label="describe" tokens={tokens} onPress={() => onRunCommand(`kubectl describe ${target} ${flag}`)} />
        <Button label="get -o yaml" tokens={tokens} onPress={() => onRunCommand(`kubectl get ${target} ${flag} -o yaml`)} />
        <Button label="rollout status" tokens={tokens} onPress={() => onRunCommand(`kubectl rollout status ${target} ${flag}`)} />
        <Button label="events" tokens={tokens} onPress={() => onRunCommand(`kubectl events ${flag} --for ${target}`)} />
      </View>
    </>
  );
}

function PodDetail({
  pod,
  tokens,
  onOpenLogs,
  onRunCommand,
}: {
  pod: Pod;
  tokens: Tokens;
  onOpenLogs: (pod: Pod) => void;
  onRunCommand: (command: string) => void;
}) {
  const flag = `-n ${pod.namespace}`;
  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <StatTile label="Ready" value={`${pod.readyContainers}/${pod.totalContainers}`} tokens={tokens} compact />
        <StatTile label="CPU" value={formatCpu(pod.cpuMilli)} tokens={tokens} compact />
        <StatTile label="Memory" value={formatMemory(pod.memoryBytes)} tokens={tokens} compact />
        <StatTile
          label="Restarts"
          value={String(pod.restarts)}
          tone={pod.restarts > 0 ? STATUS.serious : undefined}
          tokens={tokens}
          compact
        />
      </View>

      <SectionTitle title="Properties" tokens={tokens} />
      <Property label="Phase" value={pod.reason ? `${pod.phase} · ${pod.reason}` : pod.phase} tokens={tokens} />
      <Property label="Namespace" value={pod.namespace} tokens={tokens} />
      <Property label="Node" value={pod.node ?? "—"} tokens={tokens} />
      <Property label="Containers" value={pod.containerNames.join(", ") || "—"} tokens={tokens} />
      <Property label="Created" value={`${formatAge(pod.createdAt)} ago`} tokens={tokens} />

      <SectionTitle title="Actions" tokens={tokens} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Button label="View logs" tone="primary" tokens={tokens} onPress={() => onOpenLogs(pod)} />
        <Button label="describe" tokens={tokens} onPress={() => onRunCommand(`kubectl describe pod/${pod.name} ${flag}`)} />
        <Button label="get -o yaml" tokens={tokens} onPress={() => onRunCommand(`kubectl get pod/${pod.name} ${flag} -o yaml`)} />
        <Button label="top" tokens={tokens} onPress={() => onRunCommand(`kubectl top pod ${pod.name} ${flag} --containers`)} />
      </View>
    </>
  );
}

function NodeDetail({
  node,
  tokens,
  onRunCommand,
}: {
  node: ClusterNode;
  tokens: Tokens;
  onRunCommand: (command: string) => void;
}) {
  const cpuRatio = node.cpuCapacityMilli && node.cpuMilli ? node.cpuMilli / node.cpuCapacityMilli : 0;
  const memRatio =
    node.memoryCapacityBytes && node.memoryBytes ? node.memoryBytes / node.memoryCapacityBytes : 0;
  const tone = (ratio: number) => (ratio > 0.9 ? STATUS.critical : ratio > 0.75 ? STATUS.serious : STATUS.good);

  return (
    <>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: tokens.muted, fontSize: 11 }}>CPU</Text>
          <Text style={{ color: tokens.ink, fontSize: 11, fontVariant: ["tabular-nums"] }}>
            {formatCpu(node.cpuMilli)} / {formatCpu(node.cpuCapacityMilli)} ({Math.round(cpuRatio * 100)}%)
          </Text>
        </View>
        <Meter ratio={cpuRatio} color={tone(cpuRatio)} height={8} />
      </View>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: tokens.muted, fontSize: 11 }}>Memory</Text>
          <Text style={{ color: tokens.ink, fontSize: 11, fontVariant: ["tabular-nums"] }}>
            {formatMemory(node.memoryBytes)} / {formatMemory(node.memoryCapacityBytes)} ({Math.round(memRatio * 100)}%)
          </Text>
        </View>
        <Meter ratio={memRatio} color={tone(memRatio)} height={8} />
      </View>

      <SectionTitle title="Properties" tokens={tokens} />
      <Property label="Status" value={node.ready ? (node.schedulable ? "Ready" : "Ready, cordoned") : "NotReady"} tokens={tokens} />
      <Property label="Roles" value={node.roles.join(", ")} tokens={tokens} />
      <Property label="Kubelet" value={node.kubeletVersion ?? "—"} tokens={tokens} />
      <Property label="Pods" value={String(node.podCount)} tokens={tokens} />
      <Property label="Created" value={`${formatAge(node.createdAt)} ago`} tokens={tokens} />
      {node.conditions.length > 0 ? (
        <Property label="Conditions" value={node.conditions.join(", ")} tokens={tokens} />
      ) : null}

      <SectionTitle title="Run" tokens={tokens} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Button label="describe" tokens={tokens} onPress={() => onRunCommand(`kubectl describe node/${node.name}`)} />
        <Button label="top" tokens={tokens} onPress={() => onRunCommand(`kubectl top node ${node.name}`)} />
        <Button
          label="pods here"
          tokens={tokens}
          onPress={() => onRunCommand(`kubectl get pods -A --field-selector spec.nodeName=${node.name}`)}
        />
      </View>
    </>
  );
}

function EventDetail({ event, tokens }: { event: ClusterEvent; tokens: Tokens }) {
  return (
    <>
      <SectionTitle title="Properties" tokens={tokens} />
      <Property label="Type" value={event.type} tokens={tokens} />
      <Property label="Object" value={event.object} tokens={tokens} />
      <Property label="Namespace" value={event.namespace || "—"} tokens={tokens} />
      <Property label="Count" value={String(event.count)} tokens={tokens} />
      <Property label="Last seen" value={`${formatAge(event.lastSeen)} ago`} tokens={tokens} />
      <SectionTitle title="Message" tokens={tokens} />
      <Text style={{ color: tokens.ink, fontSize: 11 }} selectable>
        {event.message}
      </Text>
    </>
  );
}
