import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYaml, type YamlValue } from "./yaml.server";

export interface ClusterConnection {
  contextName: string;
  server: string;
  namespace: string | null;
  authMethod: string;
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  token?: string;
  basicAuth?: string;
  servername?: string;
  insecure: boolean;
}

export function expandHome(target: string): string {
  const trimmed = target.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function asRecord(value: YamlValue): Record<string, YamlValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, YamlValue>)
    : {};
}

function asList(value: YamlValue): Record<string, YamlValue>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asString(value: YamlValue): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function named(entries: Record<string, YamlValue>[], name: string): Record<string, YamlValue> | null {
  return entries.find((entry) => asString(entry.name) === name) ?? null;
}

/** Resolve a `*-data` (base64) / plain-path pair into file contents. */
function materialize(
  source: Record<string, YamlValue>,
  dataKey: string,
  pathKey: string,
  basedir: string,
): Buffer | undefined {
  const inline = asString(source[dataKey]);
  if (inline) return Buffer.from(inline, "base64");
  const file = asString(source[pathKey]);
  if (!file) return undefined;
  const resolved = path.resolve(basedir, expandHome(file));
  return readFileSync(resolved);
}

export interface KubeconfigSummary {
  contexts: string[];
  currentContext: string | null;
}

export function summarizeKubeconfig(kubeconfigPath: string): KubeconfigSummary {
  const resolved = expandHome(kubeconfigPath);
  const doc = asRecord(parseYaml(readFileSync(resolved, "utf8")));
  const contexts = asList(doc.contexts)
    .map((entry) => asString(entry.name))
    .filter((name): name is string => name !== null);
  return { contexts, currentContext: asString(doc["current-context"]) };
}

/**
 * Build everything needed to talk to the API server for one context.
 * Throws with an operator-readable message when the kubeconfig cannot be used.
 */
export function loadConnection(kubeconfigPath: string, contextName: string | null): ClusterConnection {
  const resolved = expandHome(kubeconfigPath);
  const basedir = path.dirname(resolved);

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`Cannot read kubeconfig at ${resolved}`);
  }

  const doc = asRecord(parseYaml(raw));
  const wanted = contextName ?? asString(doc["current-context"]);
  const contexts = asList(doc.contexts);
  if (contexts.length === 0) throw new Error(`No contexts defined in ${resolved}`);

  const contextEntry = wanted ? named(contexts, wanted) : contexts[0];
  if (!contextEntry) {
    const available = contexts.map((entry) => asString(entry.name) ?? "?").join(", ");
    throw new Error(`Context "${wanted}" not found in ${resolved}. Available: ${available}`);
  }

  const resolvedContextName = asString(contextEntry.name) ?? wanted ?? "default";
  const context = asRecord(contextEntry.context);
  const clusterName = asString(context.cluster);
  const userName = asString(context.user);

  const clusterEntry = clusterName ? named(asList(doc.clusters), clusterName) : null;
  if (!clusterEntry) throw new Error(`Cluster "${clusterName ?? "?"}" not found in ${resolved}`);
  const cluster = asRecord(clusterEntry.cluster);

  const server = asString(cluster.server);
  if (!server) throw new Error(`Cluster "${clusterName}" has no server URL in ${resolved}`);

  const userEntry = userName ? named(asList(doc.users), userName) : null;
  const user = asRecord(userEntry?.user ?? null);

  const connection: ClusterConnection = {
    contextName: resolvedContextName,
    server: server.replace(/\/+$/, ""),
    namespace: asString(context.namespace),
    authMethod: "anonymous",
    insecure: cluster["insecure-skip-tls-verify"] === true,
    servername: asString(cluster["tls-server-name"]) ?? undefined,
  };

  if (!connection.insecure) {
    connection.ca = materialize(cluster, "certificate-authority-data", "certificate-authority", basedir);
  }

  const token = asString(user.token);
  const tokenFile = asString(user.tokenFile);
  const username = asString(user.username);
  const password = asString(user.password);
  const cert = materialize(user, "client-certificate-data", "client-certificate", basedir);
  const key = materialize(user, "client-key-data", "client-key", basedir);

  if (token) {
    connection.token = token;
    connection.authMethod = "token";
  } else if (tokenFile) {
    connection.token = readFileSync(path.resolve(basedir, expandHome(tokenFile)), "utf8").trim();
    connection.authMethod = "token file";
  } else if (cert && key) {
    connection.cert = cert;
    connection.key = key;
    connection.authMethod = "client certificate";
  } else if (username && password) {
    connection.basicAuth = Buffer.from(`${username}:${password}`).toString("base64");
    connection.authMethod = "basic auth";
  } else if (user.exec || user["auth-provider"]) {
    throw new Error(
      `Context "${resolvedContextName}" uses an exec/auth-provider credential plugin, which this panel cannot run. ` +
        "Point it at a kubeconfig with a service-account token or client certificate instead.",
    );
  } else {
    throw new Error(`Context "${resolvedContextName}" in ${resolved} has no usable credentials`);
  }

  return connection;
}
