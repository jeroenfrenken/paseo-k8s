# Kubernetes panel (Paseo plugin)

Adds a **Kubernetes** item to the Paseo sidebar — its own global surface, below the
built-in items, not attached to a workspace or agent chat. Add as many clusters as
you like and switch between them from the header.

## Install

```sh
paseo plugin add jeroenfrenken/paseo-k8s
```

> **Requires Paseo >= 0.8.0.** v0.8 split plugins into separate client and server
> runtime entries; this plugin is migrated to that layout and declares
> `requirements.paseo` in its manifest, so an older Paseo will refuse to load it.
> The last version that ran on 0.7.x is tagged `v0.7-final`.

Or from a local clone:

```sh
git clone git@github.com:jeroenfrenken/paseo-k8s.git
cd paseo-k8s && npm install
paseo plugin install "$PWD"
```

Once installed, pick it up later with:

```sh
paseo plugin status k8s     # is there a newer commit?
paseo plugin update k8s     # pull it in
paseo plugin logs k8s       # what the plugin printed
```

Nothing is configured out of the box: on first run the panel offers any kubeconfig
it discovers, checks which command-line tools are present, and takes you to
Settings to add a cluster.

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

The panel reads the daemon's provider catalogue, so **Agent** lists every provider
that is enabled and available (Claude, Codex, OpenCode, Cursor, …) and **Model**
lists that provider's models, with its default preselected. Providers that report
no models are left out rather than offered as dead entries.

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
/ `client-key-data` or their file forms), basic auth, and `exec` credential plugins
(`client.authentication.k8s.io`, e.g. `aws eks get-token`). Exec credentials are
resolved before requests, with concurrent requests sharing one plugin invocation.
Credentials are cached until a minute before their stated expiry or until an API
request returns HTTP 401; the next request then runs the plugin again. Without an
expiry, credentials remain cached until HTTP 401 or a daemon restart.
The plugin receives `KUBERNETES_EXEC_INFO` using its configured `v1` or `v1beta1`
API version, with `interactive: false` and cluster information when requested.
Plugins requiring `interactiveMode: Always` cannot run in the daemon. `certificate-authority-data`, `tls-server-name` and
`insecure-skip-tls-verify` are honoured.

`auth-provider` (OIDC and friends) is **not** supported — the panel cannot drive
those exchanges. Use a kubeconfig with a token, client certificate, or exec
credential plugin instead.

Everything the panel does is a read (`GET` only), including `pods/log`. Kubernetes RBAC on the credential
remains the authorization boundary; if the credential cannot list a resource the
panel reports it under *Partial data* and shows the rest.

## Development

```sh
npm install
npm run check          # typecheck + client/server boundary + regression tests
paseo plugin reload k8s
paseo plugin logs k8s
```

`reload` picks up edits when the plugin was installed from a directory. If it was
installed with `paseo plugin add`, it runs from a checkout under `~/.paseo/plugins`
instead — commit, push, then `paseo plugin update k8s`.

Layout:

| File | Runs on | Purpose |
|---|---|---|
| `index.client.tsx` | app | client entry: surface, sidebar, attachment source, command-center items |
| `index.server.ts` | daemon | server entry: every RPC handler |
| `shared/contracts.ts` | both | zod RPC contracts and shared types |
| `server/config.ts` | daemon | clusters.json read/write, pointer file, kubeconfig discovery |
| `server/kubeconfig.ts` | daemon | kubeconfig → connection (server, TLS material, credentials) |
| `server/yaml.ts` | daemon | minimal YAML reader for the kubeconfig subset |
| `server/k8s-api.ts` | daemon | HTTPS GET against the API server, resource types |
| `server/collect.ts` | daemon | fetches and shapes the snapshot: workloads, pods, nodes, metrics, events |
| `server/flux.ts` | daemon | Flux resources, the git comparison, and reconcile/suspend actions |
| `server/attach.ts` | daemon | composer attachment search and the context bundles it returns |
| `server/agent.ts` | daemon | workspace/model discovery and agent creation via PaseoApi |
| `server/node-context.ts` | daemon | node context bundle |
| `server/exec.ts` | daemon | the command runner behind the shell tab |
| `client/main.tsx` | app | surface shell: header, tabs, split layout, dock |
| `client/list.tsx` | app | sortable, searchable resource table |
| `client/detail.tsx` | app | the detail drawer |
| `client/flux.tsx` | app | the Flux tab |
| `client/launch.tsx` | app | the "Ask an agent" panel |
| `client/dock.tsx` | app | resizable dock, log tabs, shell tab |
| `client/settings.tsx` | app | the Settings screen and its sidebar |
| `client/chooser.tsx` | app | the `+` tab picker and the first-run screen |
| `client/ui.tsx` | app | shared primitives (chips, buttons, tiles, meters, tabs) |
| `client/theme.ts` | app | status palette, tokens, formatters |

**The directories are load-bearing.** Paseo compiles the two entries separately and
refuses to pull a `server/` module into the app bundle, a `client/` module into the
daemon bundle, or any `node:` builtin into the app bundle. `shared/` lands in both,
so it must never import `node:` builtins. `npm run check` enforces all of that
locally, before the plugin is loaded.
