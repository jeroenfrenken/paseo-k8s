import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYaml, type YamlValue } from "./yaml";

/** Exec credential plugin (client.authentication.k8s.io) spec from a kubeconfig user. */
export interface ExecCredentialSpec {
  apiVersion: string;
  interactiveMode: string;
  cluster?: Record<string, YamlValue>;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

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
  /** Set when the kubeconfig user has no static credentials but an exec plugin. */
  exec?: ExecCredentialSpec;
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
  } else if (user.exec) {
    const spec = execSpecFrom(asRecord(user.exec), basedir, cluster);
    if (!spec) {
      throw new Error(
        `Context "${resolvedContextName}" has an exec credential plugin with no command in ${resolved}.`,
      );
    }
    connection.exec = spec;
    connection.authMethod = "exec plugin";
  } else if (user["auth-provider"]) {
    throw new Error(
      `Context "${resolvedContextName}" uses an auth-provider (OIDC or similar), which this panel cannot run. ` +
        "Point it at a kubeconfig with a token, client certificate, or exec credential plugin instead.",
    );
  } else {
    throw new Error(`Context "${resolvedContextName}" in ${resolved} has no usable credentials`);
  }

  return connection;
}

/** Extract a runnable exec credential plugin spec from a kubeconfig user. */
function execSpecFrom(source: Record<string, YamlValue>, basedir: string, cluster: Record<string, YamlValue>): ExecCredentialSpec | null {
  const command = asString(source.command);
  if (!command) return null;
  const args = Array.isArray(source.args)
    ? source.args.flatMap((entry) => {
        // The YAML reader types bare list items loosely; keep every scalar.
        if (typeof entry === "string") return [entry];
        if (typeof entry === "number" || typeof entry === "boolean") return [String(entry)];
        return [];
      })
    : [];
  const env = asList(source.env)
    .map((entry) => ({ name: asString(entry.name) ?? "", value: asString(entry.value) ?? "" }))
    .filter((entry) => entry.name !== "");
  // A bare name goes through PATH like kubectl; anything path-like resolves
  // against the kubeconfig's directory, matching the file credentials.
  const resolvedCommand =
    command.includes("/") || command.includes("\\") ? path.resolve(basedir, expandHome(command)) : command;
  const apiVersion = asString(source.apiVersion);
  if (apiVersion !== "client.authentication.k8s.io/v1" && apiVersion !== "client.authentication.k8s.io/v1beta1") {
    throw new Error("Exec credential plugin requires apiVersion client.authentication.k8s.io/v1 or v1beta1.");
  }
  const interactiveMode = asString(source.interactiveMode) ?? (apiVersion.endsWith("/v1beta1") ? "IfAvailable" : null);
  if (!interactiveMode || !["Never", "IfAvailable", "Always"].includes(interactiveMode)) {
    throw new Error("Exec credential plugin requires a valid interactiveMode.");
  }
  let clusterInfo: Record<string, YamlValue> | undefined;
  if (source.provideClusterInfo === true) {
    const ca = materialize(cluster, "certificate-authority-data", "certificate-authority", basedir);
    clusterInfo = { server: cluster.server };
    for (const key of ["tls-server-name", "insecure-skip-tls-verify", "proxy-url", "disable-compression"]) {
      if (cluster[key] !== undefined) clusterInfo[key] = cluster[key];
    }
    if (ca) clusterInfo["certificate-authority-data"] = ca.toString("base64");
    const extension = named(asList(cluster.extensions), "client.authentication.k8s.io/exec");
    if (extension) clusterInfo.config = extension.extension;
  }
  return { command: resolvedCommand, args, env, apiVersion, interactiveMode, cluster: clusterInfo };
}

interface ExecCredentialStatus {
  token?: string | null;
  clientCertificateData?: string | null;
  clientKeyData?: string | null;
  expirationTimestamp?: string | null;
}

interface CachedExecCredential {
  token: string | null;
  certPem: string | null;
  keyPem: string | null;
  expiresAtMs: number | null;
}

/** Re-run the plugin this far before the credential's stated expiry. */
const EXEC_REFRESH_MARGIN_MS = 60_000;
const EXEC_TIMEOUT_MS = 30_000;

/**
 * One entry per distinct plugin invocation (command, args, env, context), so
 * two clusters sharing a kubeconfig each keep their own token. Tokens expire
 * (EKS signs fifteen-minute credentials), so entries carry an expiry and are
 * refreshed lazily on the next request that needs them.
 */
const execCredentialCache = new Map<string, CachedExecCredential>();
const pendingExecCredentials = new Map<string, Promise<CachedExecCredential>>();

function execCacheKey(connection: ClusterConnection): string {
  const spec = connection.exec as ExecCredentialSpec;
  return JSON.stringify([connection.contextName, connection.server, spec]);
}

function runExecCredentialPlugin(spec: ExecCredentialSpec): Promise<ExecCredentialStatus> {
  if (spec.interactiveMode === "Always") {
    return Promise.reject(new Error("Exec credential plugin requires interactive stdin, which this panel cannot provide."));
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of spec.env) env[entry.name] = entry.value;
  env.KUBERNETES_EXEC_INFO = JSON.stringify({
    apiVersion: spec.apiVersion,
    kind: "ExecCredential",
    spec: { interactive: false, ...(spec.cluster ? { cluster: spec.cluster } : {}) },
  });

  return new Promise((resolve, reject) => {
    const child = execFile(
      spec.command,
      spec.args,
      { env, timeout: EXEC_TIMEOUT_MS, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        // Only stderr is quoted in errors: stdout carries the credential.
        if (error) {
          const exit = (error as { code?: number | string }).code;
          const hint = (stderr ?? "").toString().trim().slice(0, 300);
          reject(
            new Error(
              hint !== ""
                ? `Exec credential plugin "${spec.command}" failed (${exit ?? "no exit code"}): ${hint}`
                : `Exec credential plugin "${spec.command}" could not run: ${error.message}`,
            ),
          );
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          reject(new Error(`Exec credential plugin "${spec.command}" did not print usable JSON.`));
          return;
        }
        if (parsed === null || typeof parsed !== "object" ||
            !("apiVersion" in parsed) || parsed.apiVersion !== spec.apiVersion ||
            !("kind" in parsed) || parsed.kind !== "ExecCredential") {
          reject(new Error(`Exec credential plugin "${spec.command}" returned an incompatible ExecCredential.`));
          return;
        }
        const status =
          parsed !== null && typeof parsed === "object" && "status" in parsed
            ? asRecord((parsed as Record<string, YamlValue>).status)
            : null;
        if (!status) {
          reject(new Error(`Exec credential plugin "${spec.command}" returned no status object.`));
          return;
        }
        resolve({
          token: asString(status.token),
          clientCertificateData: asString(status.clientCertificateData),
          clientKeyData: asString(status.clientKeyData),
          expirationTimestamp: asString(status.expirationTimestamp),
        });
      },
    );
    child.stdin?.end();
  });
}

function applyExecCredential(connection: ClusterConnection, credential: CachedExecCredential): void {
  // Exec plugin status carries PEM directly, unlike the kubeconfig's
  // base64-wrapped *-data fields.
  connection.token = credential.token ?? undefined;
  connection.cert = credential.certPem ? Buffer.from(credential.certPem, "utf8") : undefined;
  connection.key = credential.keyPem ? Buffer.from(credential.keyPem, "utf8") : undefined;
}

/**
 * Ensure a connection whose kubeconfig user is an exec credential plugin has a
 * usable bearer token (or client certificate), running the plugin only when no
 * unexpired credential is cached. No-op for connections with static credentials.
 */
export async function resolveExecCredentials(connection: ClusterConnection): Promise<(() => void) | undefined> {
  if (!connection.exec) return;
  const spec = connection.exec;
  const cacheKey = execCacheKey(connection);
  let credential = execCredentialCache.get(cacheKey);
  if (!credential || (credential.expiresAtMs !== null && Date.now() >= credential.expiresAtMs - EXEC_REFRESH_MARGIN_MS)) {
    let pending = pendingExecCredentials.get(cacheKey);
    if (!pending) {
      pending = runExecCredentialPlugin(spec).then((status): CachedExecCredential => {
        const expiresAtMs = status.expirationTimestamp ? Date.parse(status.expirationTimestamp) : null;
        if (expiresAtMs !== null && !Number.isFinite(expiresAtMs)) {
          throw new Error(`Exec credential plugin "${spec.command}" returned an invalid expirationTimestamp.`);
        }
        const result = {
          token: status.token ?? null,
          certPem: status.clientCertificateData ?? null,
          keyPem: status.clientKeyData ?? null,
          expiresAtMs,
        };
        if ((result.certPem === null) !== (result.keyPem === null) ||
            (result.token === null && result.certPem === null)) {
          throw new Error(`Exec credential plugin "${spec.command}" returned neither a token nor a complete client certificate.`);
        }
        execCredentialCache.set(cacheKey, result);
        return result;
      }).finally(() => { pendingExecCredentials.delete(cacheKey); });
      pendingExecCredentials.set(cacheKey, pending);
    }
    credential = await pending;
  }
  applyExecCredential(connection, credential);
  // A late 401 must not evict credentials refreshed by another request.
  const usedCredential = credential;
  return () => {
    if (execCredentialCache.get(cacheKey) === usedCredential) execCredentialCache.delete(cacheKey);
  };
}
