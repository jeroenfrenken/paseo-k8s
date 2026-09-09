import type { PluginClientContext } from "@getpaseo/plugin/client";
import { searchClusterAttachments } from "./shared/contracts";
import { KubernetesSurface } from "./client/main";

const SURFACE_ID = "kubernetes";

export default function contribute(client: PluginClientContext) {
  // Every add* call returns its own remover, so cleanup is just calling them.
  const removers = [
    client.addSurface(SURFACE_ID, KubernetesSurface),

    client.addSidebarItem({
      id: "kubernetes",
      title: "Kubernetes",
      icon: "Boxes",
      surface: SURFACE_ID,
    }),

    client.addAttachmentSource({
      id: "kubernetes",
      title: "Kubernetes",
      icon: "Boxes",
      pickerTitle: "Attach a workload or pod",
      searchPlaceholder: "Search pods and workloads…",
      search: searchClusterAttachments,
    }),

    client.addCommandCenterItem({
      id: "open-kubernetes",
      title: "Open Kubernetes",
      icon: "Boxes",
      keywords: ["k8s", "kubernetes", "cluster", "pods", "deployments", "staging", "production"],
      context: "global",
      onSelect({ openSurface }) {
        openSurface(SURFACE_ID);
      },
    }),

    client.addCommandCenterItem({
      id: "open-kubernetes-from-workspace",
      title: "Open Kubernetes",
      icon: "Boxes",
      keywords: ["k8s", "kubernetes", "cluster", "pods", "deployments"],
      context: "workspace",
      onSelect({ openSurface }) {
        openSurface(SURFACE_ID);
      },
    }),
  ];

  let removed = false;
  return () => {
    // Removers must tolerate being called twice.
    if (removed) return;
    removed = true;
    for (const remove of removers) remove();
  };
}
