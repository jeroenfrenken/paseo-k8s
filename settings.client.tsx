import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin";
import {
  checkConnection,
  getToolingStatus,
  inspectKubeconfig,
  pointAtConfigFile,
  resetConfigPointer,
  saveConfig,
  type ConfigState,
  type Environment,
  type EnvironmentId,
  slugifyEnvironmentId,
  type Settings,
} from "./contracts";
import { errorMessage, STATUS, withAlpha, type Tokens } from "./theme.client";
import { Banner, Button, Dropdown, FieldRow, SectionLabel, TextField, Toggle } from "./ui.client";

type SectionId = "clusters" | "commands" | "gitops" | "storage";

const SECTIONS: { id: SectionId; title: string; glyph: string; blurb: string }[] = [
  { id: "clusters", title: "Clusters", glyph: "◈", blurb: "Kubeconfig, context and default namespace per environment" },
  { id: "commands", title: "Command bar", glyph: "❯", blurb: "What the shell may run, and for how long" },
  { id: "gitops", title: "GitOps", glyph: "⟳", blurb: "Where the Flux repo is checked out" },
  { id: "storage", title: "Config file", glyph: "▤", blurb: "Where these settings are stored" },
];

function ClusterEditor({
  environment,
  tokens,
  onChange,
  onRemove,
  onTest,
  status,
}: {
  environment: Environment;
  tokens: Tokens;
  onChange: (next: Environment) => void;
  onRemove: () => void;
  onTest: () => void;
  status: string | null;
}) {
  const inspect = useRpc(inspectKubeconfig);
  const inspectRef = useRef(inspect);
  inspectRef.current = inspect;

  const [contexts, setContexts] = useState<string[]>([]);
  const [currentContext, setCurrentContext] = useState<string | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const path = environment.kubeconfig;
  useEffect(() => {
    let active = true;
    if (path.trim() === "") {
      setContexts([]);
      setCurrentContext(null);
      setInspectError(null);
      return;
    }
    inspectRef
      .current({ path })
      .then((info) => {
        if (!active) return;
        setContexts(info.contexts);
        setCurrentContext(info.currentContext);
        setInspectError(info.exists ? info.error : "File not found.");
      })
      .catch((error: unknown) => {
        if (active) setInspectError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [path]);

  return (
    <View
      style={{
        gap: 12,
        padding: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.raised,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: environment.isProduction ? STATUS.critical : STATUS.good, fontSize: 10 }}>●</Text>
        <Text style={{ color: tokens.ink, fontSize: 14, fontWeight: "600", flex: 1 }}>{environment.label}</Text>
        <Text style={{ color: tokens.muted, fontSize: 10, fontFamily: tokens.mono }}>{environment.id}</Text>
        {confirming ? (
          <>
            <Button label="Really remove" tone="danger" tokens={tokens} onPress={onRemove} />
            <Button label="Keep" tokens={tokens} onPress={() => setConfirming(false)} />
          </>
        ) : (
          <Button label="Remove" tokens={tokens} onPress={() => setConfirming(true)} />
        )}
      </View>

      <FieldRow label="Display name" tokens={tokens}>
        <TextField
          value={environment.label}
          onChange={(value) => onChange({ ...environment, label: value })}
          placeholder="Staging"
          tokens={tokens}
        />
      </FieldRow>

      <Toggle
        label="This is a production cluster"
        hint="Shows it in red throughout the panel so it is hard to mistake for staging."
        value={environment.isProduction}
        onChange={(value) => onChange({ ...environment, isProduction: value })}
        tokens={tokens}
      />

      <FieldRow label="Kubeconfig file" hint="Absolute path; ~ is expanded." tokens={tokens}>
        <TextField
          value={environment.kubeconfig}
          onChange={(value) => onChange({ ...environment, kubeconfig: value })}
          placeholder="~/.config/kubernetes-mcp/staging.kubeconfig"
          tokens={tokens}
          mono
        />
      </FieldRow>

      {inspectError ? <Text style={{ color: STATUS.serious, fontSize: 11 }}>◆ {inspectError}</Text> : null}

      {contexts.length > 0 ? (
        <FieldRow label="Context" tokens={tokens}>
          <Dropdown
            value={environment.context ?? "__default__"}
            options={[
              { value: "__default__", label: `Default${currentContext ? ` (${currentContext})` : ""}` },
              ...contexts.map((name) => ({ value: name, label: name })),
            ]}
            onSelect={(value) => onChange({ ...environment, context: value === "__default__" ? null : value })}
            tokens={tokens}
            title="Kubeconfig context"
            minWidth={220}
          />
        </FieldRow>
      ) : null}

      <FieldRow label="Default namespace" hint="Blank opens on all namespaces." tokens={tokens}>
        <TextField
          value={environment.namespace ?? ""}
          onChange={(value) => onChange({ ...environment, namespace: value === "" ? null : value })}
          placeholder="all namespaces"
          tokens={tokens}
        />
      </FieldRow>

      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button label="Test connection" tokens={tokens} onPress={onTest} />
        {status ? <Text style={{ color: tokens.muted, fontSize: 11, flexShrink: 1 }}>{status}</Text> : null}
      </View>
    </View>
  );
}

const MODES: {
  value: "allowlist" | "bash";
  title: string;
  summary: string;
  detail: (allowlist: string[]) => string;
}[] = [
  {
    value: "allowlist",
    title: "Allowlist only",
    summary: "Recommended. Only the programs you list can run.",
    detail: (allowlist) =>
      `The first word must be one of: ${allowlist.join(", ") || "(none listed)"}. The line is split into ` +
      "arguments directly, without a shell, so quoting tricks and injection cannot happen. Pipes (|), " +
      "redirects (>) and wildcards (*) are refused.",
  },
  {
    value: "bash",
    title: "Full bash",
    summary: "Anything you could type in a terminal.",
    detail: () =>
      "The whole line is handed to `bash -lc`. Pipes, redirects and wildcards work, and any program on your " +
      "PATH can run — including ones that delete things. There is no allowlist in this mode.",
  },
];

function ModeChoice({
  value,
  onChange,
  allowlist,
  tokens,
}: {
  value: "allowlist" | "bash";
  onChange: (next: "allowlist" | "bash") => void;
  allowlist: string[];
  tokens: Tokens;
}) {
  return (
    <View style={{ gap: 8 }}>
      {MODES.map((mode) => {
        const active = mode.value === value;
        const danger = mode.value === "bash";
        return (
          <Pressable
            key={mode.value}
            onPress={() => onChange(mode.value)}
            style={{
              flexDirection: "row",
              gap: 10,
              padding: 12,
              borderRadius: 9,
              borderWidth: active ? 2 : 1,
              borderColor: active ? (danger ? STATUS.warning : tokens.accent) : tokens.border,
              backgroundColor: active ? withAlpha(danger ? STATUS.warning : tokens.accent, 0.07) : "transparent",
            }}
          >
            <View
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                borderWidth: 2,
                marginTop: 1,
                borderColor: active ? (danger ? STATUS.warning : tokens.accent) : tokens.border,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {active ? (
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: danger ? STATUS.warning : tokens.accent,
                  }}
                />
              ) : null}
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={{ color: tokens.ink, fontSize: 13, fontWeight: "600" }}>{mode.title}</Text>
                {danger ? <Text style={{ color: STATUS.warning, fontSize: 11 }}>▲ less safe</Text> : null}
              </View>
              <Text style={{ color: tokens.ink, fontSize: 11 }}>{mode.summary}</Text>
              <Text style={{ color: tokens.muted, fontSize: 11 }}>{mode.detail(allowlist)}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SettingsScreen({
  config,
  tokens,
  compact,
  onConfigChange,
  onClose,
}: {
  config: ConfigState;
  tokens: Tokens;
  compact: boolean;
  onConfigChange: (next: ConfigState) => void;
  onClose: () => void;
}) {
  const save = useRpc(saveConfig);
  const point = useRpc(pointAtConfigFile);
  const reset = useRpc(resetConfigPointer);
  const test = useRpc(checkConnection);
  const tooling = useRpc(getToolingStatus);

  const [section, setSection] = useState<SectionId>("clusters");
  const [environments, setEnvironments] = useState<Environment[]>(config.environments);
  const [settings, setSettings] = useState<Settings>(config.settings);
  const [allowlistText, setAllowlistText] = useState(config.settings.commandAllowlist.join(", "));
  const [pointerPath, setPointerPath] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [toolingLine, setToolingLine] = useState<string | null>(null);

  useEffect(() => {
    setEnvironments(config.environments);
    setSettings(config.settings);
    setAllowlistText(config.settings.commandAllowlist.join(", "));
  }, [config]);

  useEffect(() => {
    let active = true;
    tooling({})
      .then((result) => {
        if (!active) return;
        setToolingLine(result.allowed.map((entry) => `${entry.name}: ${entry.path ?? "not found"}`).join("\n"));
      })
      .catch(() => {
        if (active) setToolingLine(null);
      });
    return () => {
      active = false;
    };
  }, [tooling, config.settings.commandAllowlist.join(",")]);

  const parsedAllowlist = allowlistText
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  const persist = useCallback(
    (next?: { environments?: Environment[]; settings?: Settings }) =>
      save({
        environments: next?.environments ?? environments,
        settings: next?.settings ?? { ...settings, commandAllowlist: parsedAllowlist },
      }),
    [environments, settings, parsedAllowlist, save],
  );

  // Adding and removing a cluster writes immediately. Editing fields inside one
  // still needs Save — but a list operation that only changed local state read
  // as broken, because leaving the screen threw the change away.
  const commitList = useCallback(
    (nextEnvironments: Environment[], message: string) => {
      setEnvironments(nextEnvironments);
      persist({ environments: nextEnvironments })
        .then((state) => {
          onConfigChange(state);
          setNotice(message);
        })
        .catch((error: unknown) => setNotice(errorMessage(error)));
    },
    [onConfigChange, persist],
  );

  const addCluster = useCallback(() => {
    const taken = environments.map((entry) => entry.id);
    const label = `Cluster ${environments.length + 1}`;
    const created: Environment = {
      id: slugifyEnvironmentId(label, taken),
      label,
      kubeconfig: "",
      context: null,
      namespace: null,
      isProduction: false,
    };
    commitList([...environments, created], `Added ${created.label}. Give it a kubeconfig.`);
  }, [environments, commitList]);

  const removeCluster = useCallback(
    (id: string) => {
      const target = environments.find((entry) => entry.id === id);
      commitList(
        environments.filter((entry) => entry.id !== id),
        `Removed ${target?.label ?? id}.`,
      );
    },
    [environments, commitList],
  );

  const runTest = useCallback(
    (environmentId: EnvironmentId) => {
      setStatuses((current) => ({ ...current, [environmentId]: "Checking…" }));
      persist()
        .then((state) => {
          onConfigChange(state);
          return test({ environmentId });
        })
        .then((result) => {
          setStatuses((current) => ({
            ...current,
            [environmentId]: result.ok ? `● ${result.message}` : `■ ${result.message}`,
          }));
        })
        .catch((error: unknown) => {
          setStatuses((current) => ({ ...current, [environmentId]: errorMessage(error) }));
        });
    },
    [onConfigChange, persist, test],
  );

  const saveAll = useCallback(() => {
    persist()
      .then((state) => {
        onConfigChange(state);
        setNotice(`Saved to ${state.configPath}`);
      })
      .catch((error: unknown) => setNotice(errorMessage(error)));
  }, [onConfigChange, persist]);

  const sidebar = (
    <View
      style={
        compact
          ? { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 10 }
          : {
              width: 214,
              borderRightWidth: 1,
              borderRightColor: tokens.border,
              paddingVertical: 12,
              paddingHorizontal: 8,
              gap: 2,
            }
      }
    >
      {!compact ? <SectionLabel text="Settings" tokens={tokens} style={{ paddingHorizontal: 8, paddingBottom: 8 }} /> : null}
      {SECTIONS.map((entry) => {
        const active = entry.id === section;
        return (
          <Pressable
            key={entry.id}
            onPress={() => setSection(entry.id)}
            style={{
              flexDirection: "row",
              alignItems: compact ? "center" : "flex-start",
              gap: 8,
              paddingHorizontal: 10,
              paddingVertical: compact ? 6 : 9,
              borderRadius: 8,
              borderWidth: compact ? 1 : 0,
              borderColor: active ? tokens.accent : tokens.border,
              backgroundColor: active ? (compact ? tokens.accent : tokens.rowSelected) : "transparent",
            }}
          >
            <Text style={{ color: active && compact ? tokens.accentInk : tokens.muted, fontSize: 11 }}>
              {entry.glyph}
            </Text>
            <View style={{ flex: compact ? 0 : 1 }}>
              <Text
                style={{
                  color: active && compact ? tokens.accentInk : tokens.ink,
                  fontSize: 12,
                  fontWeight: active ? "600" : "400",
                }}
              >
                {entry.title}
              </Text>
              {!compact ? (
                <Text style={{ color: tokens.muted, fontSize: 10, marginTop: 2 }}>{entry.blurb}</Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );

  const body = (() => {
    if (section === "clusters") {
      return (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <SectionLabel text={`Clusters (${environments.length})`} tokens={tokens} />
            <View style={{ flex: 1 }} />
            <Button label="+ Add cluster" tokens={tokens} onPress={addCluster} />
          </View>
          <Text style={{ color: tokens.muted, fontSize: 11 }}>
            Add as many as you like. Each one is a kubeconfig plus a context; the panel switches between them from
            the dropdown in the header.
          </Text>

          {config.issues.map((issue) => (
            <Text key={`${issue.environmentId}-${issue.message}`} style={{ color: STATUS.serious, fontSize: 11 }}>
              ◆ {issue.message}
            </Text>
          ))}

          {environments.length === 0 ? (
            <Text style={{ color: tokens.muted, fontSize: 12 }}>
              No clusters yet. Add one and point it at a kubeconfig.
            </Text>
          ) : (
            environments.map((environment) => (
              <ClusterEditor
                key={environment.id}
                environment={environment}
                tokens={tokens}
                onChange={(next) =>
                  setEnvironments((current) => current.map((entry) => (entry.id === next.id ? next : entry)))
                }
                onRemove={() => removeCluster(environment.id)}
                onTest={() => runTest(environment.id)}
                status={statuses[environment.id] ?? null}
              />
            ))
          )}
        </>
      );
    }

    if (section === "commands") {
      return (
        <>
          <SectionLabel text="Command bar" tokens={tokens} />
          <Text style={{ color: tokens.muted, fontSize: 11 }}>
            The shell tab runs one command at a time with KUBECONFIG set for the selected environment. It is not a
            TTY, so interactive commands like `kubectl exec -it` will not work.
          </Text>

          <FieldRow
            label="Allowed programs"
            hint="Comma separated. Used by Allowlist mode only."
            tokens={tokens}
          >
            <TextField value={allowlistText} onChange={setAllowlistText} placeholder="kubectl, helm" tokens={tokens} mono />
          </FieldRow>

          <FieldRow label="How commands run" tokens={tokens}>
            <ModeChoice
              value={settings.commandMode}
              onChange={(value) => setSettings((current) => ({ ...current, commandMode: value }))}
              allowlist={parsedAllowlist}
              tokens={tokens}
            />
          </FieldRow>

          <FieldRow label="Timeout (seconds)" tokens={tokens}>
            <TextField
              value={String(settings.commandTimeoutSeconds)}
              onChange={(value) =>
                setSettings((current) => ({
                  ...current,
                  commandTimeoutSeconds: Number.parseInt(value, 10) || current.commandTimeoutSeconds,
                }))
              }
              tokens={tokens}
            />
          </FieldRow>

          {toolingLine ? (
            <FieldRow label="Found on this machine" tokens={tokens}>
              <Text style={{ color: tokens.muted, fontSize: 11, fontFamily: tokens.mono }}>{toolingLine}</Text>
            </FieldRow>
          ) : null}
        </>
      );
    }

    if (section === "gitops") {
      return (
        <>
          <SectionLabel text="GitOps" tokens={tokens} />
          <Text style={{ color: tokens.muted, fontSize: 11 }}>
            With a local checkout of the Flux repo, the Flux tab can name the deployed revision and list commits the
            cluster has not applied yet. It is only ever read: never fetched, never modified.
          </Text>
          <FieldRow label="Flux repo path" hint="Leave blank to auto-detect ~/flux." tokens={tokens}>
            <TextField
              value={settings.fluxRepoPath ?? ""}
              onChange={(value) => setSettings((current) => ({ ...current, fluxRepoPath: value === "" ? null : value }))}
              placeholder="~/flux"
              tokens={tokens}
              mono
            />
          </FieldRow>
        </>
      );
    }

    return (
      <>
        <SectionLabel text="Config file" tokens={tokens} />
        <Text style={{ color: tokens.muted, fontSize: 11, fontFamily: tokens.mono }}>
          {config.configPath}
          {config.configExists ? "" : "  (not created yet)"}
        </Text>
        <Text style={{ color: tokens.muted, fontSize: 11 }}>Source: {config.source}</Text>

        <FieldRow
          label="Use a config file elsewhere"
          hint="Point at another clusters.json and the panel reads and writes that instead."
          tokens={tokens}
        >
          <TextField value={pointerPath} onChange={setPointerPath} placeholder="/path/to/clusters.json" tokens={tokens} mono />
        </FieldRow>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button
            label="Load"
            tokens={tokens}
            onPress={() => {
              point({ path: pointerPath })
                .then((state) => {
                  onConfigChange(state);
                  setNotice(`Now reading ${state.configPath}`);
                })
                .catch((error: unknown) => setNotice(errorMessage(error)));
            }}
          />
          <Button
            label="Use default"
            tokens={tokens}
            onPress={() => {
              reset({})
                .then((state) => {
                  onConfigChange(state);
                  setNotice(`Back to ${state.configPath}`);
                })
                .catch((error: unknown) => setNotice(errorMessage(error)));
            }}
          />
        </View>
      </>
    );
  })();

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: compact ? 12 : 18,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: tokens.border,
        }}
      >
        <Text style={{ color: tokens.ink, fontSize: compact ? 17 : 20, fontWeight: "600", flex: 1 }}>Settings</Text>
        <Button label="Save" tone="primary" tokens={tokens} onPress={saveAll} />
        <Button label="Done" tokens={tokens} onPress={onClose} />
      </View>

      <View style={{ flex: 1, flexDirection: compact ? "column" : "row" }}>
        {sidebar}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 12 : 18, gap: 14 }}>
          {notice ? <Banner tone="warning" title="Config" lines={[notice]} tokens={tokens} /> : null}
          {body}
        </ScrollView>
      </View>
    </View>
  );
}
