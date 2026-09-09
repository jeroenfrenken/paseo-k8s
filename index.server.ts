import type { PluginServerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import {
  checkConnection,
  checkTooling,
  getConfig,
  getFlux,
  getOverview,
  getPodLogs,
  getToolingStatus,
  inspectKubeconfig,
  launchAgent,
  listAgentTargets,
  listNamespaces,
  pointAtConfigFile,
  resetConfigPointer,
  runCommand,
  runFluxAction,
  saveConfig,
  searchClusterAttachments,
} from "./shared/contracts";
import { clearConfigPointer, loadConfigState, setConfigPointer, writeConfig } from "./server/config";
import { buildOverview, connectionFor, fetchNamespaces, fetchPodLogs, fetchVersion } from "./server/collect";
import { expandHome, summarizeKubeconfig } from "./server/kubeconfig";
import { runShellCommand, toolingReport, toolingStatus } from "./server/exec";
import { buildFluxSnapshot, fluxAction } from "./server/flux";
import { searchAttachments } from "./server/attach";
import {
  launchAgent as launchAgentImpl,
  listAgentTargets as listAgentTargetsImpl,
  type PaseoAgentSlice,
} from "./server/agent";

export default function contribute(server: PluginServerContext) {
  server.handle(getConfig, () => loadConfigState());

  server.handle(saveConfig, ({ environments, settings }) => writeConfig(environments, settings));

  server.handle(pointAtConfigFile, ({ path }) => setConfigPointer(path));

  server.handle(resetConfigPointer, () => clearConfigPointer());

  server.handle(inspectKubeconfig, ({ path }) => {
    const resolved = expandHome(path);
    if (resolved === "" || !existsSync(resolved)) {
      return { path: resolved, exists: false, contexts: [], currentContext: null, error: null };
    }
    try {
      const summary = summarizeKubeconfig(resolved);
      return {
        path: resolved,
        exists: true,
        contexts: summary.contexts,
        currentContext: summary.currentContext,
        error: null,
      };
    } catch (error) {
      return {
        path: resolved,
        exists: true,
        contexts: [],
        currentContext: null,
        error: (error as Error).message,
      };
    }
  });

  server.handle(checkConnection, async ({ environmentId }) => {
    try {
      const { connection } = connectionFor(environmentId);
      const version = await fetchVersion(connection);
      return {
        ok: true,
        serverUrl: connection.server,
        contextName: connection.contextName,
        version,
        authMethod: connection.authMethod,
        message: `Connected to ${connection.server}${version ? ` (${version})` : ""}`,
      };
    } catch (error) {
      return {
        ok: false,
        serverUrl: null,
        contextName: null,
        version: null,
        authMethod: null,
        message: (error as Error).message,
      };
    }
  });

  server.handle(listNamespaces, async ({ environmentId }) => {
    const { connection } = connectionFor(environmentId);
    try {
      return { namespaces: await fetchNamespaces(connection) };
    } catch {
      // Namespace-scoped credentials cannot list namespaces; fall back to the
      // one the kubeconfig context pins us to.
      return { namespaces: connection.namespace ? [connection.namespace] : [] };
    }
  });

  server.handle(getOverview, ({ environmentId, namespace }) => buildOverview(environmentId, namespace));

  server.handle(getPodLogs, ({ environmentId, namespace, pod, container, tailLines, previous }) =>
    fetchPodLogs(environmentId, namespace, pod, container, tailLines, previous),
  );

  server.handle(runCommand, ({ environmentId, command, namespace }) =>
    runShellCommand({ environmentId, command, namespace }),
  );

  server.handle(getToolingStatus, () => toolingStatus());

  server.handle(checkTooling, () => toolingReport());

  server.handle(getFlux, ({ environmentId }) =>
    buildFluxSnapshot(environmentId, loadConfigState().fluxRepoPath),
  );

  server.handle(runFluxAction, (input) => fluxAction(input));

  server.handle(searchClusterAttachments, ({ query }) => searchAttachments(query ?? ""));

  server.handle(listAgentTargets, (_input, { paseo }) =>
    listAgentTargetsImpl(paseo as unknown as PaseoAgentSlice),
  );

  server.handle(launchAgent, (input, { paseo }) =>
    launchAgentImpl(paseo as unknown as PaseoAgentSlice, input),
  );

  return () => {};
}
