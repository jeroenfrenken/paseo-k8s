import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import http from 'node:http';
import { buildSync } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'paseo-listing-test-'));
const bundle = join(dir, 'server.cjs');
buildSync({ stdin: { contents: 'export * from "./server/kubeconfig"; export * from "./server/k8s-api"; export { fetchWorkloadPods } from "./server/collect";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { loadConnection, apiList, fetchWorkloadPods } = createRequire(import.meta.url)(bundle);

const pod = (namespace, name, labels) => ({
  metadata: { namespace, name, labels },
  spec: { nodeName: 'node-a', containers: [{ name: 'main' }] },
  status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 2 }] },
});
const event = (name, reason) => ({ type: 'Warning', reason, message: reason, count: 1, involvedObject: { kind: 'Pod', name } });

// Five pods cluster-wide, served two per page, like an API server honouring `limit`.
const allPods = [
  pod('a', 'a-1', {}), pod('a', 'a-2', {}), pod('b', 'b-1', {}), pod('b', 'b-2', {}), pod('z', 'late-pod', { app: 'late' }),
];
const seen = [];
let server;
let connection;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(url);
    const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/v1/pods') {
      const size = Number(url.searchParams.get('limit'));
      const start = Number(url.searchParams.get('continue') ?? 0);
      const items = allPods.slice(start, start + size);
      const next = start + size < allPods.length ? String(start + size) : undefined;
      return send({ items, metadata: next ? { continue: next } : {} });
    }
    if (url.pathname === '/apis/apps/v1/namespaces/ns/deployments/web') {
      return send({ metadata: { name: 'web', namespace: 'ns' }, spec: { selector: { matchLabels: { app: 'web', tier: 'api' } } } });
    }
    if (url.pathname === '/api/v1/namespaces/ns/pods') {
      const matching = url.searchParams.get('labelSelector') === 'app=web,tier=api';
      return send({ items: matching ? [pod('ns', 'web-7d9f-abcde', { app: 'web', tier: 'api' }), pod('ns', 'web-7d9f-fghij', { app: 'web', tier: 'api' })] : [] });
    }
    if (url.pathname === '/api/v1/namespaces/ns/events') {
      return send({ items: [event('web-7d9f-abcde', 'BackOff'), event('other-pod', 'Unrelated')] });
    }
    return send({ kind: 'Status', message: 'not found' }, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({
    'current-context': 'test', contexts: [{ name: 'test', context: { cluster: 'cluster', user: 'user' } }],
    clusters: [{ name: 'cluster', cluster: { server: `http://127.0.0.1:${server.address().port}` } }],
    users: [{ name: 'user', user: { token: 'static-token' } }],
  }));
  connection = loadConnection(config, null);
});

after(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

test('apiList follows continue tokens past the page size', async () => {
  const items = await apiList(connection, '/api/v1/pods', 2);
  assert.deepEqual(items.map((item) => item.metadata.name), ['a-1', 'a-2', 'b-1', 'b-2', 'late-pod']);
  const requests = seen.filter((url) => url.pathname === '/api/v1/pods');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((url) => url.searchParams.get('continue')), [null, '2', '4']);
});

test('apiList keeps an existing query string', async () => {
  seen.length = 0;
  await apiList(connection, '/api/v1/pods?fieldSelector=status.phase%3DRunning', 10);
  assert.equal(seen[0].searchParams.get('fieldSelector'), 'status.phase=Running');
  assert.equal(seen[0].searchParams.get('limit'), '10');
});

test('fetchWorkloadPods lists only the workload namespace, by its label selector', async () => {
  seen.length = 0;
  const { pods, events } = await fetchWorkloadPods(connection, { kind: 'Deployment', namespace: 'ns', name: 'web' });
  assert.deepEqual(pods.map((p) => p.name), ['web-7d9f-abcde', 'web-7d9f-fghij']);
  assert.ok(pods.every((p) => p.ownerKey === 'Deployment/ns/web'));
  assert.equal(pods[0].restarts, 2);
  assert.deepEqual(events.map((e) => e.reason), ['BackOff']);
  assert.ok(!seen.some((url) => url.pathname === '/api/v1/pods'), 'must not list pods cluster-wide');
});

test('fetchWorkloadPods surfaces a missing workload as an error', async () => {
  const { pods } = await fetchWorkloadPods(connection, { kind: 'Deployment', namespace: 'ns', name: 'missing' }).catch(() => ({ pods: null }));
  assert.equal(pods, null, 'a missing workload surfaces as an error, not as an empty pod list');
});
