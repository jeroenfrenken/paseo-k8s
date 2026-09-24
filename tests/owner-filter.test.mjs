import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'paseo-owner-test-'));
const bundle = join(dir, 'owner.cjs');
buildSync({ entryPoints: ['client/owner.ts'], bundle: true, platform: 'neutral', format: 'cjs', outfile: bundle });
const { ownerQuery, podHaystack } = createRequire(import.meta.url)(bundle);
rmSync(dir, { recursive: true, force: true });

const pod = (name, ownerKey) => ({ name, namespace: 'ns', phase: 'Running', reason: null, node: 'node-a', ownerKey });
const matches = (query, item) => podHaystack(item).includes(query.trim().toLowerCase());

test("a workload's pod filter matches its own pods", () => {
  const query = ownerQuery('Deployment/ns/web');
  assert.ok(matches(query, pod('web-7d9f-abcde', 'Deployment/ns/web')));
});

test("a workload's pod filter skips a sibling whose name starts the same", () => {
  const query = ownerQuery('Deployment/ns/web');
  assert.ok(!matches(query, pod('web-canary-5c4b-xyz12', 'Deployment/ns/web-canary')));
  assert.ok(!matches(query, pod('web-0', 'StatefulSet/ns/web')));
});

test('pods without an owner still match by name', () => {
  assert.ok(matches('debug', pod('debug-shell', null)));
});
