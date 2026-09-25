// The assets and pool rules (SPEC 12) on a throwaway chain: records, issuance, conservation,
// opening a pool, swap / add / remove at their boundaries, and the producer sequencing conflicts.
//   node test/rules-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { Siding } from '../lib/chain.mjs';
import { recordScript, recordText, parseTally, classify, isqrt } from '../lib/records.mjs';
const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-rules-')); let ok = 0, bad = 0;
const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const throws = async (name, fn, re) => { try { await fn(); t(name + ' (did not throw)', false); } catch (e) { t(name + (re && !re.test(e.message) ? ` (threw: ${e.message.slice(0, 100)})` : ''), !re || re.test(e.message)); } };
const engine0 = await loadEngine(base); const signer = makeSigner(engine0); const key = signer.randomKey(), pub = signer.pubkeyOf(key); const me = '5120' + pub;
const chain = { ...base, id: 'sidestr:rulestest', name: 'rulestest', challenge: me, signer: pub, rules: ['assets', 'pool'], pegs: [{ txid: 'a'.repeat(64), vout: 0, amount: 5e9, script: me }] }; delete chain.genesisHash;
let refused = null; try { await loadEngine({ ...chain, rules: ['assets', 'oracle'] }); } catch (e) { refused = e.message; }
t('a document naming a rule this validator lacks is refused', /does not have/.test(refused ?? ''));
const engine = await loadEngine(chain); const s = await new Siding({ engine, chain, dir, signer, log: () => {} }).open(key);
t('the engine loaded both rules', !!engine.rules.assets && !!engine.rules.pool && engine.k.blocks.ruleSets.blockContext.rules.some((r) => r['@id'] === 'sidestr:rule-pool'));
while (s.tip().height < 101) await s.produce(key);
// records
const hx = (t) => Buffer.from(t).toString('hex');
t('recordText refuses a push whose length is not its data: bytes after the push, bytes missing, and a long push over its length', recordText('6a03' + hx('tally:x')) === null && recordText('6a07' + hx('abc')) === null && recordText('6a4c50' + hx('y'.repeat(81))) === null && recordText('6a4c50' + hx('y'.repeat(80))) === 'y'.repeat(80));
t('recordScript/recordText round-trip, short and long pushes', recordText(recordScript('issue:SHELL:2')) === 'issue:SHELL:2' && recordText(recordScript('x'.repeat(200))) === 'x'.repeat(200));
t('a tally with a duplicate vout is malformed', parseTally('tally:self:0=5,0=6') === null && parseTally('tally:self:0=5,1=6').assigns.length === 2);
t('isqrt is exact', isqrt(10n ** 18n) === 10n ** 9n && isqrt(99n) === 9n);
// helpers: spend from my coins, signing every input; outputs given; returns { hex, tx, txid }
const { SIGHASH_UNIFIED } = await import(`${process.env.SCHEMA ?? os.homedir() + '/bitcoin-desktop/schema'}/codec/interpreter.js`);
const mature = () => s.coins(me).filter((c) => !c.coinbase || s.tip().height + 1 - c.height >= s.k.params.coinbaseMaturity);
const mk = (inputs, outputs, extraInputs = []) => {
  const tx = { version: 2, inputs: [...inputs.map((c) => ({ prevout: { txid: c.outpoint.split(':')[0], vout: Number(c.outpoint.split(':')[1]) }, scriptSig: '', sequence: 0xfffffffd })), ...extraInputs.map((o) => ({ prevout: { txid: o.split(':')[0], vout: Number(o.split(':')[1]) }, scriptSig: '', sequence: 0xfffffffd }))], outputs, lockTime: 0, witness: [] };
  const prevouts = [...inputs.map((c) => ({ value: c.value, scriptPubKey: me })), ...extraInputs.map((o) => ({ value: s.utxo.get(o).output.value, scriptPubKey: s.utxo.get(o).output.scriptPubKey }))];
  tx.witness = tx.inputs.map((_, i) => { if (i >= inputs.length) return []; const ht = 0x01 | SIGHASH_UNIFIED; let m = s.k.interpreter.sighashUnified(tx, i, prevouts, ht, 2); if (typeof m === 'string') m = engine.hash.hexToBytes(m); return [engine.hash.bytesToHex(signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0')]; });
  return { tx, hex: s.k.codec.encodeHex('Transaction', tx), txid: s.k.codec.txid(tx) };
};
const coin = () => mature().sort((a, b) => b.value - a.value)[0];
// --- issuance ---
const c0 = coin();
const issue = mk([c0], [{ value: 1000, scriptPubKey: me }, { value: c0.value - 1000 - 2000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript('issue:SHELL:2') }, { value: 0, scriptPubKey: recordScript('tally:self:0=1000000') }]);
t('submit accepts an issuance of 1,000,000 SHELL onto output 0', (await s.submit(issue.hex)).txid === issue.txid);
await s.produce(key); const SHELL = issue.txid;
t('the chain records the asset and what output 0 carries', engine.rules.assets.issued.get(SHELL)?.ticker === 'SHELL' && engine.rules.assets.of(SHELL, 0)?.get(SHELL) === 1000000);
await throws('tally:self without issue: is refused', async () => await s.submit(mk([coin()], [{ value: 1000, scriptPubKey: me }, { value: coin().value - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript('tally:self:0=5') }]).hex), /tally:self without/);
await throws('assigning an asset the inputs do not carry is refused', async () => await s.submit(mk([coin()], [{ value: 1000, scriptPubKey: me }, { value: coin().value - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript(`tally:${SHELL}:0=1`) }]).hex), /but carries 0/);
await throws('a tally naming an OP_RETURN output is refused', async () => await s.submit(mk([coin()], [{ value: 1000, scriptPubKey: me }, { value: coin().value - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript('issue:BAD:0') }, { value: 0, scriptPubKey: recordScript('tally:self:2=5') }]).hex), /an OP_RETURN/);
await throws('a malformed record of ours is refused', async () => await s.submit(mk([coin()], [{ value: 1000, scriptPubKey: me }, { value: coin().value - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript('issue:toolongticker:0') }]).hex), /malformed/);
// --- transfer + burn by omission ---
const shellCoin = { outpoint: `${SHELL}:0`, value: 1000 };
const xfer = mk([shellCoin, coin()], [{ value: 1000, scriptPubKey: me }, { value: 1000, scriptPubKey: me }, { value: coin().value + 1000 - 2000 - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript(`tally:${SHELL}:0=600000,1=300000`) }]);
t('a transfer of 600k + 300k (100k burned by omission) is accepted', (await s.submit(xfer.hex)).txid === xfer.txid); await s.produce(key);
t('outputs carry 600k and 300k; the input is gone', engine.rules.assets.of(SHELL, 0) === null && engine.rules.assets.of(xfer.txid, 0)?.get(SHELL) === 600000 && engine.rules.assets.of(xfer.txid, 1)?.get(SHELL) === 300000);
// --- open a pool: 1 tBTC + 600k SHELL ---
const big = coin(); const a600 = { outpoint: `${xfer.txid}:0`, value: 1000 };
const X0 = 100000000, Y0 = 600000, S0 = Number(isqrt(BigInt(X0) * BigInt(Y0)));
const open = mk([a600, big], [{ value: X0, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: big.value + 1000 - X0 - 1000 - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript('pool:self:0') }, { value: 0, scriptPubKey: recordScript(`tally:${SHELL}:0=${Y0}`) }, { value: 0, scriptPubKey: recordScript(`tally:self:1=${S0}`) }]);
t(`opening a pool with ${X0} sats + ${Y0} SHELL, ${S0} shares, is accepted`, (await s.submit(open.hex)).txid === open.txid); await s.produce(key);
const POOL = open.txid; const P = () => engine.rules.pool.pools.get(POOL);
t('the pool is recorded: asset, x, y, shares, outpoint', P()?.asset === SHELL && P().x === X0 && P().y === Y0 && P().shares === S0 && P().outpoint === `${POOL}:0`);
await throws('opening with the wrong share count is refused', async () => await s.submit(mk([{ outpoint: `${xfer.txid}:1`, value: 1000 }, coin()], [{ value: 1000000, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: coin().value + 1000 - 1000000 - 1000 - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript('pool:self:0') }, { value: 0, scriptPubKey: recordScript(`tally:${SHELL}:0=300000`) }, { value: 0, scriptPubKey: recordScript('tally:self:1=1') }]).hex), /exactly/);
// --- swap: 1,000,000 sats in -> SHELL out, at the boundary ---
const quote = (x, y, dx) => Number((BigInt(y) * BigInt(dx) * 997n) / (BigInt(x) * 1000n + BigInt(dx) * 997n));
const dx = 1000000, out = quote(X0, Y0, dx);
const swapTx = (outAmt) => { const c = coin(); return mk([c], [{ value: X0 + dx, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: c.value - dx - 1000 - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript(`pool:${POOL}:0`) }, { value: 0, scriptPubKey: recordScript(`tally:${SHELL}:0=${Y0 - outAmt},1=${outAmt}`) }], [`${POOL}:0`]); };
await throws(`taking ${out + 1} SHELL (one unit past the invariant) is refused`, async () => await s.submit(swapTx(out + 1).hex), /constant product/);
const sw = swapTx(out); t(`taking ${out} SHELL for ${dx} sats is accepted (pool input witness empty: OP_TRUE)`, (await s.submit(sw.hex)).txid === sw.txid); await s.produce(key);
t('the pool moved to x + dx and y - out, shares unchanged', P().x === X0 + dx && P().y === Y0 - out && P().shares === S0 && P().outpoint === `${sw.txid}:0`);
t('the swapper carries the SHELL', engine.rules.assets.of(sw.txid, 1)?.get(SHELL) === out);
// --- add liquidity: 10% more of each, mints floor(S*dx/x) ---
const p1 = P(); const ax = Math.floor(p1.x / 10), ay = Math.floor(p1.y / 10); const mint = Math.min(Math.floor(ax * p1.shares / p1.x), Math.floor(ay * p1.shares / p1.y));
const shellFor = { outpoint: `${xfer.txid}:1`, value: 1000 }; // carries 300k SHELL
const addTx = (m) => { const c = coin(); return mk([shellFor, c], [{ value: p1.x + ax, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: 1000, scriptPubKey: me }, { value: c.value + 1000 - ax - 2000 - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript(`pool:${POOL}:0`) }, { value: 0, scriptPubKey: recordScript(`tally:${SHELL}:0=${p1.y + ay},1=${300000 - ay}`) }, { value: 0, scriptPubKey: recordScript(`tally:${POOL}:2=${m}`) }], [p1.outpoint]); };
await throws(`minting ${mint + 1} shares for that add is refused`, async () => await s.submit(addTx(mint + 1).hex), /at most/);
const ad = addTx(mint); t(`adding ${ax} sats + ${ay} SHELL mints ${mint} shares`, (await s.submit(ad.hex)).txid === ad.txid); await s.produce(key);
t('shares in existence grew by the mint', P().shares === S0 + mint && P().x === p1.x + ax && P().y === p1.y + ay);
// --- remove: burn the minted shares, take the pro-rata part (rounded down), one sat more refused ---
const p2 = P(); const rx = Math.floor(p2.x * mint / p2.shares), ry = Math.floor(p2.y * mint / p2.shares);
const remTx = (takeX) => { const c = coin(); return mk([{ outpoint: `${ad.txid}:2`, value: 1000 }, c], [{ value: p2.x - takeX, scriptPubKey: '51' }, { value: 1000 + takeX, scriptPubKey: me }, { value: c.value + 1000 - 1000 - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript(`pool:${POOL}:0`) }, { value: 0, scriptPubKey: recordScript(`tally:${SHELL}:0=${p2.y - ry},1=${ry}`) }], [p2.outpoint]); };
await throws('taking one sat more than pro rata is refused', async () => await s.submit(remTx(rx + 1).hex), /pro-rata/);
const rm = remTx(rx); t(`removing ${mint} shares takes ${rx} sats + ${ry} SHELL`, (await s.submit(rm.hex)).txid === rm.txid); await s.produce(key);
t('shares are back to the opening count', P().shares === S0);
// --- two swaps on one pool in one block: the second is dropped by the producer, not a broken block ---
const p3 = P(); const q1 = quote(p3.x, p3.y, 500000);
const s1 = (() => { const c = coin(); return mk([c], [{ value: p3.x + 500000, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: c.value - 500000 - 1000 - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript(`pool:${POOL}:0`) }, { value: 0, scriptPubKey: recordScript(`tally:${SHELL}:0=${p3.y - q1},1=${q1}`) }], [p3.outpoint]); })();
await s.submit(s1.hex);
await throws('a second swap of the same pool coin is refused by the mempool as a double spend', async () => { const c = mature().filter((x) => x.outpoint !== s1.tx.inputs[0].prevout.txid + ':' + s1.tx.inputs[0].prevout.vout).sort((a, b) => b.value - a.value)[0]; await s.submit(mk([c], [{ value: p3.x + 1, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: c.value - 1 - 1000 - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript(`pool:${POOL}:0`) }, { value: 0, scriptPubKey: recordScript(`tally:${SHELL}:0=${p3.y}`) }], [p3.outpoint]).hex); }, /already spent in the mempool/);
const r = await s.produce(key); t('the block with the first swap is produced', r.txs === 2 && P().outpoint === `${s1.txid}:0`);
// --- a hand-made block that breaks a rule is refused by the validator (through addBlock) ---
const { buildBlock, signBlock } = await import('../lib/block.mjs');
const badTx = (() => { const c = coin(); return mk([c], [{ value: 1000, scriptPubKey: me }, { value: c.value - 1000 - 3000, scriptPubKey: me }, { value: 0, scriptPubKey: recordScript(`tally:${SHELL}:0=1`) }]); })();
const tip = s.tip(); const bb = buildBlock(engine, { height: tip.height + 1, prev: tip.hash, time: tip.time + 1, transactions: [badTx.tx], outputs: [{ value: 3000, scriptPubKey: me }], bits: s.bits });
await throws('validator: a block whose transaction assigns what it does not carry is refused', async () => await s.addBlock(s.k.codec.encodeHex('Block', signBlock({ ...engine, interpreter: s.k.interpreter, schnorrSign: signer.schnorrSign }, bb, chain.challenge, key))));
t('and the chain still produces after the refusal', (await s.produce(key)).height === s.tip().height);
// --- reopen from disk: the same state ---
const engine2 = await loadEngine(chain); const s2 = await new Siding({ engine: engine2, chain, dir, signer: makeSigner(engine2), log: () => {} }).open(key);
const q = engine2.rules.pool.pools.get(POOL); t('reopening derives the same pool state and carried amounts from the block file', q.x === P().x && q.y === P().y && q.shares === S0 && engine2.rules.assets.of(s1.txid, 1)?.get(SHELL) === q1 && s2.tip().height === s.tip().height);
fs.rmSync(dir, { recursive: true, force: true }); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
