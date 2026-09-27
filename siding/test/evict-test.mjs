// A transaction admission accepted but a block rule refuses must not stall the producer (spec issue 13):
// it is evicted with the rules it broke, remembered for the session, and the block is made without it.
// Modelled on claims-test: a throwaway chain in a temp dir, the real engine.   node test/evict-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { Siding } from '../lib/chain.mjs';
const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-evict-')); let ok = 0, bad = 0;
const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const throws = async (name, fn, re) => { try { await fn(); t(name + ' (did not throw)', false); } catch (e) { t(name + (re && !re.test(e.message) ? ` (threw: ${e.message.slice(0, 80)})` : ''), !re || re.test(e.message)); } };
const engine0 = await loadEngine(base); const signer = makeSigner(engine0); const key = signer.randomKey(), pub = signer.pubkeyOf(key); const me = '5120' + pub;
const chain = { ...base, id: 'sidestr:evicttest', name: 'evicttest', challenge: me, signer: pub, pegs: [{ txid: 'a'.repeat(64), vout: 0, amount: 5e9, script: me }, { txid: 'b'.repeat(64), vout: 0, amount: 5e9, script: me }] }; delete chain.genesisHash;
const engine = await loadEngine(chain); const logs = []; const s = await new Siding({ engine, chain, dir, signer, log: (m) => logs.push(m) }).open(key);
while (s.tip().height < 101) await s.produce(key); // mature the genesis coins
const { SIGHASH_UNIFIED } = await import(`${process.env.SCHEMA ?? os.homedir() + '/bitcoin-desktop/schema'}/codec/interpreter.js`);
const you = '5120' + signer.pubkeyOf(signer.randomKey());
// a spend of one genesis coin, signed with `withKey` (the right key, or a wrong one for a transaction whose script fails)
const spend = (coin, withKey, fee = 1000) => { const [txid, vout] = coin.outpoint.split(':'); const tx = { version: 2, inputs: [{ prevout: { txid, vout: Number(vout) }, scriptSig: '', sequence: 0xfffffffd }], outputs: [{ value: coin.value - fee, scriptPubKey: you }], lockTime: 0, witness: [] };
  const prevouts = [{ value: coin.value, scriptPubKey: me }]; const ht = 0x01 | SIGHASH_UNIFIED; let m = s.k.interpreter.sighashUnified(tx, 0, prevouts, ht, 2); if (typeof m === 'string') m = engine.hash.hexToBytes(m);
  tx.witness = [[engine.hash.bytesToHex(signer.schnorrSign(m, withKey)) + ht.toString(16).padStart(2, '0')]]; return tx; };
const [c0, c1] = s.coins(me).filter((c) => c.height === 0);
const good = spend(c0, key), badTx = spend(c1, signer.randomKey()); const goodId = s.k.codec.txid(good), badId = s.k.codec.txid(badTx), badHex = s.k.codec.encodeHex('Transaction', badTx);
await throws('admission refuses the bad transaction on its own (the script fails)', async () => await s.submit(badHex), /input 0/);
// the premise of issue 13: admission and production disagree. Plant the bad transaction as if admission had let it through.
await s.submit(s.k.codec.encodeHex('Transaction', good)); s.mempool.set(badId, badTx); for (const i of badTx.inputs) s.mempoolSpent.add(`${i.prevout.txid}:${i.prevout.vout}`);
t('the mempool holds both', s.mempool.size === 2);
const { signBlock } = await import('../lib/block.mjs');
const withBad = signBlock({ ...engine, interpreter: s.k.interpreter, schnorrSign: signer.schnorrSign }, (await s.buildNext({ txs: [good, badTx] })).block, chain.challenge, key);
t('checkBlock refuses a block carrying the bad transaction', s.checkBlock(s.k.codec.encodeHex('Block', withBad)).ok === false);
const before = s.tip().height; const r = await s.produce(key);
t('the producer made the next block instead of stalling', r.height === before + 1 && s.tip().height === before + 1);
t('the block carries the good transaction and not the bad one', r.txs === 2 && s.coins(you).length === 1 && s.coins(you)[0].value === c0.value - 1000);
t('the bad transaction was evicted with the rules it broke', r.evicted.length === 1 && r.evicted[0].txid === badId && /script|witness|sig/i.test(r.evicted[0].why));
t('it is remembered for the session', s.rejected.get(badId)?.why === r.evicted[0].why && s.mempool.size === 0 && s.mempoolSpent.size === 0);
t('the eviction was logged once', logs.filter((m) => m.includes(badId.slice(0, 16)) && m.includes('evicted')).length === 1);
await throws('a relay replay of the same transaction is refused by admission', async () => await s.submit(badHex), /rejected this session/);
t('and an ordinary block after that still produces', (await s.produce(key)).height === before + 2);
// the same coin spent again with the right key has the same txid (the witness is outside it) and is judged afresh
await s.submit(s.k.codec.encodeHex('Transaction', spend(c1, key)));
t('a re-signed transaction with the same txid is admitted', s.mempool.has(badId));
const r2 = await s.produce(key); t('and mined with nothing evicted', r2.txs === 2 && r2.evicted.length === 0 && s.coins(you).length === 2);
fs.rmSync(dir, { recursive: true, force: true }); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
