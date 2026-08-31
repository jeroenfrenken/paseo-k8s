# Kubernetes panel (Paseo plugin)

Adds a **Kubernetes** item to the Paseo sidebar — its own global surface, below the
built-in items, not attached to a workspace or agent chat. It shows live workload
health for two environments, **Staging** and **Production**.

## What it shows

A Lens-style workspace built inside the one surface the host gives a plugin.

**Header** — a cluster dropdown naming the current cluster and its context, then
refresh, auto-refresh, Shell and Settings. Production clusters carry a red
`PRODUCTION` badge. Below it, the live context and API server.

**Tabs** — open as many resource views as you like. `+` opens a full picker showing
every view with its live count; `×` closes a tab. The **namespace dropdown** sits on
the same line as the tabs, on the right, and is searchable.

**First run** — with no cluster configured yet, the panel opens on a setup screen
that lists any kubeconfig it discovered, checks which command-line tools are
installed, and links straight into Settings.

## Command-line tools

Nothing needs to be installed to browse a cluster: that path talks to the API
server over HTTPS directly. The setup screen and **Settings → Command bar** both
show what is present and what each one unlocks:

| Tool | | Unlocks |
|---|---|---|
| `kubectl` | recommended | The command bar, and the Flux reconcile/suspend buttons |
| `git` | optional | Comparing the deployed revision to a local Flux checkout |
| `helm` | optional | Running helm from the command bar |
| `flux` | optional | Nothing the panel needs — Flux state is read from the API. Only for running `flux` in the command bar |

Missing tools show an install hint rather than blocking anything.

**Settings** — its own screen with a sidebar:

- **Clusters** — add and remove as many as you like. There is no fixed set of
  environments: each cluster is a name, a kubeconfig, a context, a default
  namespace, and a *production* flag that turns it red everywhere. Ids are slugged
  from the name and kept unique. Each has a connection test.
- **Command bar** — how commands run, the allowed programs, and the timeout.
- **GitOps** — the Flux repo path.
- **Config file** — where all of this is stored, and how to point at another file.

**List view** — a dense sortable table per tab. Click any column header to sort
(again to reverse). A search box filters as you type across name, namespace, status,
node and image. Live **CPU and memory** columns come from metrics-server; they are
hidden automatically when it is not installed. The footer shows matched/total counts.

**Detail drawer** — click a row. Opens on the right (stacked below on narrow
windows) with stat tiles, a replica or capacity meter, full properties, the owning
workload's pods, and one-click actions that push a prefilled command into the shell
(`describe`, `get -o yaml`, `rollout status`, `top`, `events`).

**Bottom dock** — resizable by dragging its handle, collapsible, with its own tabs:

- **Log tabs** — one per pod, several open at once. 100/500/2000 line tail, container
  picker on multi-container pods, a **Previous** toggle on pods that have restarted
  (reads the terminated container), **Follow** for 5s polling, and a search box that
  filters the lines. Timestamps render as wall-clock time.
- **Shell tab** — type kubectl commands with `KUBECONFIG` already pointed at the
  selected environment. Up/down arrows walk history. One status line shows the
  cluster, namespace and what may run; everything configurable lives in Settings,
  reachable from the ⚙ in the tab's own header. See *Command bar* below.

**Overview tab** — replica availability as the headline figure, stat tiles, a
pods-by-phase bar, and per-node CPU/memory pressure meters.

**Flux tab** — see *GitOps* below.

Health is always carried by a glyph and a word as well as a colour
(`● Healthy`, `▲ Progressing`, `◆ Degraded`, `■ Down`, `○ Idle`), so nothing depends
on hue alone.

## GitOps (Flux)

The **Flux** tab reads the cluster's Flux state directly — it is cluster-wide and
deliberately ignores the namespace filter.

- **Deployed revision** as the headline: the git revision every Kustomization has
  applied, e.g. `main@1a2b3c4`.
- **Local comparison.** If a checkout of the GitOps repo is found, the panel says
  whether your branch is in sync or lists the commits the cluster has not applied
  yet. It is strictly read-only: it never fetches and never touches the working
  tree. If the deployed commit is not in your clone it says so and suggests
  `git fetch` rather than running one.
- **Sources, Kustomizations, Helm releases** with ready / failed / suspended state,
  the path or chart each came from, applied revision, and the condition message.
- **Image automation** — ImagePolicies with the newest image they resolve to. When
  that differs from what the workload is actually running, the row is flagged
  **update pending** with `running … → latest …`.
- **Actions** on any row: **Reconcile**, and **Suspend**/**Resume** for the kinds
  that support it.

Actions run through `kubectl` on the command-bar path rather than a raw API PATCH,
so they inherit the allowlist and show up as a normal command. `Reconcile` only sets
the standard `reconcile.fluxcd.io/requestedAt` annotation; suspend/resume patch
`spec.suspend`. Nothing else is ever written.

The repo is found at `PASEO_K8S_FLUX_REPO`, then `fluxRepoPath` in clusters.json,
then `~/flux`. Saving clusters from the UI preserves `fluxRepoPath`.

## Attaching cluster context to an agent

The plugin registers a **Kubernetes** composer attachment source. In an agent's
composer, attach → Kubernetes → search, and the picked resource arrives as context:

- **A pod** — phase and reason, container readiness, restarts, node, CPU/memory,
  its recent warning events, and its last 80 log lines.
- **A workload** — replica counts, health, condition message, images, every pod with
  its status, the warning events across them, **and a log tail from each of up to four
  of its pods**, so asking about "the api pods" gets all of them rather
  than one. Running pods are preferred over finished ones (completed Jobs and
  migrations sort last).

Both environments are searched at once and each result is labelled Staging or
Production. Unhealthy resources are ranked first, since a broken pod is usually the
one you meant to ask about. Cluster listings are cached for 20s so typing in the
picker does not hammer the API; logs are fetched live for the results actually shown.

## Launching an agent from a resource

Selecting a pod, workload or node puts an **✦ Ask an agent** button at the top of
the detail drawer. It opens an inline panel with an editable instruction, a project
picker and a model picker, and starts a new Paseo agent whose opening prompt is your
instruction followed by the same live context bundle the attachment picker builds —
status, events and log tail for a pod; replicas, images, pods and events for a
workload; pressure and scheduled pods for a node.

**A fresh workspace is always created**, never reused. Pick the project it belongs
to and whether it is a **Worktree** (branch-off, the default) or a plain **Local**
directory. Non-git projects only offer Local, and the panel says why.

The agent is created inside that new workspace and tagged with labels
`source=k8s-plugin`, `environment` and `resource`, so agents started this way are
easy to find later.

Model choices are the `provider/model` strings already in use on this daemon, which
avoids guessing at the provider catalogue.

## Command bar

The shell tab runs commands on the daemon with `KUBECONFIG` set to the selected
environment's kubeconfig. It is **not** a PTY — the host's plugin API exposes no
terminal, so `kubectl exec -it` and anything else needing a TTY will not work. One
command in, its output back.

The shell tab is only a shell: you type, it runs. *How* it runs is decided once in
**Settings → Command bar**, which offers two clearly described modes:

- **Allowlist only** (default, recommended) — the first word must be one of the
  programs you listed (`kubectl`, `helm`, `kustomize` out of the box). The line is
  split into arguments directly, without a shell, so quoting tricks and injection
  cannot happen. Pipes, redirects and wildcards are refused, with a message saying
  which setting to change.
- **Full bash** — the whole line goes to `bash -lc`. Pipes, redirects and wildcards
  work and anything on your PATH can run, including things that delete. Marked
  *less safe* in Settings, and the shell tab's header says **▲ Full bash** while it
  is active.

The shell header always states the current mode and links straight to the setting.
Output is capped at 400 KB per stream.

Flux actions ignore this setting entirely: they are fixed `kubectl` calls, pinned to
allowlist mode with `kubectl` as the only permitted program.

## Configuration

The panel talks to the Kubernetes API directly over HTTPS using a kubeconfig per
environment. Open **Clusters** in the header to set them.

Config lives at `~/.config/paseo-k8s/clusters.json`:

```json
{
  "environments": [
    {
      "id": "staging",
      "label": "Staging",
      "kubeconfig": "/home/you/.config/kubernetes-mcp/staging.kubeconfig",
      "context": null,
      "namespace": null
    },
    {
      "id": "prod",
      "label": "Production",
      "kubeconfig": "/home/you/.config/kubernetes-mcp/prod.kubeconfig",
      "context": null,
      "namespace": "app"
    }
  ]
}
```

- `kubeconfig` — path to a kubeconfig file. `~` is expanded.
- `context` — which context inside that file; `null` uses `current-context`.
  The Clusters editor lists the contexts it finds in the file so you can pick one.
- `namespace` — the namespace the panel opens on; `null` means all namespaces.

**Pointing at a file elsewhere.** The Clusters section has a *Use a config file
elsewhere* field: give it a path to another `clusters.json` (or a directory
containing one) and the panel reads and writes that file from then on. The pointer
is stored in `~/.config/paseo-k8s/pointer.json`; *Use default* clears it.
`PASEO_K8S_CONFIG` overrides both.

**Before any config exists** the panel discovers kubeconfigs on its own: it reads
`kubeconfig = "..."` out of `~/.config/kubernetes-mcp/{staging,prod}.toml` (the
`kubernetes-mcp-server` configs behind the `k8s-staging` / `k8s-prod` MCP servers),
then falls back to `~/.config/kubernetes-mcp/<env>.kubeconfig` and conventionally
named files under `~/.kube`. So on a machine that already has the k8s MCP servers
set up, it works with no configuration at all.

### Credentials

Supported: bearer `token`, `tokenFile`, client certificate (`client-certificate-data`
/ `client-key-data` or their file forms), and basic auth. `certificate-authority-data`,
`tls-server-name` and `insecure-skip-tls-verify` are honoured.

`exec` credential plugins and `auth-provider` are **not** supported — the panel does
not run external binaries for credentials. Use a kubeconfig with a service-account
token or a client certificate instead.

Everything the panel does is a read (`GET` only), including `pods/log`. Kubernetes RBAC on the credential
remains the authorization boundary; if the credential cannot list a resource the
panel reports it under *Partial data* and shows the rest.

## Install

```sh
paseo plugin add jeroenfrenken/paseo-k8s
```

Or from a local clone:

```sh
git clone git@github.com:jeroenfrenken/paseo-k8s.git
cd paseo-k8s && npm install
paseo plugin install "$PWD"
```

Nothing is configured out of the box: on first run the panel offers any kubeconfig
it discovers, and clusters are added in Settings.

## Development

```sh
npm install
npm run check          # typecheck + client/server boundary
paseo plugin reload k8s
paseo plugin logs k8s
```

Layout:

| File | Runs on | Purpose |
|---|---|---|
| `index.ts` | both | entry point: RPC handlers (server) + surface/sidebar/command-center (app) |
| `contracts.ts` | both | zod RPC contracts and shared types |
| `config.server.ts` | daemon | clusters.json read/write, pointer file, kubeconfig discovery |
| `kubeconfig.server.ts` | daemon | kubeconfig → connection (server, TLS material, credentials) |
| `yaml.server.ts` | daemon | minimal YAML reader for the kubeconfig subset |
| `k8s-api.server.ts` | daemon | HTTPS GET against the API server, resource types |
| `collect.server.ts` | daemon | fetches and shapes the snapshot: workloads, pods, nodes, metrics, events |
| `flux.server.ts` | daemon | Flux resources, the git comparison, and reconcile/suspend actions |
| `attach.server.ts` | daemon | composer attachment search and the context bundles it returns |
| `agent.server.ts` | daemon | workspace/model discovery and agent creation via PaseoApi |
| `node-context.server.ts` | daemon | node context bundle |
| `exec.server.ts` | daemon | the command runner behind the shell tab |
| `main.client.tsx` | app | surface shell: header, tabs, split layout, dock |
| `list.client.tsx` | app | sortable, searchable resource table |
| `detail.client.tsx` | app | the detail drawer |
| `flux.client.tsx` | app | the Flux tab |
| `launch.client.tsx` | app | the "Ask an agent" panel |
| `dock.client.tsx` | app | resizable dock, log tabs, shell tab |
| `settings.client.tsx` | app | the Settings screen and its sidebar |
| `chooser.client.tsx` | app | the `+` tab picker and the first-run screen |
| `ui.client.tsx` | app | shared primitives (chips, buttons, tiles, meters, tabs) |
| `theme.client.ts` | app | status palette, tokens, formatters |

**The `.server` / `.client` suffixes are load-bearing.** The daemon compiles `index.ts`
twice — once per target — and refuses to pull a `.server` module into the app bundle
or a `.client` module into the daemon bundle. Anything unsuffixed (`contracts.ts`)
lands in both, so it must never import `node:` builtins.
