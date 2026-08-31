import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ClusterEvent, ClusterNode, Overview, Pod, Workload } from "./contracts";
import {
  formatAge,
  formatCpu,
  formatMemory,
  HEALTH_STYLE,
  STATUS,
  type Tokens,
} from "./theme.client";

export type ResourceKind =
  | "overview"
  | "pods"
  | "deployments"
  | "statefulsets"
  | "daemonsets"
  | "nodes"
  | "events"
  | "flux";

export const RESOURCE_LABELS: Record<ResourceKind, string> = {
  overview: "Overview",
  pods: "Pods",
  deployments: "Deployments",
  statefulsets: "Stateful Sets",
  daemonsets: "Daemon Sets",
  nodes: "Nodes",
  events: "Events",
  flux: "Flux",
};

export const RESOURCE_GLYPHS: Record<ResourceKind, string> = {
  overview: "▦",
  pods: "◉",
  deployments: "▲",
  statefulsets: "▤",
  daemonsets: "▣",
  nodes: "◈",
  events: "!",
  flux: "⟳",
};

/** A row is whatever the tab lists; `selectionKey` is what the drawer keys on. */
export interface Row {
  selectionKey: string;
  cells: (string | number | null)[];
  /** Sortable values, parallel to `cells`. */
  sortValues: (string | number | null)[];
  health: { color: string; glyph: string; label: string };
  /** Free text the search box matches against. */
  haystack: string;
}

export interface ColumnSpec {
  title: string;
  width?: number;
  flex?: number;
  align?: "left" | "right";
  numeric?: boolean;
}

export interface TableModel {
  columns: ColumnSpec[];
  rows: Row[];
}

const NAME_COLUMN: ColumnSpec = { title: "Name", flex: 1 };

function workloadRows(items: Workload[], showUsage: boolean): TableModel {
  return {
    columns: [
      NAME_COLUMN,
      { title: "Namespace", width: 130 },
      { title: "Ready", width: 62, align: "right" },
      ...(showUsage
        ? ([
            { title: "CPU", width: 62, align: "right", numeric: true },
            { title: "Memory", width: 74, align: "right", numeric: true },
          ] as ColumnSpec[])
        : []),
      { title: "Restarts", width: 66, align: "right", numeric: true },
      { title: "Age", width: 52, align: "right" },
    ],
    rows: items.map((item) => ({
      selectionKey: item.key,
      health: HEALTH_STYLE[item.health],
      haystack: `${item.name} ${item.namespace} ${item.kind} ${item.health} ${item.images.join(" ")}`.toLowerCase(),
      cells: [
        item.name,
        item.namespace,
        `${item.ready}/${item.desired}`,
        ...(showUsage ? [formatCpu(item.cpuMilli), formatMemory(item.memoryBytes)] : []),
        item.restarts,
        formatAge(item.createdAt),
      ],
      sortValues: [
        item.name,
        item.namespace,
        item.desired === 0 ? 0 : item.ready / item.desired,
        ...(showUsage ? [item.cpuMilli, item.memoryBytes] : []),
        item.restarts,
        item.createdAt ? -new Date(item.createdAt).getTime() : 0,
      ],
    })),
  };
}

function podRows(items: Pod[], showUsage: boolean): TableModel {
  return {
    columns: [
      NAME_COLUMN,
      { title: "Namespace", width: 130 },
      { title: "Ready", width: 56, align: "right" },
      { title: "Status", width: 108 },
      ...(showUsage
        ? ([
            { title: "CPU", width: 62, align: "right", numeric: true },
            { title: "Memory", width: 74, align: "right", numeric: true },
          ] as ColumnSpec[])
        : []),
      { title: "Restarts", width: 66, align: "right", numeric: true },
      { title: "Node", width: 150 },
      { title: "Age", width: 52, align: "right" },
    ],
    rows: items.map((item) => ({
      selectionKey: item.key,
      health: HEALTH_STYLE[item.health],
      haystack: `${item.name} ${item.namespace} ${item.phase} ${item.reason ?? ""} ${item.node ?? ""}`.toLowerCase(),
      cells: [
        item.name,
        item.namespace,
        `${item.readyContainers}/${item.totalContainers}`,
        item.reason ?? item.phase,
        ...(showUsage ? [formatCpu(item.cpuMilli), formatMemory(item.memoryBytes)] : []),
        item.restarts,
        item.node ?? "—",
        formatAge(item.createdAt),
      ],
      sortValues: [
        item.name,
        item.namespace,
        item.totalContainers === 0 ? 0 : item.readyContainers / item.totalContainers,
        item.reason ?? item.phase,
        ...(showUsage ? [item.cpuMilli, item.memoryBytes] : []),
        item.restarts,
        item.node ?? "",
        item.createdAt ? -new Date(item.createdAt).getTime() : 0,
      ],
    })),
  };
}

function nodeRows(items: ClusterNode[]): TableModel {
  return {
    columns: [
      NAME_COLUMN,
      { title: "Roles", width: 96 },
      { title: "Status", width: 96 },
      { title: "CPU", width: 92, align: "right", numeric: true },
      { title: "Memory", width: 104, align: "right", numeric: true },
      { title: "Pods", width: 52, align: "right", numeric: true },
      { title: "Version", width: 88 },
      { title: "Age", width: 52, align: "right" },
    ],
    rows: items.map((item) => ({
      selectionKey: item.key,
      health: HEALTH_STYLE[item.health],
      haystack: `${item.name} ${item.roles.join(" ")} ${item.kubeletVersion ?? ""}`.toLowerCase(),
      cells: [
        item.name,
        item.roles.join(", "),
        item.ready ? (item.schedulable ? "Ready" : "Cordoned") : "NotReady",
        item.cpuCapacityMilli
          ? `${formatCpu(item.cpuMilli)} / ${formatCpu(item.cpuCapacityMilli)}`
          : formatCpu(item.cpuMilli),
        item.memoryCapacityBytes
          ? `${formatMemory(item.memoryBytes)} / ${formatMemory(item.memoryCapacityBytes)}`
          : formatMemory(item.memoryBytes),
        item.podCount,
        item.kubeletVersion ?? "—",
        formatAge(item.createdAt),
      ],
      sortValues: [
        item.name,
        item.roles.join(", "),
        item.ready ? 1 : 0,
        item.cpuMilli,
        item.memoryBytes,
        item.podCount,
        item.kubeletVersion ?? "",
        item.createdAt ? -new Date(item.createdAt).getTime() : 0,
      ],
    })),
  };
}

function eventRows(items: ClusterEvent[]): TableModel {
  return {
    columns: [
      { title: "Reason", width: 170 },
      { title: "Object", width: 200 },
      { title: "Message", flex: 1 },
      { title: "Count", width: 56, align: "right", numeric: true },
      { title: "Last seen", width: 68, align: "right" },
    ],
    rows: items.map((item) => ({
      selectionKey: item.key,
      health: item.type === "Warning" ? HEALTH_STYLE.degraded : HEALTH_STYLE.down,
      haystack: `${item.reason} ${item.object} ${item.message} ${item.namespace}`.toLowerCase(),
      cells: [item.reason, item.object, item.message, item.count, formatAge(item.lastSeen)],
      sortValues: [
        item.reason,
        item.object,
        item.message,
        item.count,
        item.lastSeen ? -new Date(item.lastSeen).getTime() : 0,
      ],
    })),
  };
}

export function buildTable(kind: ResourceKind, overview: Overview): TableModel {
  const showUsage = overview.metricsAvailable;
  switch (kind) {
    case "pods":
      return podRows(overview.pods, showUsage);
    case "deployments":
      return workloadRows(overview.workloads.filter((item) => item.kind === "Deployment"), showUsage);
    case "statefulsets":
      return workloadRows(overview.workloads.filter((item) => item.kind === "StatefulSet"), showUsage);
    case "daemonsets":
      return workloadRows(overview.workloads.filter((item) => item.kind === "DaemonSet"), showUsage);
    case "nodes":
      return nodeRows(overview.nodes);
    case "events":
      return eventRows(overview.events);
    default:
      return { columns: [], rows: [] };
  }
}

function compare(left: string | number | null, right: string | number | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function columnStyle(column: ColumnSpec) {
  return column.flex ? { flex: column.flex, minWidth: 160 } : { width: column.width ?? 100 };
}

export function ResourceTable({
  model,
  query,
  selectedKey,
  tokens,
  compact,
  onSelect,
  emptyLabel,
}: {
  model: TableModel;
  query: string;
  selectedKey: string | null;
  tokens: Tokens;
  compact: boolean;
  onSelect: (key: string) => void;
  emptyLabel: string;
}) {
  const [sort, setSort] = useState<{ index: number; ascending: boolean } | null>(null);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle === "" ? model.rows : model.rows.filter((row) => row.haystack.includes(needle));
    if (!sort) return filtered;
    const sorted = [...filtered].sort(
      (left, right) => compare(left.sortValues[sort.index], right.sortValues[sort.index]),
    );
    return sort.ascending ? sorted : sorted.reverse();
  }, [model.rows, query, sort]);

  // Wide enough that the columns keep their shape; the strip scrolls sideways
  // rather than crushing every cell on a narrow window.
  const minWidth = model.columns.reduce(
    (total, column) => total + (column.flex ? 220 : (column.width ?? 100)),
    26,
  );

  const body = (
    <View style={{ minWidth: compact ? minWidth : undefined, flex: compact ? undefined : 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 6,
          paddingHorizontal: 8,
          borderBottomWidth: 1,
          borderBottomColor: tokens.border,
        }}
      >
        <View style={{ width: 10 }} />
        {model.columns.map((column, index) => {
          const active = sort?.index === index;
          return (
            <Pressable
              key={column.title}
              onPress={() =>
                setSort((current) =>
                  current?.index === index
                    ? { index, ascending: !current.ascending }
                    : { index, ascending: true },
                )
              }
              style={columnStyle(column)}
            >
              <Text
                style={{
                  color: active ? tokens.ink : tokens.muted,
                  fontSize: 10,
                  fontWeight: "600",
                  textAlign: column.align === "right" ? "right" : "left",
                }}
                numberOfLines={1}
              >
                {column.title}
                {active ? (sort.ascending ? " ↑" : " ↓") : ""}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {rows.length === 0 ? (
        <Text style={{ color: tokens.muted, fontSize: 12, padding: 14 }}>
          {query.trim() === "" ? emptyLabel : `Nothing matches "${query.trim()}".`}
        </Text>
      ) : (
        rows.map((row, rowIndex) => {
          const selected = row.selectionKey === selectedKey;
          return (
            <Pressable
              key={row.selectionKey}
              onPress={() => onSelect(row.selectionKey)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingVertical: 6,
                paddingHorizontal: 8,
                backgroundColor: selected ? tokens.rowSelected : rowIndex % 2 === 1 ? tokens.row : "transparent",
              }}
            >
              <Text style={{ width: 10, color: row.health.color, fontSize: 9 }}>{row.health.glyph}</Text>
              {model.columns.map((column, index) => (
                <Text
                  key={column.title}
                  numberOfLines={1}
                  style={{
                    ...columnStyle(column),
                    color: index === 0 ? tokens.ink : tokens.muted,
                    fontSize: 11,
                    fontWeight: index === 0 ? "500" : "400",
                    textAlign: column.align === "right" ? "right" : "left",
                    ...(column.numeric ? { fontVariant: ["tabular-nums" as const] } : {}),
                  }}
                >
                  {row.cells[index] ?? "—"}
                </Text>
              ))}
            </Pressable>
          );
        })
      )}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
        {compact ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {body}
          </ScrollView>
        ) : (
          body
        )}
      </ScrollView>
      <View
        style={{
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderTopWidth: 1,
          borderTopColor: tokens.border,
          flexDirection: "row",
          gap: 10,
        }}
      >
        <Text style={{ color: tokens.muted, fontSize: 10, fontVariant: ["tabular-nums"] }}>
          {rows.length}
          {rows.length === model.rows.length ? "" : ` of ${model.rows.length}`} items
        </Text>
        {rows.some((row) => row.health.color === STATUS.critical) ? (
          <Text style={{ color: STATUS.critical, fontSize: 10 }}>
            ■ {rows.filter((row) => row.health.color === STATUS.critical).length} down
          </Text>
        ) : null}
      </View>
    </View>
  );
}
