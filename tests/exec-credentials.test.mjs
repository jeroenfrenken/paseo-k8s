import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import http from 'node:http';
import { buildSync } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'paseo-exec-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const bundle = join(dir, 'server.cjs');
buildSync({ stdin: { contents: 'export * from "./server/kubeconfig"; export * from "./server/k8s-api"; export * from "./server/yaml";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { loadConnection, resolveExecCredentials, apiGetText, parseYaml } = createRequire(import.meta.url)(bundle);
const plugin = join(dir, 'plugin.cjs');
writeFileSync(plugin, `
const fs = require('node:fs');
const [log, mode] = process.argv.slice(2);
const info = JSON.parse(process.env.KUBERNETES_EXEC_INFO || '{}');
fs.appendFileSync(log, JSON.stringify({info, profile: process.env.AWS_PROFILE}) + '\\n');
const n = fs.readFileSync(log, 'utf8').trim().split('\\n').length;
if (mode === 'fail-once' && n === 1) { console.error('temporary failure'); process.exit(1); }
if (mode === 'malformed') { console.log('credential-secret'); process.exit(0); }
const status = mode === 'cert' ? {clientCertificateData:'CERT',clientKeyData:'KEY'} : {token:'token-' + n};
if (mode === 'expiry') status.expirationTimestamp = new Date(Date.now()+120000).toISOString();
setTimeout(() => console.log(JSON.stringify({apiVersion:info.apiVersion || 'client.authentication.k8s.io/v1beta1',kind:'ExecCredential',status})), 20);
`);
let serial = 0;
function fixture(mode = 'token', overrides = {}, cluster = {}) {
  const id = ++serial;
  const log = join(dir, `log-${id}`);
  const config = join(dir, `config-${id}.json`);
  writeFileSync(config, JSON.stringify({
    'current-context': 'test', contexts: [{name:'test',context:{cluster:'cluster',user:'user'}}],
    clusters:[{name:'cluster',cluster:{server:'https://example.invalid',...cluster}}],
    users:[{name:'user',user:{exec:{command:process.execPath,args:[plugin,log,mode],apiVersion:'client.authentication.k8s.io/v1beta1',env:[{name:'AWS_PROFILE',value:'test-profile'}],...overrides}}}],
  }));
  return {connection:loadConnection(config,null), reload:()=>loadConnection(config,null), calls:()=>JSON.parse('['+readFileSync(log,'utf8').trim().split('\n').join(',')+']')};
}

test('concurrent requests across connections share one invocation and cached token', async () => {
  const f=fixture();
  const connections=Array.from({length:10},f.reload);
  await Promise.all(connections.map(resolveExecCredentials));
  assert.equal(f.calls().length,1);
  assert.ok(connections.every(c=>c.token==='token-1'));
  await resolveExecCredentials(f.connection);
  assert.equal(f.calls().length,1);
});

test('passes version, noninteractive input, env, CA and cluster extension', async () => {
  const f=fixture('token',{apiVersion:'client.authentication.k8s.io/v1',interactiveMode:'Never',provideClusterInfo:true},
    {'certificate-authority-data':Buffer.from('CA').toString('base64'),extensions:[{name:'client.authentication.k8s.io/exec',extension:{audience:'test'}}]});
  await resolveExecCredentials(f.connection);
  const {info,profile}=f.calls()[0];
  assert.equal(profile,'test-profile');
  assert.equal(info.apiVersion,'client.authentication.k8s.io/v1');
  assert.equal(info.kind,'ExecCredential');
  assert.equal(info.spec.interactive,false);
  assert.equal(info.spec.cluster.server,'https://example.invalid');
  assert.equal(info.spec.cluster['certificate-authority-data'],Buffer.from('CA').toString('base64'));
  assert.deepEqual(info.spec.cluster.config,{audience:'test'});
});

test('omits cluster information unless requested and rejects interactive-only plugins', async () => {
  const f=fixture();await resolveExecCredentials(f.connection);
  assert.equal(f.calls()[0].info.spec.cluster,undefined);
  const g=fixture('token',{interactiveMode:'Always'});
  await assert.rejects(resolveExecCredentials(g.connection),/interactive stdin/);
});

test('failed invocations can be retried and stdout is not exposed in errors', async () => {
  const f=fixture('fail-once');
  await assert.rejects(resolveExecCredentials(f.connection),/temporary failure/);
  await resolveExecCredentials(f.connection);
  assert.equal(f.connection.token,'token-2');
  const g=fixture('malformed');
  await assert.rejects(resolveExecCredentials(g.connection),e=>/usable JSON/.test(e.message)&&!e.message.includes('credential-secret'));
});

test('refreshes before expiry and does not let a stale rejection evict refreshed credentials', async () => {
  const f=fixture('expiry');
  const invalidate=await resolveExecCredentials(f.connection);
  const now=Date.now;
  try {
    const future=now()+70000;Date.now=()=>future;
    await resolveExecCredentials(f.connection);
    assert.equal(f.connection.token,'token-2');
  } finally {Date.now=now;}
  invalidate();
  await resolveExecCredentials(f.connection);
  assert.equal(f.calls().length,2);
});

test('applies certificate credentials and leaves static credentials alone', async () => {
  const f=fixture('cert');await resolveExecCredentials(f.connection);
  assert.equal(f.connection.cert.toString(),'CERT');assert.equal(f.connection.key.toString(),'KEY');
  const c={server:'https://example.invalid',contextName:'static',token:'static',insecure:false,authMethod:'token'};
  assert.equal(await resolveExecCredentials(c),undefined);assert.equal(c.token,'static');
});

test('HTTP 401 invalidates credentials for the next request, but 403 does not', async t => {
  let status=200;const seen=[];
  const server=http.createServer((req,res)=>{seen.push(req.headers.authorization);res.writeHead(status);res.end('{}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const f=fixture();f.connection.server=`http://127.0.0.1:${server.address().port}`;
  await apiGetText(f.connection,'/version');
  status=401;await assert.rejects(apiGetText(f.connection,'/version'),{status:401});
  status=200;await apiGetText(f.connection,'/version');
  assert.deepEqual(seen,['Bearer token-1','Bearer token-1','Bearer token-2']);
  status=403;await assert.rejects(apiGetText(f.connection,'/version'),{status:403});
  status=200;await apiGetText(f.connection,'/version');assert.equal(f.calls().length,2);
});

test('YAML preserves exec scalar args and env mapping entries', () => {
  assert.deepEqual(parseYaml('args:\n- --region\n- us-east-1\n- "123"\nenv:\n- name: AWS_PROFILE\n  value: test\n'),{args:['--region','us-east-1','123'],env:[{name:'AWS_PROFILE',value:'test'}]});
});
