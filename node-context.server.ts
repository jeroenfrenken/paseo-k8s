import type { ClusterNode, Overview } from "./contracts";

export function formatNodeContext(node: ClusterNode, overview: Overview): string {
  const pods = overview.pods.filter((pod) => pod.node === node.name);
  const cpuPercent =
    node.cpuCapacityMilli && node.cpuMilli ? Math.round((node.cpuMilli / node.cpuCapacityMilli) * 100) : null;
  const memoryPercent =
    node.memoryCapacityBytes && node.memoryBytes
      ? Math.round((node.memoryBytes / node.memoryCapacityBytes) * 100)
      : null;

  return [
    `# Node ${node.name}`,
    `Environment: ${overview.label} (${overview.contextName})`,
    `Status: ${node.ready ? (node.schedulable ? "Ready" : "Ready but cordoned") : "NotReady"}`,
    `Roles: ${node.roles.join(", ")}`,
    `Kubelet: ${node.kubeletVersion ?? "unknown"}`,
    cpuPercent !== null ? `CPU: ${cpuPercent}% of allocatable` : null,
    memoryPercent !== null ? `Memory: ${memoryPercent}% of allocatable` : null,
    node.conditions.length > 0 ? `Active conditions: ${node.conditions.join(", ")}` : null,
    `Created: ${node.createdAt ?? "unknown"}`,
    "",
    `## Pods on this node (${pods.length})`,
    pods.length === 0
      ? "(none)"
      : pods
          .map(
            (pod) =>
              `- ${pod.namespace}/${pod.name} — ${pod.phase}, ${pod.readyContainers}/${pod.totalContainers} ready, ${pod.restarts} restarts`,
          )
          .join("\n"),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
