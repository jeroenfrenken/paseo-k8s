import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  EnvironmentSchema,
  SettingsSchema,
  slugifyEnvironmentId,
  type ConfigState,
  type Environment,
  type EnvironmentId,
  type Settings,
} from "./contracts";
import { expandHome } from "./kubeconfig.server";

const CONFIG_FILENAME = "clusters.json";

function configHome(): string {
  return process.env.PASEO_K8S_HOME
    ? expandHome(process.env.PASEO_K8S_HOME)
    : path.join(os.homedir(), ".config", "paseo-k8s");
}

/** Records which clusters.json the user pointed the panel at. */
function pointerPath(): string {
  return path.join(configHome(), "pointer.json");
}

function readPointer(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(pointerPath(), "utf8")) as { path?: unknown };
    return typeof parsed.path === "string" && parsed.path !== "" ? expandHome(parsed.path) : null;
  } catch {
    return null;
  }
}

export function activeConfigPath(): { path: string; source: "config-file" | "env-var" } {
  const fromEnv = process.env.PASEO_K8S_CONFIG;
  if (fromEnv) return { path: expandHome(fromEnv), source: "env-var" };
  const pointed = readPointer();
  if (pointed) return { path: pointed, source: "config-file" };
  return { path: path.join(configHome(), CONFIG_FILENAME), source: "config-file" };
}

function normalizeEnvironment(raw: unknown, taken: string[]): Environment | null {
  if (raw === null || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const label = typeof entry.label === "string" && entry.label !== "" ? entry.label : "Cluster";
  const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : slugifyEnvironmentId(label, taken);
  const parsed = EnvironmentSchema.safeParse({
    id,
    label,
    kubeconfig: typeof entry.kubeconfig === "string" ? entry.kubeconfig : "",
    context: typeof entry.context === "string" && entry.context !== "" ? entry.context : null,
    namespace: typeof entry.namespace === "string" && entry.namespace !== "" ? entry.namespace : null,
    // Default the production flag from the name, so an imported config still
    // gets the red accent on the cluster you would not want to poke by mistake.
    isProduction:
      typeof entry.isProduction === "boolean" ? entry.isProduction : /prod/i.test(`${id} ${label}`),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Accepts either shape:
 *   { "environments": [ { "id": "staging", ... } ] }
 *   { "staging": { "kubeconfig": "..." }, "prod": { ... } }   // legacy
 */
export function readConfigFile(target: string): Environment[] | null {
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${target} is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const doc = parsed as Record<string, unknown>;
  const environments: Environment[] = [];
  const taken: string[] = [];

  const push = (raw: unknown, fallbackId?: string) => {
    const source =
      fallbackId && raw !== null && typeof raw === "object" && !("id" in (raw as object))
        ? { ...(raw as Record<string, unknown>), id: fallbackId }
        : raw;
    const environment = normalizeEnvironment(source, taken);
    if (environment && !taken.includes(environment.id)) {
      taken.push(environment.id);
      environments.push(environment);
    }
  };

  if (Array.isArray(doc.environments)) {
    for (const raw of doc.environments) push(raw);
  } else {
    // COMPAT: the first version keyed environments by name at the top level.
    for (const legacyId of ["staging", "prod"]) {
      if (doc[legacyId] !== undefined) push(doc[legacyId], legacyId);
    }
  }

  return environments.length > 0 ? environments : null;
}

/** Optional top-level `fluxRepoPath` in clusters.json. */
export function readFluxRepoPath(target: string): string | null {
  return readSettings(target).fluxRepoPath;
}

/**
 * Settings sit alongside `environments` in clusters.json. Anything missing or
 * malformed falls back to the default rather than failing the whole load.
 */
export function readSettings(target: string): Settings {
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    const raw = parsed.settings !== null && typeof parsed.settings === "object" ? (parsed.settings as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = {
      ...DEFAULT_SETTINGS,
      // COMPAT: fluxRepoPath used to be a bare top-level key.
      ...(typeof parsed.fluxRepoPath === "string" && parsed.fluxRepoPath !== ""
        ? { fluxRepoPath: parsed.fluxRepoPath }
        : {}),
      ...raw,
    };
    // COMPAT: the mode used to be a boolean named shellModeDefault.
    if (typeof raw.shellModeDefault === "boolean" && raw.commandMode === undefined) {
      merged.commandMode = raw.shellModeDefault ? "bash" : "allowlist";
    }
    const result = SettingsSchema.safeParse(merged);
    return result.success ? result.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function blankEnvironment(id: string, label: string, isProduction: boolean): Environment {
  return { id, label, kubeconfig: "", context: null, namespace: null, isProduction };
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore unreadable candidates
    }
  }
  return null;
}

/** Pull `kubeconfig = "..."` out of a kubernetes-mcp-server TOML config. */
function kubeconfigFromToml(tomlPath: string): string | null {
  try {
    const match = /^\s*kubeconfig\s*=\s*["']([^"']+)["']/m.exec(readFileSync(tomlPath, "utf8"));
    return match ? expandHome(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Seeds for a machine with no config yet: reuse the kubeconfigs the k8s MCP
 * servers already point at, then conventionally named files under ~/.kube.
 * These are only suggestions — clusters are added and removed in Settings.
 */
export function discoverEnvironments(): Environment[] {
  const home = os.homedir();
  const mcpDir = path.join(home, ".config", "kubernetes-mcp");
  const seeds = [
    { id: "staging", label: "Staging", isProduction: false },
    { id: "prod", label: "Production", isProduction: true },
  ];

  return seeds
    .map((seed) => {
      const fromToml = kubeconfigFromToml(path.join(mcpDir, `${seed.id}.toml`));
      const kubeconfig =
        (fromToml && existsSync(fromToml) ? fromToml : null) ??
        firstExisting([
          path.join(mcpDir, `${seed.id}.kubeconfig`),
          path.join(home, ".kube", `${seed.id}.kubeconfig`),
          path.join(home, ".kube", `${seed.id}.config`),
          path.join(home, ".kube", `config-${seed.id}`),
        ]) ??
        "";
      return { ...blankEnvironment(seed.id, seed.label, seed.isProduction), kubeconfig };
    })
    .filter((environment) => environment.kubeconfig !== "");
}

function collectIssues(environments: Environment[]): ConfigState["issues"] {
  const issues: ConfigState["issues"] = [];
  for (const environment of environments) {
    if (environment.kubeconfig === "") {
      issues.push({ environmentId: environment.id, message: `${environment.label} has no kubeconfig yet.` });
      continue;
    }
    if (!existsSync(expandHome(environment.kubeconfig))) {
      issues.push({
        environmentId: environment.id,
        message: `${environment.label}: kubeconfig not found at ${environment.kubeconfig}`,
      });
    }
  }
  return issues;
}

export function loadConfigState(): ConfigState {
  const { path: configPath, source: pathSource } = activeConfigPath();
  const configExists = existsSync(configPath);

  let environments: Environment[] | null = null;
  let settings: Settings = DEFAULT_SETTINGS;
  const issues: ConfigState["issues"] = [];
  if (configExists) {
    try {
      environments = readConfigFile(configPath);
      settings = readSettings(configPath);
    } catch (error) {
      issues.push({ environmentId: "", message: (error as Error).message });
    }
  }

  const resolved = environments ?? discoverEnvironments();
  const source: ConfigState["source"] = environments
    ? pathSource
    : resolved.length > 0
      ? "discovered"
      : "empty";

  return {
    settings,
    fluxRepoPath: settings.fluxRepoPath,
    configPath,
    configExists,
    source,
    environments: resolved,
    issues: [...issues, ...collectIssues(resolved)],
  };
}

export function writeConfig(environments: Environment[], settings?: Settings): ConfigState {
  const { path: configPath } = activeConfigPath();
  mkdirSync(path.dirname(configPath), { recursive: true });

  const taken: string[] = [];
  const normalized = environments.map((environment) => {
    const id = environment.id !== "" ? environment.id : slugifyEnvironmentId(environment.label, taken);
    taken.push(id);
    return {
      ...environment,
      id,
      label: environment.label.trim() || id,
      kubeconfig: environment.kubeconfig.trim(),
      context: environment.context && environment.context.trim() !== "" ? environment.context.trim() : null,
      namespace: environment.namespace && environment.namespace.trim() !== "" ? environment.namespace.trim() : null,
    };
  });

  // Preserve settings the caller did not send, so saving clusters never drops them.
  const resolved = settings ?? (existsSync(configPath) ? readSettings(configPath) : DEFAULT_SETTINGS);
  writeFileSync(configPath, `${JSON.stringify({ settings: resolved, environments: normalized }, null, 2)}\n`, {
    mode: 0o600,
  });
  return loadConfigState();
}

/** Point the panel at an existing clusters.json somewhere else on disk. */
export function setConfigPointer(target: string): ConfigState {
  let resolved = expandHome(target);
  if (resolved === "") throw new Error("Give a path to a clusters.json file.");
  if (!existsSync(resolved)) throw new Error(`No such file: ${resolved}`);
  if (statSync(resolved).isDirectory()) resolved = path.join(resolved, CONFIG_FILENAME);
  if (!existsSync(resolved)) throw new Error(`No ${CONFIG_FILENAME} in that directory.`);

  const environments = readConfigFile(resolved);
  if (!environments) {
    throw new Error(
      `${resolved} has no recognisable environments. Expected {"environments":[{"id":"staging","kubeconfig":"..."}]}.`,
    );
  }

  mkdirSync(configHome(), { recursive: true });
  writeFileSync(pointerPath(), `${JSON.stringify({ path: resolved }, null, 2)}\n`);
  return loadConfigState();
}

export function clearConfigPointer(): ConfigState {
  try {
    writeFileSync(pointerPath(), `${JSON.stringify({ path: null }, null, 2)}\n`);
  } catch {
    // nothing to clear
  }
  return loadConfigState();
}

export function requireEnvironment(id: EnvironmentId): Environment {
  const state = loadConfigState();
  const environment = state.environments.find((entry) => entry.id === id);
  if (!environment) throw new Error(`No cluster named "${id}" is configured.`);
  if (environment.kubeconfig === "") {
    throw new Error(`${environment.label} has no kubeconfig yet. Add one in Settings → Clusters.`);
  }
  return environment;
}

export function listEnvironments(): Environment[] {
  return loadConfigState().environments;
}
