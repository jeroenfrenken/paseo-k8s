import type { PluginContext } from "@getpaseo/plugin";
import {
  checkConnection,
  getConfig,
  getFlux,
  getOverview,
  getPodLogs,
  inspectKubeconfig,
  launchAgent,
  listAgentTargets,
  listNamespaces,
  getToolingStatus,
  pointAtConfigFile,
  resetConfigPointer,
  runCommand,
  runFluxAction,
  saveConfig,
  searchClusterAttachments,
} from "./contracts";
import {
  clearConfigPointer,
  loadConfigState,
  setConfigPointer,
  writeConfig,
} from "./config.server";
import { buildOverview, connectionFor, fetchNamespaces, fetchPodLogs, fetchVersion } from "./collect.server";
import { expandHome, summarizeKubeconfig } from "./kubeconfig.server";
import { runShellCommand, toolingStatus } from "./exec.server";
import { buildFluxSnapshot, fluxAction } from "./flux.server";
import { searchAttachments } from "./attach.server";
import {
  launchAgent as launchAgentImpl,
  listAgentTargets as listAgentTargetsImpl,
  type PaseoAgentSlice,
} from "./agent.server";
import { existsSync } from "node:fs";
import { KubernetesSurface } from "./main.client";

const SURFACE_ID = "kubernetes";

export default function contribute(plugin: PluginContext) {
  plugin.handle(getConfig, () => loadConfigState());

  plugin.handle(saveConfig, ({ environments, settings }) => writeConfig(environments, settings));

  plugin.handle(pointAtConfigFile, ({ path }) => setConfigPointer(path));

  plugin.handle(resetConfigPointer, () => clearConfigPointer());

  plugin.handle(inspectKubeconfig, ({ path }) => {
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

  plugin.handle(checkConnection, async ({ environmentId }) => {
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

  plugin.handle(listNamespaces, async ({ environmentId }) => {
    const { connection } = connectionFor(environmentId);
    try {
      return { namespaces: await fetchNamespaces(connection) };
    } catch {
      // Namespace-scoped credentials cannot list namespaces; fall back to the
      // one the kubeconfig context pins us to.
      return { namespaces: connection.namespace ? [connection.namespace] : [] };
    }
  });

  plugin.handle(getOverview, ({ environmentId, namespace }) => buildOverview(environmentId, namespace));

  plugin.handle(getPodLogs, ({ environmentId, namespace, pod, container, tailLines, previous }) =>
    fetchPodLogs(environmentId, namespace, pod, container, tailLines, previous),
  );

  plugin.handle(runCommand, ({ environmentId, command, namespace }) =>
    runShellCommand({ environmentId, command, namespace }),
  );

  plugin.handle(getToolingStatus, () => toolingStatus());

  plugin.handle(getFlux, ({ environmentId }) =>
    buildFluxSnapshot(environmentId, loadConfigState().fluxRepoPath),
  );

  plugin.handle(runFluxAction, (input) => fluxAction(input));

  plugin.handle(searchClusterAttachments, ({ query }) => searchAttachments(query ?? ""));

  plugin.handle(listAgentTargets, (_input, { paseo }) =>
    listAgentTargetsImpl(paseo as unknown as PaseoAgentSlice),
  );

  plugin.handle(launchAgent, (input, { paseo }) =>
    launchAgentImpl(paseo as unknown as PaseoAgentSlice, input),
  );

  plugin.addAttachmentSource({
    id: "kubernetes",
    title: "Kubernetes",
    icon: "Boxes",
    pickerTitle: "Attach a workload or pod",
    searchPlaceholder: "Search pods and workloads…",
    search: searchClusterAttachments,
  });

  plugin.addSurface(SURFACE_ID, KubernetesSurface);

  plugin.addSidebarItem({
    id: "kubernetes",
    title: "Kubernetes",
    icon: "Boxes",
    surface: SURFACE_ID,
  });

  plugin.addCommandCenterItem({
    id: "open-kubernetes",
    title: "Open Kubernetes",
    icon: "Boxes",
    keywords: ["k8s", "kubernetes", "cluster", "pods", "deployments", "staging", "production"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface(SURFACE_ID);
    },
  });

  plugin.addCommandCenterItem({
    id: "open-kubernetes-from-workspace",
    title: "Open Kubernetes",
    icon: "Boxes",
    keywords: ["k8s", "kubernetes", "cluster", "pods", "deployments"],
    context: "workspace",
    onSelect({ openSurface }) {
      openSurface(SURFACE_ID);
    },
  });

  return () => {};
}
