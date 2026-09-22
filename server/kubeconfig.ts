import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYaml, type YamlValue } from "./yaml";

/** Exec credential plugin (client.authentication.k8s.io) spec from a kubeconfig user. */
export interface ExecCredentialSpec {
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
    const spec = execSpecFrom(asRecord(user.exec), basedir);
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
function execSpecFrom(source: Record<string, YamlValue>, basedir: string): ExecCredentialSpec | null {
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
  return { command: resolvedCommand, args, env };
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

function execCacheKey(connection: ClusterConnection): string {
  const spec = connection.exec as ExecCredentialSpec;
  return [
    connection.contextName,
    spec.command,
    ...spec.args,
    ...spec.env.map((entry) => `${entry.name}=${entry.value}`),
  ].join("\u0000");
}

function runExecCredentialPlugin(spec: ExecCredentialSpec): Promise<ExecCredentialStatus> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of spec.env) env[entry.name] = entry.value;

  return new Promise((resolve, reject) => {
    execFile(
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
  });
}

function applyExecCredential(connection: ClusterConnection, credential: CachedExecCredential): void {
  // Exec plugin status carries PEM directly, unlike the kubeconfig's
  // base64-wrapped *-data fields.
  if (credential.token !== null) {
    connection.token = credential.token;
  } else {
    connection.cert = Buffer.from(credential.certPem ?? "", "utf8");
    connection.key = Buffer.from(credential.keyPem ?? "", "utf8");
  }
}

/**
 * Ensure a connection whose kubeconfig user is an exec credential plugin has a
 * usable bearer token (or client certificate), running the plugin only when no
 * unexpired credential is cached. No-op for connections with static credentials.
 */
export async function resolveExecCredentials(connection: ClusterConnection): Promise<void> {
  if (!connection.exec) return;
  const spec = connection.exec;
  const cacheKey = execCacheKey(connection);

  const cached = execCredentialCache.get(cacheKey);
  if (cached && (cached.expiresAtMs === null || Date.now() < cached.expiresAtMs - EXEC_REFRESH_MARGIN_MS)) {
    applyExecCredential(connection, cached);
    return;
  }

  const status = await runExecCredentialPlugin(spec);
  const expiresAtMs = status.expirationTimestamp ? Date.parse(status.expirationTimestamp) : Number.NaN;
  const credential: CachedExecCredential = {
    token: status.token ?? null,
    certPem: status.clientCertificateData ?? null,
    keyPem: status.clientKeyData ?? null,
    expiresAtMs: Number.isNaN(expiresAtMs) ? null : expiresAtMs,
  };
  if (credential.token === null && (credential.certPem === null || credential.keyPem === null)) {
    throw new Error(`Exec credential plugin "${spec.command}" returned neither a token nor a client certificate.`);
  }
  execCredentialCache.set(cacheKey, credential);
  applyExecCredential(connection, credential);
}
