import type { Pod } from "../shared/contracts";

/**
 * Search box text that narrows the pod list to one workload's pods. The
 * trailing slash closes the key, so `Deployment/ns/web` does not also match
 * pods of `Deployment/ns/web-canary`.
 */
export function ownerQuery(ownerKey: string): string {
  return `owner:${ownerKey}/`;
}

/** What the pod list's search box matches a pod against. */
export function podHaystack(pod: Pick<Pod, "name" | "namespace" | "phase" | "reason" | "node" | "ownerKey">): string {
  const owner = pod.ownerKey ? ` ${ownerQuery(pod.ownerKey)}` : "";
  return `${pod.name} ${pod.namespace} ${pod.phase} ${pod.reason ?? ""} ${pod.node ?? ""}${owner}`.toLowerCase();
}
