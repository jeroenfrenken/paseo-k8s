import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin";
import { launchAgent, listAgentTargets, type EnvironmentId } from "./contracts";
import { errorMessage, STATUS, type Tokens } from "./theme.client";
import { Button, Chip, Dropdown } from "./ui.client";

/** Prefer the provider's own default model, else its first. */
function defaultModelOf(provider: { models: ModelTarget[] } | null): string | null {
  if (!provider) return null;
  return (provider.models.find((model) => model.isDefault) ?? provider.models[0])?.id ?? null;
}

interface ProjectTarget {
  id: string;
  name: string;
  rootPath: string;
  supportsWorktree: boolean;
}

interface ModelTarget {
  id: string;
  label: string;
  description: string | null;
  isDefault: boolean;
}

interface ProviderTarget {
  id: string;
  label: string;
  models: ModelTarget[];
}

/**
 * "Ask an agent" panel. Builds the same live cluster context the attachment
 * picker produces and hands it to a new Paseo agent as its opening prompt.
 */
export function LaunchAgentPanel({
  environmentId,
  resourceKey,
  resourceLabel,
  defaultInstruction,
  tokens,
  onClose,
}: {
  environmentId: EnvironmentId;
  resourceKey: string;
  resourceLabel: string;
  defaultInstruction: string;
  tokens: Tokens;
  onClose: () => void;
}) {
  const loadTargets = useRpc(listAgentTargets);
  const launch = useRpc(launchAgent);
  const rpc = useRef({ loadTargets, launch });
  rpc.current = { loadTargets, launch };

  const [projects, setProjects] = useState<ProjectTarget[]>([]);
  const [providers, setProviders] = useState<ProviderTarget[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [isolation, setIsolation] = useState<"worktree" | "directory">("worktree");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState(defaultInstruction);
  const [busy, setBusy] = useState(false);
  const [loadingTargets, setLoadingTargets] = useState(true);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    rpc.current
      .loadTargets({})
      .then((targets) => {
        if (!active) return;
        setProjects(targets.projects);
        setProviders(targets.providers);
        setProjectId((current) => current ?? targets.projects[0]?.id ?? null);
        const firstProvider = targets.providers[0] ?? null;
        setProviderId((current) => current ?? firstProvider?.id ?? null);
        setModelId(
          (current) =>
            current ?? defaultModelOf(firstProvider),
        );
        if (targets.error) setTargetsError(targets.error);
      })
      .catch((error: unknown) => {
        if (active) setTargetsError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoadingTargets(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const provider = providers.find((entry) => entry.id === providerId) ?? null;
  const models = provider?.models ?? [];
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  // A non-git project cannot host a worktree; fall back without asking.
  const effectiveIsolation: "worktree" | "directory" =
    project && !project.supportsWorktree ? "directory" : isolation;

  function submit() {
    if (!projectId || !providerId || !modelId || busy) return;
    setBusy(true);
    setResult(null);
    rpc.current
      .launch({
        environmentId,
        resourceKey,
        projectId,
        isolation: effectiveIsolation,
        // The daemon takes provider and model as one `provider/model` string.
        provider: `${providerId}/${modelId}`,
        instruction,
      })
      .then((response) => setResult({ ok: response.ok, message: response.message }))
      .catch((error: unknown) => setResult({ ok: false, message: errorMessage(error) }))
      .finally(() => setBusy(false));
  }

  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: tokens.border, borderRadius: 9, padding: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: tokens.ink, fontSize: 12, fontWeight: "600", flex: 1 }}>
          Ask an agent about {resourceLabel}
        </Text>
        <Button label="Cancel" tokens={tokens} onPress={onClose} />
      </View>

      <Text style={{ color: tokens.muted, fontSize: 10 }}>
        Creates a fresh workspace and starts an agent in it with a live snapshot of this
        resource: status, events and logs.
      </Text>

      <TextInput
        value={instruction}
        onChangeText={setInstruction}
        placeholder="What should the agent do?"
        placeholderTextColor={tokens.muted}
        multiline
        style={{
          borderWidth: 1,
          borderColor: tokens.border,
          borderRadius: 8,
          paddingHorizontal: 9,
          paddingVertical: 7,
          color: tokens.ink,
          fontSize: 12,
          minHeight: 54,
        }}
      />

      <Text style={{ color: tokens.muted, fontSize: 10 }}>New workspace in project</Text>
      {loadingTargets ? (
        <Text style={{ color: tokens.muted, fontSize: 11 }}>Loading projects…</Text>
      ) : projects.length === 0 ? (
        <Text style={{ color: STATUS.critical, fontSize: 11 }}>
          ■ {targetsError ?? "No projects came back."}
        </Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {projects.map((entry) => (
            <Chip
              key={entry.id}
              label={entry.name}
              selected={projectId === entry.id}
              tokens={tokens}
              onPress={() => setProjectId(entry.id)}
            />
          ))}
        </ScrollView>
      )}

      {project ? (
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Chip
            label="Worktree"
            selected={effectiveIsolation === "worktree"}
            tokens={tokens}
            onPress={() => setIsolation("worktree")}
          />
          <Chip
            label="Local"
            selected={effectiveIsolation === "directory"}
            tokens={tokens}
            onPress={() => setIsolation("directory")}
          />
          {!project.supportsWorktree ? (
            <Text style={{ color: tokens.muted, fontSize: 10 }}>{project.name} is not a git project</Text>
          ) : null}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <View style={{ flexGrow: 1, flexBasis: 130, gap: 4 }}>
          <Text style={{ color: tokens.muted, fontSize: 10 }}>Agent</Text>
          <Dropdown
            value={providerId}
            options={providers.map((entry) => ({ value: entry.id, label: entry.label }))}
            onSelect={(value) => {
              setProviderId(value);
              // Model ids are provider-specific, so re-pick when the agent changes.
              setModelId(defaultModelOf(providers.find((entry) => entry.id === value) ?? null));
            }}
            tokens={tokens}
            title="Agent"
            placeholder="Loading…"
            minWidth={130}
          />
        </View>
        <View style={{ flexGrow: 2, flexBasis: 180, gap: 4 }}>
          <Text style={{ color: tokens.muted, fontSize: 10 }}>Model</Text>
          <Dropdown
            value={modelId}
            options={models.map((model) => ({
              value: model.id,
              label: model.isDefault ? `${model.label}  ·  default` : model.label,
              detail: model.description ?? undefined,
            }))}
            onSelect={setModelId}
            tokens={tokens}
            title={provider ? `${provider.label} models` : "Model"}
            placeholder={models.length === 0 ? "No models" : "Select a model"}
            searchable={models.length > 8}
            minWidth={180}
          />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button
          label="Launch agent"
          tone="primary"
          tokens={tokens}
          disabled={busy || !projectId || !providerId || !modelId}
          onPress={submit}
        />
        {busy ? <ActivityIndicator color={tokens.muted} /> : null}
      </View>

      {targetsError && projects.length > 0 ? (
        <Text style={{ color: STATUS.warning, fontSize: 11 }}>▲ {targetsError}</Text>
      ) : null}

      {result ? (
        <Text style={{ color: result.ok ? STATUS.good : STATUS.critical, fontSize: 11 }}>
          {result.ok ? "●" : "■"} {result.message}
        </Text>
      ) : null}
    </View>
  );
}
