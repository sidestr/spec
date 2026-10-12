// Real-kernel fault injection; no parent RPC, relays or production keys.
// SCHEMA=/path/to/schema BLAKETESTNODE=/path/to/blaketestnode node --test test/persistence-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadEngine } from '../lib/engine.mjs';
import { makeSigner } from '../lib/sign.mjs';
import { Siding } from '../lib/chain.mjs';

const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url)));
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-persistence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signer = makeSigner(await loadEngine(base)), key = signer.randomKey(), pub = signer.pubkeyOf(key);
  const chain = { ...base, id: 'sidestr:persistence-test', challenge: '5120' + pub, signer: pub, pegs: [] };
  delete chain.genesisHash;
  const engine = await loadEngine(chain), failures = [];
  const s = await new Siding({ engine, chain, dir, signer, onPersistenceError: e => failures.push(e) }).open(key);
  return { dir, signer, key, chain, engine, failures, s };
}
function fault(t, method, target, partial = false) {
  const original = fs[method];
  fs[method] = (p, ...args) => {
    // blaketestnode before 5781862 writes the index in place; from it on, to `<index>.tmp-<pid>` and renames
    if (p !== target && !String(p).startsWith(`${target}.tmp-`)) return original(p, ...args);
    if (partial) original(p, args[0].subarray(0, 11));
    throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
  };
  syncBuiltinESMExports();
  const restore = () => { fs[method] = original; syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}
for (const [name, method, file, partial] of [
  ['append failure', 'appendFileSync', 'blocks.dat', false],
  ['partial append', 'appendFileSync', 'blocks.dat', true],
  ['index failure after append', 'writeFileSync', 'blocks.json', false],
]) test(name + ' halts instead of extending an unsaved tip', async t => {
  const { s, dir, key, failures } = await fixture(t);
  const restore = fault(t, method, path.join(dir, file), partial);
  await assert.rejects(s.produce(key), e => e.code === 'SIDING_PERSISTENCE_FAILED' && e.cause.code === 'ENOSPC');
  assert.equal(failures.length, 1);
  assert.equal(s.node.height, 1); // the real failure ordering, not a mocked chain
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'blocks.json'))).to, 0);
  restore(); // space returns, but this instance must remain halted
  const bytes = fs.readFileSync(path.join(dir, 'blocks.dat'));
  await assert.rejects(s.produce(key), e => e === failures[0]);
  await assert.rejects(s.addBlock('invalid'), e => e === failures[0]);
  await assert.rejects(s.submit('invalid'), e => e === failures[0]);
  await assert.rejects(s.open(key), e => e === failures[0]);
  for (const read of [() => s.tip(), () => s.height(), () => s.coins(''), () => s.pegouts(), () => s.claimed('', 0)]) assert.throws(read, e => e === failures[0]);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'blocks.dat')), bytes);
  assert.equal(failures.length, 1);
});

test('persistence failure is never retried as a mempool admission fault', async t => {
  const { s, dir, key } = await fixture(t);
  const build = s.buildNext.bind(s);
  s.buildNext = async opts => { const result = await build(opts); s.mempool.set('sentinel', { inputs: [], outputs: [] }); return result; };
  let evictions = 0;
  s.evictUnblockable = async () => { evictions++; return ['sentinel']; };
  fault(t, 'appendFileSync', path.join(dir, 'blocks.dat'));
  await assert.rejects(s.produce(key), { code: 'SIDING_PERSISTENCE_FAILED' });
  assert.equal(evictions, 0);
});

test('a validation rejection does not halt ordinary production or replay', async t => {
  const { s, dir, key, engine, chain, signer, failures } = await fixture(t);
  await assert.rejects(s.addBlock('00'));
  assert.equal((await s.produce(key)).height, 1);
  const replay = await new Siding({ engine: await loadEngine(chain), chain, dir, signer }).open(null);
  assert.deepEqual(replay.tip(), s.tip());
  assert.equal(failures.length, 0);
});

test('producer CLI exits nonzero at the first storage fault', async t => {
  const { dir, key, chain } = await fixture(t);
  const chainFile = path.join(dir, 'chain.json'), keyFile = path.join(dir, 'key'), preload = path.join(dir, 'fault.mjs');
  fs.writeFileSync(chainFile, JSON.stringify(chain)); fs.writeFileSync(keyFile, key, { mode: 0o600 });
  fs.writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const append = fs.appendFileSync; fs.appendFileSync = (p, ...a) => {
  if (p === ${JSON.stringify(path.join(dir, 'blocks.dat'))}) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
  return append(p, ...a);
}; syncBuiltinESMExports();`);
  const cli = fileURLToPath(new URL('../bin/siding.mjs', import.meta.url));
  const r = spawnSync(process.execPath, ['--import', preload, cli, 'produce', '--chain', chainFile, '--dir', dir,
    '--key-file', keyFile, '--interval', '0', '--port', '0'], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(r.error);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /block 1 persistence failed; chain halted: injected ENOSPC/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'blocks.json'))).to, 0);
});
