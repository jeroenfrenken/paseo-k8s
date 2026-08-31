import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Pressable, ScrollView, Text, View } from "react-native";
import {
  getConfig,
  getOverview,
  listNamespaces,
  type ConfigState,
  type EnvironmentId,
  type Overview,
  type Pod,
} from "./contracts";
import {
  errorMessage,
  formatAge,
  PHASE_ORDER,
  PHASE_STYLE,
  STATUS,
  tokensFor,
  withAlpha,
  type Tokens,
} from "./theme.client";
import { Banner, Button, Card, Dropdown, IconButton, Meter, SearchField, StatTile } from "./ui.client";
import {
  buildTable,
  RESOURCE_GLYPHS,
  RESOURCE_LABELS,
  ResourceTable,
  type ResourceKind,
} from "./list.client";
import { DetailDrawer, resolveSelection } from "./detail.client";
import {
  DockResizer,
  DockTabStrip,
  DOCK_DEFAULT_HEIGHT,
  LogsTab,
  ShellTab,
  type DockTab,
} from "./dock.client";
import { SettingsScreen } from "./settings.client";
import { FirstRunScreen, TabChooser } from "./chooser.client";
import { FluxPane } from "./flux.client";

const REFRESH_INTERVAL_MS = 20_000;
const DRAWER_WIDTH = 340;

interface ViewTab {
  id: string;
  kind: ResourceKind;
}

type Mode = "browse" | "settings" | "chooser";

let tabCounter = 0;
function nextTabId(kind: string): string {
  tabCounter += 1;
  return `${kind}-${tabCounter}`;
}

export function KubernetesSurface({ theme, layout }: PluginSurfaceProps) {
  const tokens = useMemo(() => tokensFor(theme, layout.platform), [theme, layout.platform]);
  const compact = layout.compact;

  const loadConfig = useRpc(getConfig);
  const loadNamespaces = useRpc(listNamespaces);
  const loadOverview = useRpc(getOverview);
  const rpc = useRef({ loadConfig, loadNamespaces, loadOverview });
  rpc.current = { loadConfig, loadNamespaces, loadOverview };

  const [config, setConfig] = useState<ConfigState | null>(null);
  const [mode, setMode] = useState<Mode>("browse");
  const [environmentId, setEnvironmentId] = useState<EnvironmentId>("");
  const [namespace, setNamespace] = useState<string | null>(null);
  const [namespaceTouched, setNamespaceTouched] = useState(false);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const [tabs, setTabs] = useState<ViewTab[]>([
    { id: "overview-0", kind: "overview" },
    { id: "pods-0", kind: "pods" },
  ]);
  const [activeTabId, setActiveTabId] = useState("overview-0");
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [dockTabs, setDockTabs] = useState<DockTab[]>([]);
  const [activeDockId, setActiveDockId] = useState<string | null>(null);
  const [dockHeight, setDockHeight] = useState(DOCK_DEFAULT_HEIGHT);
  const dockHeightValue = useRef(new Animated.Value(DOCK_DEFAULT_HEIGHT)).current;
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    rpc.current
      .loadConfig({})
      .then((state) => {
        if (!active) return;
        setConfig(state);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  // Clusters can be added and removed, so the selection is re-pinned whenever
  // the configured list no longer contains it.
  useEffect(() => {
    if (!config) return;
    if (config.environments.some((entry) => entry.id === environmentId)) return;
    const preferred =
      config.environments.find((entry) => entry.kubeconfig !== "") ?? config.environments[0] ?? null;
    setEnvironmentId(preferred?.id ?? "");
    setNamespaceTouched(false);
    setSelectedKey(null);
  }, [config, environmentId]);

  const environment = useMemo(
    () => config?.environments.find((entry) => entry.id === environmentId) ?? null,
    [config, environmentId],
  );
  const environmentLabel = environment?.label ?? "No cluster";
  const configured = environment !== null && environment.kubeconfig !== "";
  const anyConfigured = (config?.environments ?? []).some((entry) => entry.kubeconfig !== "");

  useEffect(() => {
    if (namespaceTouched) return;
    setNamespace(environment?.namespace ?? null);
  }, [environment, namespaceTouched]);

  useEffect(() => {
    if (!configured) {
      setNamespaces([]);
      return;
    }
    let active = true;
    rpc.current
      .loadNamespaces({ environmentId })
      .then((result) => {
        if (active) setNamespaces(result.namespaces);
      })
      .catch(() => {
        if (active) setNamespaces([]);
      });
    return () => {
      active = false;
    };
  }, [environmentId, configured, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!configured) {
      setOverview(null);
      return;
    }
    let active = true;
    setLoading(true);
    rpc.current
      .loadOverview({ environmentId, namespace })
      .then((result) => {
        if (!active) return;
        setOverview(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setOverview(null);
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [environmentId, namespace, configured, reloadToken]);

  useEffect(() => {
    if (!autoRefresh || !configured || mode !== "browse") return;
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, configured, refresh, mode]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  const query = activeTab ? (queries[activeTab.id] ?? "") : "";
  const selection = overview ? resolveSelection(overview, selectedKey) : null;

  const openDockTab = useCallback((tab: DockTab) => {
    setDockTabs((current) => (current.some((entry) => entry.id === tab.id) ? current : [...current, tab]));
    setActiveDockId(tab.id);
    setDockCollapsed(false);
  }, []);

  const openLogs = useCallback(
    (pod: Pod) => openDockTab({ id: `logs-${pod.key}`, kind: "logs", pod, title: pod.name }),
    [openDockTab],
  );

  const openShell = useCallback(
    (command?: string) => {
      setDockTabs((current) => {
        const existing = current.find((tab) => tab.kind === "shell");
        if (existing) {
          setActiveDockId(existing.id);
          return current;
        }
        const created: DockTab = { id: nextTabId("shell"), kind: "shell", title: "Shell" };
        setActiveDockId(created.id);
        return [...current, created];
      });
      setDockCollapsed(false);
      if (command) setPendingCommand(command);
    },
    [],
  );

  const closeDockTab = useCallback((id: string) => {
    setDockTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      setActiveDockId((active) => (active === id ? (next[next.length - 1]?.id ?? null) : active));
      return next;
    });
  }, []);

  const commitDockHeight = useCallback((next: number) => setDockHeight(next), []);

  const addTab = useCallback((kind: ResourceKind) => {
    const id = nextTabId(kind);
    setTabs((current) => [...current, { id, kind }]);
    setActiveTabId(id);
    setMode("browse");
  }, []);

  const activeDock = dockTabs.find((tab) => tab.id === activeDockId) ?? null;
  const dockVisible = dockTabs.length > 0 && !dockCollapsed;

  // Rebuilding the table on every parent render is what made the dock drag feel
  // heavy; keep it keyed to the data it actually depends on.
  const content = useMemo(() => {
    if (!config) {
      return <Text style={{ color: tokens.muted, fontSize: 12, padding: 16 }}>Loading configuration…</Text>;
    }
    if (!configured) {
      return (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Card tokens={tokens}>
            <Text style={{ color: tokens.ink, fontSize: 13, fontWeight: "600" }}>
              {environmentLabel} has no kubeconfig yet
            </Text>
            <Text style={{ color: tokens.muted, fontSize: 12 }}>
              Add one in Settings, or switch to an environment that is configured.
            </Text>
            <View style={{ flexDirection: "row" }}>
              <Button label="Open settings" tone="primary" tokens={tokens} onPress={() => setMode("settings")} />
            </View>
          </Card>
        </ScrollView>
      );
    }
    if (error) {
      return (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Banner tone="critical" title="Could not load" lines={[error]} tokens={tokens} />
        </ScrollView>
      );
    }
    if (!overview || !activeTab) {
      return <Text style={{ color: tokens.muted, fontSize: 12, padding: 16 }}>Loading…</Text>;
    }
    if (activeTab.kind === "overview") {
      return <OverviewPane overview={overview} tokens={tokens} compact={compact} />;
    }
    if (activeTab.kind === "flux") {
      return <FluxPane environmentId={environmentId} overview={overview} tokens={tokens} compact={compact} />;
    }
    return (
      <View style={{ flex: 1 }}>
        <View style={{ paddingHorizontal: 10, paddingTop: 10, paddingBottom: 6 }}>
          <SearchField
            value={query}
            onChange={(next) => setQueries((current) => ({ ...current, [activeTab.id]: next }))}
            placeholder={`Search ${RESOURCE_LABELS[activeTab.kind].toLowerCase()}…`}
            tokens={tokens}
          />
        </View>
        <ResourceTable
          model={buildTable(activeTab.kind, overview)}
          query={query}
          selectedKey={selectedKey}
          tokens={tokens}
          compact={compact}
          onSelect={(key) => setSelectedKey((current) => (current === key ? null : key))}
          emptyLabel={`No ${RESOURCE_LABELS[activeTab.kind].toLowerCase()} in this scope.`}
        />
      </View>
    );
  }, [config, configured, environmentLabel, error, overview, activeTab, query, selectedKey, tokens, compact, environmentId]);

  if (config && !anyConfigured && mode === "browse") {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.surface }}>
        <FirstRunScreen
          discovered={config.environments.map((entry) => ({ label: entry.label, kubeconfig: entry.kubeconfig }))}
          tokens={tokens}
          compact={compact}
          onOpenSettings={() => setMode("settings")}
        />
      </View>
    );
  }

  if (mode === "settings" && config) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.surface }}>
        <SettingsScreen
          config={config}
          tokens={tokens}
          compact={compact}
          onConfigChange={(next) => {
            setConfig(next);
            refresh();
          }}
          onClose={() => setMode("browse")}
        />
      </View>
    );
  }

  const environmentOptions = (config?.environments ?? []).map((entry) => ({
    value: entry.id,
    label: entry.label || entry.id,
    detail: entry.kubeconfig === "" ? "not configured" : (entry.context ?? "default context"),
    tone: entry.isProduction ? STATUS.critical : STATUS.good,
  }));

  const namespaceOptions = [
    { value: "__all__", label: "All namespaces" },
    ...namespaces.map((name) => ({ value: name, label: name })),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: tokens.surface }}>
      {/* Header: identity and cluster-wide controls. */}
      <View
        style={{
          paddingHorizontal: compact ? 12 : 18,
          paddingTop: compact ? 10 : 14,
          paddingBottom: 10,
          gap: 8,
          borderBottomWidth: 1,
          borderBottomColor: tokens.border,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Dropdown
            value={environmentId}
            options={environmentOptions}
            onSelect={(value) => {
              setEnvironmentId(value as EnvironmentId);
              setNamespaceTouched(false);
              setSelectedKey(null);
            }}
            tokens={tokens}
            title="Cluster"
            minWidth={compact ? 150 : 190}
            emphasis
          />
          <View style={{ flex: 1 }} />
          {loading ? <ActivityIndicator color={tokens.muted} /> : null}
          <IconButton glyph="⟳" tokens={tokens} onPress={refresh} label={compact ? undefined : "Refresh"} />
          <IconButton
            glyph="◷"
            tokens={tokens}
            active={autoRefresh}
            onPress={() => setAutoRefresh((value) => !value)}
            label={compact ? undefined : autoRefresh ? "Auto" : "Manual"}
          />
          <IconButton glyph="❯" tokens={tokens} onPress={() => openShell()} label={compact ? undefined : "Shell"} />
          <IconButton glyph="⚙" tokens={tokens} onPress={() => setMode("settings")} label={compact ? undefined : "Settings"} />
        </View>

        {environment?.isProduction ? (
          <View
            style={{
              alignSelf: "flex-start",
              paddingHorizontal: 8,
              paddingVertical: 2,
              borderRadius: 5,
              backgroundColor: withAlpha(STATUS.critical, 0.14),
            }}
          >
            <Text style={{ color: STATUS.critical, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 }}>
              PRODUCTION
            </Text>
          </View>
        ) : null}

        {overview ? (
          <Text style={{ color: tokens.muted, fontSize: 11 }} numberOfLines={1}>
            {overview.contextName} · {overview.serverUrl}
            {overview.version ? ` · ${overview.version}` : ""} · updated {formatAge(overview.fetchedAt)} ago
          </Text>
        ) : null}
      </View>

      {/* Tab strip, with the namespace filter on the same line. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: compact ? 6 : 12,
          paddingRight: compact ? 8 : 14,
          borderBottomWidth: 1,
          borderBottomColor: tokens.border,
          backgroundColor: withAlpha(tokens.ink, 0.02),
        }}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {tabs.map((tab) => {
              const active = tab.id === activeTab?.id && mode === "browse";
              return (
                <Pressable
                  key={tab.id}
                  onPress={() => {
                    setActiveTabId(tab.id);
                    setMode("browse");
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingHorizontal: 11,
                    paddingVertical: 9,
                    borderBottomWidth: 2,
                    borderBottomColor: active ? tokens.accent : "transparent",
                  }}
                >
                  <Text style={{ color: active ? tokens.ink : tokens.muted, fontSize: 11 }}>
                    {RESOURCE_GLYPHS[tab.kind]}
                  </Text>
                  <Text
                    style={{
                      color: active ? tokens.ink : tokens.muted,
                      fontSize: 12,
                      fontWeight: active ? "600" : "400",
                    }}
                  >
                    {RESOURCE_LABELS[tab.kind]}
                  </Text>
                  {tabs.length > 1 ? (
                    <Pressable
                      onPress={() =>
                        setTabs((current) => {
                          const next = current.filter((entry) => entry.id !== tab.id);
                          setActiveTabId((id) => (id === tab.id ? (next[0]?.id ?? "") : id));
                          return next;
                        })
                      }
                      hitSlop={8}
                    >
                      <Text style={{ color: tokens.muted, fontSize: 13 }}>×</Text>
                    </Pressable>
                  ) : null}
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => setMode(mode === "chooser" ? "browse" : "chooser")}
              style={{
                paddingHorizontal: 11,
                paddingVertical: 9,
                borderBottomWidth: 2,
                borderBottomColor: mode === "chooser" ? tokens.accent : "transparent",
              }}
            >
              <Text style={{ color: mode === "chooser" ? tokens.ink : tokens.muted, fontSize: 14 }}>+</Text>
            </Pressable>
          </View>
        </ScrollView>

        {namespaces.length > 0 ? (
          <Dropdown
            value={namespace ?? "__all__"}
            options={namespaceOptions}
            onSelect={(value) => {
              setNamespaceTouched(true);
              setNamespace(value === "__all__" ? null : value);
              setSelectedKey(null);
            }}
            tokens={tokens}
            title="Namespace"
            searchable
            minWidth={compact ? 120 : 170}
          />
        ) : null}
      </View>

      <View style={{ flex: 1, flexDirection: compact ? "column" : "row" }}>
        <View style={{ flex: 1 }}>
          {mode === "chooser" ? (
            <TabChooser
              overview={overview}
              tokens={tokens}
              compact={compact}
              onPick={addTab}
              onCancel={() => setMode("browse")}
            />
          ) : (
            content
          )}
        </View>

        {selection && overview && mode === "browse" ? (
          <View
            style={
              compact
                ? { height: 300, borderTopWidth: 1, borderTopColor: tokens.border, backgroundColor: tokens.raised }
                : {
                    width: DRAWER_WIDTH,
                    borderLeftWidth: 1,
                    borderLeftColor: tokens.border,
                    backgroundColor: tokens.raised,
                  }
            }
          >
            <DetailDrawer
              selection={selection}
              overview={overview}
              environmentId={environmentId}
              tokens={tokens}
              onClose={() => setSelectedKey(null)}
              onOpenLogs={openLogs}
              onRunCommand={(command) => openShell(command)}
            />
          </View>
        ) : null}
      </View>

      {dockTabs.length > 0 ? (
        <View>
          {dockVisible ? (
            <DockResizer
              heightValue={dockHeightValue}
              committedHeight={dockHeight}
              onCommit={commitDockHeight}
              tokens={tokens}
            />
          ) : null}
          <Animated.View
            style={{
              height: dockVisible ? dockHeightValue : undefined,
              backgroundColor: tokens.surface,
              borderTopWidth: dockVisible ? 0 : 1,
              borderTopColor: tokens.border,
            }}
          >
            <DockTabStrip
              tabs={dockTabs}
              activeId={activeDockId}
              tokens={tokens}
              onSelect={(id) => {
                setActiveDockId(id);
                setDockCollapsed(false);
              }}
              onClose={closeDockTab}
              onAddShell={() => openShell()}
              onCollapse={() => setDockCollapsed((value) => !value)}
            />
            {dockVisible && activeDock ? (
              activeDock.kind === "logs" ? (
                <LogsTab key={activeDock.id} pod={activeDock.pod} environmentId={environmentId} tokens={tokens} />
              ) : (
                <ShellTab
                  key={activeDock.id}
                  environmentId={environmentId}
                  environmentLabel={environmentLabel}
                  namespace={namespace}
                  tokens={tokens}
                  commandMode={config?.settings.commandMode ?? "allowlist"}
                  allowlist={config?.settings.commandAllowlist ?? []}
                  pendingCommand={pendingCommand}
                  onPendingConsumed={() => setPendingCommand(null)}
                  onOpenSettings={() => setMode("settings")}
                />
              )
            ) : null}
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

function OverviewPane({
  overview,
  tokens,
  compact,
}: {
  overview: Overview;
  tokens: Tokens;
  compact: boolean;
}) {
  const availability =
    overview.summary.desiredReplicas > 0
      ? overview.summary.readyReplicas / overview.summary.desiredReplicas
      : null;
  const tone =
    availability === null
      ? tokens.ink
      : availability >= 1
        ? STATUS.good
        : availability >= 0.8
          ? STATUS.serious
          : STATUS.critical;
  const present = PHASE_ORDER.filter((phase) => overview.phases[phase] > 0);

  return (
    <ScrollView contentContainerStyle={{ padding: compact ? 12 : 18, gap: 14 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
        <Card tokens={tokens} style={{ flexGrow: 1, flexBasis: 220 }}>
          <Text style={{ color: tokens.muted, fontSize: 11 }}>
            Replica availability · {overview.namespace ?? "all namespaces"}
          </Text>
          <Text style={{ color: tone, fontSize: compact ? 46 : 54, fontWeight: "600" }}>
            {availability === null ? "—" : `${Math.round(availability * 100)}%`}
          </Text>
          <Text style={{ color: tokens.muted, fontSize: 12 }}>
            {overview.summary.readyReplicas} of {overview.summary.desiredReplicas} replicas ready
          </Text>
        </Card>

        <View style={{ flexGrow: 3, flexBasis: 300, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <StatTile label="Workloads" value={String(overview.summary.workloads)} tokens={tokens} />
          <StatTile
            label="Degraded"
            value={String(overview.summary.degraded)}
            tone={overview.summary.degraded > 0 ? STATUS.critical : undefined}
            tokens={tokens}
          />
          <StatTile label="Pods" value={String(overview.summary.pods)} tokens={tokens} />
          <StatTile
            label="Restarts"
            value={String(overview.summary.restarts)}
            tone={overview.summary.restarts > 0 ? STATUS.serious : undefined}
            tokens={tokens}
          />
          <StatTile
            label="Warnings"
            value={String(overview.summary.warnings)}
            tone={overview.summary.warnings > 0 ? STATUS.warning : undefined}
            tokens={tokens}
          />
          <StatTile label="Nodes" value={String(overview.nodes.length)} tokens={tokens} />
        </View>
      </View>

      <Card tokens={tokens}>
        <Text style={{ color: tokens.ink, fontSize: 13, fontWeight: "600" }}>Pods by phase</Text>
        <View
          style={{
            flexDirection: "row",
            height: 10,
            borderRadius: 4,
            overflow: "hidden",
            backgroundColor: withAlpha(tokens.ink, 0.08),
            gap: 2,
          }}
        >
          {present.map((phase) => (
            <View
              key={phase}
              style={{
                flexGrow: overview.phases[phase],
                flexBasis: 0,
                backgroundColor: PHASE_STYLE[phase].color,
                borderRadius: 4,
              }}
            />
          ))}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {(present.length > 0 ? present : PHASE_ORDER.slice(0, 1)).map((phase) => (
            <View key={phase} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Text style={{ color: PHASE_STYLE[phase].color, fontSize: 10 }}>{PHASE_STYLE[phase].glyph}</Text>
              <Text style={{ color: tokens.muted, fontSize: 11 }}>{PHASE_STYLE[phase].label}</Text>
              <Text style={{ color: tokens.ink, fontSize: 11, fontVariant: ["tabular-nums"] }}>
                {overview.phases[phase]}
              </Text>
            </View>
          ))}
        </View>
      </Card>

      {overview.nodes.length > 0 ? (
        <Card tokens={tokens}>
          <Text style={{ color: tokens.ink, fontSize: 13, fontWeight: "600" }}>Node pressure</Text>
          {overview.nodes.map((node) => {
            const cpuRatio = node.cpuCapacityMilli && node.cpuMilli ? node.cpuMilli / node.cpuCapacityMilli : 0;
            const memRatio =
              node.memoryCapacityBytes && node.memoryBytes ? node.memoryBytes / node.memoryCapacityBytes : 0;
            const worst = Math.max(cpuRatio, memRatio);
            const nodeTone = worst > 0.9 ? STATUS.critical : worst > 0.75 ? STATUS.serious : STATUS.good;
            return (
              <View key={node.key} style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ color: tokens.muted, fontSize: 11, flex: 1 }} numberOfLines={1}>
                    {node.name}
                  </Text>
                  <Text style={{ color: tokens.muted, fontSize: 11, fontVariant: ["tabular-nums"] }}>
                    cpu {Math.round(cpuRatio * 100)}% · mem {Math.round(memRatio * 100)}%
                  </Text>
                </View>
                <Meter ratio={worst} color={nodeTone} />
              </View>
            );
          })}
        </Card>
      ) : null}

      {overview.warnings.length > 0 ? (
        <Banner tone="warning" title="Partial data" lines={overview.warnings} tokens={tokens} />
      ) : null}
    </ScrollView>
  );
}
