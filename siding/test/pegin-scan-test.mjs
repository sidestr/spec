// Peg-in scanning against a fake parent node (issue 15): the peg wallet's own change is never the peg, a transaction
// the peg wallet funded is a peg-in only by the announced script, and one marker transaction is claimed at most once
// across a re-scan.   node test/pegin-scan-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { scanPegins, newPegins } from '../lib/parent.mjs'; import { pegMarkerData } from '../lib/marker.mjs';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { Siding } from '../lib/chain.mjs';
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const CHAIN = 'sidestr:scantest'; const DEST = '5120' + '11'.repeat(32);
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const markerSpk = (() => { const d = pegMarkerData(CHAIN, DEST); return '6a' + d.length.toString(16).padStart(2, '0') + hex(d); })();
const tr = (n, address, sats) => ({ n, value: sats / 1e8, scriptPubKey: { type: 'witness_v1_taproot', hex: '5120' + address.slice(0, 1).repeat(64).padEnd(64, '0'), address } });
const marker = (n) => ({ n, value: 0, scriptPubKey: { type: 'nulldata', hex: markerSpk } });
// addresses: A the pegger's peg output (a tr(signer, refund) the wallet does not own), C the peg wallet's change,
// M the peg wallet's announced address (owned, not change), P the pegger's own change
const info = { A: { ismine: false }, C: { ismine: true, ischange: true }, M: { ismine: true, ischange: false }, P: { ismine: false } };
const FUNDED = 'f'.repeat(64), PEGGER = 'e'.repeat(64), SELF = 'd'.repeat(64);
const block = { tx: [
  { txid: 'c'.repeat(64), vin: [{ coinbase: '00' }], vout: [tr(0, 'M', 5000000000)] },
  { txid: FUNDED, vin: [{ txid: '1'.repeat(64), vout: 0 }], vout: [tr(0, 'A', 50000), marker(1), tr(2, 'C', 49000)] },   // the peg wallet paid: A is the peg, C its change (dreamlab 2c4c5941…)
  { txid: PEGGER, vin: [{ txid: '2'.repeat(64), vout: 0 }], vout: [tr(0, 'P', 30000), marker(1), tr(2, 'M', 70000)] },   // a pegger paid: change first, then the peg to the announced address
  { txid: SELF, vin: [{ txid: '3'.repeat(64), vout: 0 }], vout: [tr(0, 'M', 20000), marker(1), tr(2, 'C', 10000)] },     // the peg wallet paid its own announced address
] };
const parent = (withWallet) => ({
  rpc: async (m, p) => { if (m === 'getblockhash') return 'h'; if (m === 'getblock') return block; throw new Error('unexpected ' + m); },
  walletRpc: withWallet ? async (m, p) => { if (m === 'getaddressinfo') return info[p[0]]; if (m === 'gettransaction') { if (p[0] === FUNDED || p[0] === SELF) return { details: [{ category: 'send' }] }; throw new Error('Invalid or non-wallet transaction id'); } throw new Error('unexpected ' + m); } : null,
});
const scan = async (withWallet, pegScript = null) => { const f = await scanPegins(parent(withWallet), { chainId: CHAIN, from: 1, to: 1, pegScript }); return Object.fromEntries(f.map((p) => [p.txid, p.vout])); };
let r = await scan(false);
t('no wallet, no announcement: the first taproot output of every marker transaction (0.0.1 behaviour)', r[FUNDED] === 0 && r[PEGGER] === 0 && r[SELF] === 0);
r = await scan(true);
t('with the peg wallet: its change is not the peg, and a transaction it funded is not a peg-in', r[FUNDED] === undefined);
t('with the peg wallet: the pegger\'s transaction pegs the owned output, not the pegger\'s change', r[PEGGER] === 2);
t('with the peg wallet: the wallet paying its own address is not a deposit', r[SELF] === undefined);
r = await scan(true, tr(0, 'A', 0).scriptPubKey.hex);
t('the announced script wins wherever it sits: A is the peg even though the wallet funded the transaction', r[FUNDED] === 0);
t('and the others fall back to ownership as before', r[PEGGER] === 2 && r[SELF] === undefined);
r = await scan(true, tr(0, 'M', 0).scriptPubKey.hex);
t('announced M: the wallet\'s payment to its own announced address is a peg-in by the announcement', r[SELF] === 0 && r[PEGGER] === 2);
// one claim per marker transaction, across re-scans
const found = [{ txid: FUNDED, vout: 2, amount: 49000 }, { txid: PEGGER, vout: 2, amount: 70000 }, { txid: PEGGER, vout: 0, amount: 30000 }];
t('a re-scan that finds a second output of a known transaction adds nothing for it', newPegins(found, [{ txid: FUNDED, vout: 0 }]).map((p) => `${p.txid.slice(0, 1)}:${p.vout}`).join(',') === 'e:2');
t('a transaction the chain already claimed is not added whatever output the scan names', newPegins(found, [], (txid) => txid === FUNDED).length === 1);
// claimedTx on a real chain: a claim of X:0 makes every output of X claimed
const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8')); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-scan-'));
const engine0 = await loadEngine(base); const signer = makeSigner(engine0); const key = signer.randomKey(), pub = signer.pubkeyOf(key); const me = '5120' + pub;
const chain = { ...base, id: CHAIN, name: 'scantest', challenge: me, signer: pub, pegs: [{ txid: 'a'.repeat(64), vout: 0, amount: 5e9, script: me }] }; delete chain.genesisHash;
const engine = await loadEngine(chain); const s = await new Siding({ engine, chain, dir, signer }).open(key);
await s.produce(key, { claims: [{ txid: FUNDED, vout: 0, amount: 50000, script: DEST }] });
t('claimedTx: the transaction is claimed once any output of it is', s.claimedTx(FUNDED) && !s.claimedTx(PEGGER) && s.claimed(FUNDED, 0) && !s.claimed(FUNDED, 2));
fs.rmSync(dir, { recursive: true, force: true }); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
