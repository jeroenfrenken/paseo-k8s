import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, PanResponder, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin";
import {
  getPodLogs,
  getToolingStatus,
  LOG_TAIL_OPTIONS,
  runCommand,
  type CommandResult,
  type EnvironmentId,
  type Pod,
  type PodLogs,
} from "./contracts";
import { clockTime, errorMessage, formatAge, STATUS, withAlpha, type Tokens } from "./theme.client";
import { Button, Chip, IconButton, SearchField } from "./ui.client";

export type DockTab =
  | { id: string; kind: "logs"; pod: Pod; title: string }
  | { id: string; kind: "shell"; title: string };

export const DOCK_MIN_HEIGHT = 120;
export const DOCK_DEFAULT_HEIGHT = 260;

export const DOCK_MAX_HEIGHT = 720;

function clampHeight(value: number): number {
  return Math.max(DOCK_MIN_HEIGHT, Math.min(DOCK_MAX_HEIGHT, value));
}

/**
 * Drag handle for the bottom dock.
 *
 * The height is driven by an Animated.Value, not React state: a drag emits a
 * move event per frame, and calling setState there re-rendered the entire
 * surface — header, tab strip, the whole resource table — on every one of them,
 * which is what made resizing lag. `setValue` updates the view directly, and
 * state is committed once on release so the size survives re-renders.
 */
export function DockResizer({
  heightValue,
  committedHeight,
  onCommit,
  tokens,
}: {
  heightValue: Animated.Value;
  committedHeight: number;
  onCommit: (next: number) => void;
  tokens: Tokens;
}) {
  const startHeight = useRef(committedHeight);
  const latest = useRef(committedHeight);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    latest.current = committedHeight;
  }, [committedHeight]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startHeight.current = latest.current;
          setDragging(true);
        },
        // Dragging up (negative dy) makes the dock taller.
        onPanResponderMove: (_event, gesture) => {
          const next = clampHeight(startHeight.current - gesture.dy);
          latest.current = next;
          heightValue.setValue(next);
        },
        onPanResponderRelease: () => {
          setDragging(false);
          onCommit(latest.current);
        },
        onPanResponderTerminate: () => {
          setDragging(false);
          onCommit(latest.current);
        },
      }),
    [heightValue, onCommit],
  );

  return (
    <View
      {...responder.panHandlers}
      style={{
        height: 12,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: dragging ? withAlpha(tokens.accent, 0.18) : "transparent",
        borderTopWidth: 1,
        borderTopColor: tokens.border,
      }}
    >
      <View style={{ width: 44, height: 3, borderRadius: 2, backgroundColor: dragging ? tokens.accent : tokens.border }} />
    </View>
  );
}

/** Monospace transcript body shared by the log and shell tabs. */
function Transcript({
  lines,
  tokens,
  empty,
}: {
  lines: { key: string; timestamp?: string | null; text: string; tone?: string }[];
  tokens: Tokens;
  empty: string;
}) {
  if (lines.length === 0) {
    // An empty string means "show nothing" — the shell needs no filler text.
    return empty === "" ? (
      <View style={{ flex: 1 }} />
    ) : (
      <Text style={{ color: tokens.muted, fontSize: 11, padding: 10 }}>{empty}</Text>
    );
  }
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 10 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {lines.map((line) => (
            <Text
              key={line.key}
              selectable
              style={{ color: line.tone ?? tokens.ink, fontFamily: tokens.mono, fontSize: 10, lineHeight: 15 }}
            >
              {line.timestamp ? <Text style={{ color: tokens.muted }}>{line.timestamp}  </Text> : null}
              {line.text === "" ? " " : line.text}
            </Text>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

export function LogsTab({
  pod,
  environmentId,
  tokens,
}: {
  pod: Pod;
  environmentId: EnvironmentId;
  tokens: Tokens;
}) {
  const fetchLogs = useRpc(getPodLogs);
  const fetchRef = useRef(fetchLogs);
  fetchRef.current = fetchLogs;

  const [container, setContainer] = useState<string | null>(pod.containerNames[0] ?? null);
  const [tailLines, setTailLines] = useState<number>(LOG_TAIL_OPTIONS[0]);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(false);
  const [filter, setFilter] = useState("");
  const [logs, setLogs] = useState<PodLogs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchRef
      .current({ environmentId, namespace: pod.namespace, pod: pod.name, container, tailLines, previous })
      .then((result) => {
        if (!active) return;
        setLogs(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLogs(null);
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [environmentId, pod.namespace, pod.name, container, tailLines, previous, reloadToken]);

  useEffect(() => {
    if (!follow) return;
    const timer = setInterval(() => setReloadToken((token) => token + 1), 5000);
    return () => clearInterval(timer);
  }, [follow]);

  const failure = error ?? logs?.error ?? null;
  const needle = filter.trim().toLowerCase();
  const lines = (logs?.lines ?? [])
    .filter((line) => needle === "" || line.text.toLowerCase().includes(needle))
    .map((line, index) => ({
      key: `${index}-${line.timestamp ?? ""}`,
      timestamp: clockTime(line.timestamp),
      text: line.text,
    }));

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "center",
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderBottomWidth: 1,
          borderBottomColor: tokens.border,
        }}
      >
        {pod.containerNames.length > 1
          ? pod.containerNames.map((name) => (
              <Chip key={name} label={name} selected={container === name} tokens={tokens} onPress={() => setContainer(name)} />
            ))
          : null}
        {LOG_TAIL_OPTIONS.map((option) => (
          <Chip
            key={option}
            label={String(option)}
            selected={tailLines === option}
            tokens={tokens}
            onPress={() => setTailLines(option)}
          />
        ))}
        {pod.restarts > 0 ? (
          <Chip label="Previous" selected={previous} tokens={tokens} onPress={() => setPrevious((value) => !value)} />
        ) : null}
        <Chip label="Follow" selected={follow} tokens={tokens} onPress={() => setFollow((value) => !value)} />
        <SearchField
          value={filter}
          onChange={setFilter}
          placeholder="Search in logs…"
          tokens={tokens}
          style={{ flexGrow: 1, flexBasis: 150 }}
        />
        {loading ? <ActivityIndicator color={tokens.muted} /> : null}
        <IconButton glyph="⟳" tokens={tokens} onPress={() => setReloadToken((token) => token + 1)} label="Reload" />
      </View>

      {failure ? (
        <Text style={{ color: STATUS.serious, fontSize: 11, padding: 10 }}>◆ {failure}</Text>
      ) : (
        <Transcript lines={lines} tokens={tokens} empty={loading ? "Loading…" : "No log lines in this range."} />
      )}

      {logs && !failure ? (
        <Text style={{ color: tokens.muted, fontSize: 10, paddingHorizontal: 10, paddingBottom: 6 }}>
          {lines.length}
          {needle === "" ? "" : ` of ${logs.lines.length}`} lines
          {logs.container ? ` · ${logs.container}` : ""}
          {logs.previous ? " · previous container" : ""} · read {formatAge(logs.fetchedAt)} ago
        </Text>
      ) : null}
    </View>
  );
}

interface TranscriptEntry {
  key: string;
  command: string;
  result: CommandResult | null;
  error: string | null;
}

export function ShellTab({
  environmentId,
  environmentLabel,
  namespace,
  tokens,
  commandMode,
  allowlist,
  pendingCommand,
  onPendingConsumed,
  onOpenSettings,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  namespace: string | null;
  tokens: Tokens;
  commandMode: "allowlist" | "bash";
  allowlist: string[];
  pendingCommand: string | null;
  onPendingConsumed: () => void;
  onOpenSettings: () => void;
}) {
  const run = useRpc(runCommand);
  const tooling = useRpc(getToolingStatus);
  const runRef = useRef(run);
  runRef.current = run;

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const counter = useRef(0);
  const bash = commandMode === "bash";

  // Only surfaced when something is wrong: a working shell needs no announcement.
  useEffect(() => {
    let active = true;
    tooling({})
      .then((result) => {
        if (!active) return;
        const kubectl = result.allowed.find((entry) => entry.name === "kubectl");
        setStatus(kubectl?.path ? null : "kubectl was not found on this machine.");
      })
      .catch(() => {
        if (active) setStatus(null);
      });
    return () => {
      active = false;
    };
  }, [tooling]);

  const submit = useRef((command: string) => {
    void command;
  });
  submit.current = (command: string) => {
    const trimmed = command.trim();
    if (trimmed === "" || busy) return;
    counter.current += 1;
    const key = `entry-${counter.current}`;
    setEntries((current) => [...current, { key, command: trimmed, result: null, error: null }]);
    setHistory((current) => (current[current.length - 1] === trimmed ? current : [...current, trimmed]));
    setHistoryIndex(null);
    setInput("");
    setBusy(true);
    runRef
      .current({ environmentId, command: trimmed, namespace })
      .then((result) => {
        setEntries((current) => current.map((entry) => (entry.key === key ? { ...entry, result } : entry)));
      })
      .catch((cause: unknown) => {
        setEntries((current) =>
          current.map((entry) => (entry.key === key ? { ...entry, error: errorMessage(cause) } : entry)),
        );
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    if (pendingCommand === null) return;
    setInput(pendingCommand);
    onPendingConsumed();
  }, [pendingCommand, onPendingConsumed]);

  const lines = entries.flatMap((entry) => {
    const rows: { key: string; text: string; tone?: string }[] = [
      { key: `${entry.key}-cmd`, text: `$ ${entry.command}`, tone: tokens.accent },
    ];
    if (entry.error) {
      rows.push({ key: `${entry.key}-err`, text: entry.error, tone: STATUS.critical });
      return rows;
    }
    if (!entry.result) {
      rows.push({ key: `${entry.key}-wait`, text: "running…", tone: tokens.muted });
      return rows;
    }
    const { result } = entry;
    if (result.refused) {
      rows.push({ key: `${entry.key}-refused`, text: result.refused, tone: STATUS.warning });
      return rows;
    }
    for (const [index, line] of result.stdout.split("\n").entries()) {
      if (index === result.stdout.split("\n").length - 1 && line === "") continue;
      rows.push({ key: `${entry.key}-out-${index}`, text: line });
    }
    for (const [index, line] of result.stderr.split("\n").entries()) {
      if (line === "") continue;
      rows.push({ key: `${entry.key}-err-${index}`, text: line, tone: STATUS.serious });
    }
    if (result.exitCode !== 0) {
      rows.push({
        key: `${entry.key}-exit`,
        text: `exit ${result.exitCode ?? "?"}${result.signal ? ` (${result.signal})` : ""} · ${result.durationMs}ms`,
        tone: STATUS.critical,
      });
    }
    return rows;
  });

  return (
    <View style={{ flex: 1 }}>
      <Transcript lines={lines} tokens={tokens} empty={status ?? ""} />

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderTopWidth: 1,
          borderTopColor: tokens.border,
        }}
      >
        <Text style={{ color: tokens.muted, fontSize: 11 }} numberOfLines={1}>
          {environmentLabel}
          {namespace ? `/${namespace}` : ""}
        </Text>
        {bash ? (
          <Pressable onPress={onOpenSettings} hitSlop={6}>
            <Text style={{ color: STATUS.warning, fontSize: 10 }}>▲ bash</Text>
          </Pressable>
        ) : null}
        <Text style={{ color: tokens.accent, fontFamily: tokens.mono, fontSize: 12 }}>❯</Text>
        <TextInput
          value={input}
          onChangeText={setInput}
          onSubmitEditing={() => submit.current(input)}
          onKeyPress={(event) => {
            const key = (event.nativeEvent as { key?: string }).key;
            if (key !== "ArrowUp" && key !== "ArrowDown") return;
            setHistoryIndex((current) => {
              if (history.length === 0) return current;
              const next =
                key === "ArrowUp"
                  ? current === null
                    ? history.length - 1
                    : Math.max(0, current - 1)
                  : current === null
                    ? null
                    : Math.min(history.length - 1, current + 1);
              if (next !== null) setInput(history[next]);
              return next;
            });
          }}
          placeholder={bash ? "kubectl get pods | head -5" : "kubectl get pods"}
          placeholderTextColor={tokens.muted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="send"
          style={{ flex: 1, color: tokens.ink, fontFamily: tokens.mono, fontSize: 12, paddingVertical: 4 }}
        />
        {busy ? <ActivityIndicator color={tokens.muted} /> : null}
        {entries.length > 0 ? (
          <IconButton glyph="⌫" tokens={tokens} onPress={() => setEntries([])} />
        ) : null}
        <IconButton glyph="⚙" tokens={tokens} onPress={onOpenSettings} />
        <Button label="Run" tone="primary" tokens={tokens} onPress={() => submit.current(input)} disabled={busy} />
      </View>
    </View>
  );
}

export function DockTabStrip({
  tabs,
  activeId,
  tokens,
  onSelect,
  onClose,
  onAddShell,
  onCollapse,
}: {
  tabs: DockTab[];
  activeId: string | null;
  tokens: Tokens;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAddShell: () => void;
  onCollapse: () => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: tokens.border }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: "center" }}>
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <Pressable
              key={tab.id}
              onPress={() => onSelect(tab.id)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 10,
                paddingVertical: 7,
                backgroundColor: active ? tokens.raised : "transparent",
                borderBottomWidth: 2,
                borderBottomColor: active ? tokens.accent : "transparent",
              }}
            >
              <Text style={{ color: active ? tokens.ink : tokens.muted, fontSize: 11 }}>
                {tab.kind === "shell" ? "❯" : "≡"}
              </Text>
              <Text
                style={{ color: active ? tokens.ink : tokens.muted, fontSize: 11, maxWidth: 200 }}
                numberOfLines={1}
              >
                {tab.title}
              </Text>
              <Pressable onPress={() => onClose(tab.id)} hitSlop={8}>
                <Text style={{ color: tokens.muted, fontSize: 13 }}>×</Text>
              </Pressable>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={{ flexDirection: "row", gap: 4, paddingHorizontal: 8 }}>
        {tabs.some((tab) => tab.kind === "shell") ? null : (
          <IconButton glyph="❯" tokens={tokens} onPress={onAddShell} label="Shell" />
        )}
        <IconButton glyph="▾" tokens={tokens} onPress={onCollapse} />
      </View>
    </View>
  );
}
