// The markets rule (proposals/markets.md) on a throwaway chain: open, split, merge, resolve (wrong key, right key,
// twice), redeem before and after resolution, refund after expiry plus grace, the collateral invariant, and
// activation from a height.   node test/markets-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { Siding } from '../lib/chain.mjs';
import { recordScript, classify } from '../lib/records.mjs'; import { noIdOf } from '../lib/overlays/markets.mjs';
const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-markets-')); let ok = 0, bad = 0;
const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const throws = async (name, fn, re) => { try { await fn(); t(name + ' (did not throw)', false); } catch (e) { t(name + (re && !re.test(e.message) ? ` (threw: ${e.message.slice(0, 100)})` : ''), !re || re.test(e.message)); } };
const engine0 = await loadEngine(base); const signer = makeSigner(engine0);
const key = signer.randomKey(), pub = signer.pubkeyOf(key), me = '5120' + pub;             // the chain's signer, and a trader
const rkey = signer.randomKey(), rpub = signer.pubkeyOf(rkey), resolverSpk = '5120' + rpub; // the resolver
const chain = { ...base, id: 'sidestr:markettest', name: 'markettest', challenge: me, signer: pub, rules: ['assets', 'pool', 'markets'], pegs: [{ txid: 'a'.repeat(64), vout: 0, amount: 5e9, script: me }, { txid: 'b'.repeat(64), vout: 0, amount: 1e8, script: resolverSpk }] }; delete chain.genesisHash;
await throws('the markets rule needs the assets rule', async () => await loadEngine({ ...chain, rules: ['markets'] }), /needs the assets rule/);
const engine = await loadEngine(chain); const s = await new Siding({ engine, chain, dir, signer, log: () => {} }).open(key);
t('the engine loaded the rule', !!engine.rules.markets && engine.k.blocks.ruleSets.blockContext.rules.some((r) => r['@id'] === 'sidestr:rule-markets'));
while (s.tip().height < 101) await s.produce(key);
const { SIGHASH_UNIFIED } = await import(`${process.env.SCHEMA ?? os.homedir() + '/bitcoin-desktop/schema'}/codec/interpreter.js`);
// build a transaction from coins of `who` (key + script), plus foreign inputs (the market coin), signing what is ours
const mk = (who, inputs, outputs, extra = []) => {
  const tx = { version: 2, inputs: [...inputs.map((c) => ({ prevout: { txid: c.outpoint.split(':')[0], vout: Number(c.outpoint.split(':')[1]) }, scriptSig: '', sequence: 0xfffffffd })), ...extra.map((o) => ({ prevout: { txid: o.split(':')[0], vout: Number(o.split(':')[1]) }, scriptSig: '', sequence: 0xfffffffd }))], outputs, lockTime: 0, witness: [] };
  const prevouts = [...inputs.map((c) => ({ value: c.value, scriptPubKey: who.script })), ...extra.map((o) => ({ value: s.utxo.get(o).output.value, scriptPubKey: s.utxo.get(o).output.scriptPubKey }))];
  tx.witness = tx.inputs.map((_, i) => { if (i >= inputs.length) return []; const ht = 0x01 | SIGHASH_UNIFIED; let m = s.k.interpreter.sighashUnified(tx, i, prevouts, ht, 2); if (typeof m === 'string') m = engine.hash.hexToBytes(m); return [engine.hash.bytesToHex(signer.schnorrSign(m, who.key)) + ht.toString(16).padStart(2, '0')]; });
  return { tx, hex: s.k.codec.encodeHex('Transaction', tx), txid: s.k.codec.txid(tx) };
};
const trader = { key, script: me }, resolver = { key: rkey, script: resolverSpk };
const mature = (spk) => s.coins(spk).filter((c) => !c.coinbase || s.tip().height + 1 - c.height >= s.k.params.coinbaseMaturity);
const coin = (spk = me) => mature(spk).sort((a, b) => b.value - a.value)[0];
const R = (text) => ({ value: 0, scriptPubKey: recordScript(text) });
const M = engine.rules.markets; const carried = (txid, vout, asset) => engine.rules.assets.of(txid, vout)?.get(asset) ?? 0;
// --- open ---
const h0 = s.tip().height; const expiry = h0 + 30, grace = 5; const c0 = coin();
await throws('a market with an expiry in the past is refused', async () => await s.submit(mk(trader, [c0], [{ value: 1, scriptPubKey: '51' }, { value: c0.value - 1 - 2000, scriptPubKey: me }, R(`market:self:0:${rpub}:${h0 - 1}:${grace}`), R('question:Will it rain?')]).hex), /future height/);
await throws('a market without a question is refused', async () => await s.submit(mk(trader, [c0], [{ value: 1, scriptPubKey: '51' }, { value: c0.value - 1 - 2000, scriptPubKey: me }, R(`market:self:0:${rpub}:${expiry}:${grace}`)]).hex), /exactly one question/);
const open = mk(trader, [c0], [{ value: 1, scriptPubKey: '51' }, { value: c0.value - 1 - 2000, scriptPubKey: me }, R(`market:self:0:${rpub}:${expiry}:${grace}`), R('question:Will it rain in Prague on 1 October 2026?')]);
t('a market opens', (await s.submit(open.hex)).txid === open.txid); await s.produce(key); const ID = open.txid, YES = ID, NO = noIdOf(engine.hash, ID);
t('the chain records it: open, collateral 1, the resolver, the question, YES and NO registered as its assets', M.markets.get(ID)?.status === 'open' && M.markets.get(ID).C === 1 && M.markets.get(ID).resolver === rpub && /Prague/.test(M.markets.get(ID).question) && engine.rules.assets.issued.get(YES)?.ticker === 'YES' && engine.rules.assets.issued.get(NO)?.market === ID);
// --- split: 1000 sats into 1000 YES + 1000 NO, on two outputs of mine ---
const marketCoin = () => M.markets.get(ID).coin; let c = coin();
await throws('a split whose tallies do not match the collateral added is refused', async () => await s.submit(mk(trader, [c], [{ value: 1001, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: 1000, scriptPubKey: me }, { value: c.value - 1000 - 2000 - 2000, scriptPubKey: me }, R(`split:${ID}:0`), R(`tally:${YES}:1=999`), R(`tally:${NO}:2=1000`)], [marketCoin()]).hex), /tallies exactly 1000/);
const split = mk(trader, [c], [{ value: 1001, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: 1000, scriptPubKey: me }, { value: c.value - 1000 - 2000 - 2000, scriptPubKey: me }, R(`split:${ID}:0`), R(`tally:${YES}:1=1000`), R(`tally:${NO}:2=1000`)], [marketCoin()]);
t('a split of 1,000 sats mints 1,000 YES and 1,000 NO', (await s.submit(split.hex)).txid === split.txid); await s.produce(key);
t('collateral is 1,001; my outputs carry the pair', M.markets.get(ID).C === 1001 && carried(split.txid, 1, YES) === 1000 && carried(split.txid, 2, NO) === 1000);
// --- merge 400 back ---
const yesCoin = { outpoint: `${split.txid}:1`, value: 1000 }, noCoin = { outpoint: `${split.txid}:2`, value: 1000 }; c = coin();
const merge = mk(trader, [yesCoin, noCoin, c], [{ value: 601, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: 1000, scriptPubKey: me }, { value: c.value + 400 - 2000, scriptPubKey: me }, R(`merge:${ID}:0`), R(`tally:${YES}:1=600`), R(`tally:${NO}:2=600`)], [marketCoin()]);
t('a merge of 400 pairs releases 400 sats', (await s.submit(merge.hex)).txid === merge.txid); await s.produce(key);
t('collateral is 601 and 600 of each remain', M.markets.get(ID).C === 601 && carried(merge.txid, 1, YES) === 600 && carried(merge.txid, 2, NO) === 600);
const yes600 = { outpoint: `${merge.txid}:1`, value: 1000 }, no600 = { outpoint: `${merge.txid}:2`, value: 1000 };
// --- redeem before resolution is refused; resolve from the wrong key is refused ---
c = coin();
await throws('redeem before resolution is refused', async () => await s.submit(mk(trader, [yes600, c], [{ value: 1, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: c.value + 600 - 2000, scriptPubKey: me }, R(`redeem:${ID}:0`)], [marketCoin()]).hex), /open until expiry plus grace/);
await throws('resolve from a key that is not the resolver is refused', async () => await s.submit(mk(trader, [c], [{ value: 601, scriptPubKey: '51' }, { value: c.value - 2000, scriptPubKey: me }, R(`resolve:${ID}:yes`)], [marketCoin()]).hex), /no input spends a coin of the resolver/);
// --- resolve YES from the resolver's key ---
const rc = coin(resolverSpk); const resolve = mk(resolver, [rc], [{ value: 601, scriptPubKey: '51' }, { value: rc.value - 2000, scriptPubKey: resolverSpk }, R(`resolve:${ID}:yes`)], [marketCoin()]);
t('the resolver answers YES', (await s.submit(resolve.hex)).txid === resolve.txid); await s.produce(key);
t('the market is resolved with winner yes, collateral unchanged', M.markets.get(ID).status === 'resolved' && M.markets.get(ID).winner === 'yes' && M.markets.get(ID).C === 601);
const rc2 = coin(resolverSpk);
await throws('a second answer is refused', async () => await s.submit(mk(resolver, [rc2], [{ value: 601, scriptPubKey: '51' }, { value: rc2.value - 2000, scriptPubKey: resolverSpk }, R(`resolve:${ID}:no`)], [marketCoin()]).hex), /not open/);
// --- redeem: 600 YES -> 600 sats; NO redeems nothing ---
c = coin();
await throws('redeeming with the losing outcome is refused', async () => await s.submit(mk(trader, [no600, c], [{ value: 1, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: c.value + 600 - 2000, scriptPubKey: me }, R(`redeem:${ID}:0`)], [marketCoin()]).hex), /carries in at least 600 of the winner/);
const redeem = mk(trader, [yes600, c], [{ value: 1, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: c.value + 600 - 2000, scriptPubKey: me }, R(`redeem:${ID}:0`)], [marketCoin()]);
t('600 YES redeem for 600 sats', (await s.submit(redeem.hex)).txid === redeem.txid); await s.produce(key);
t('collateral is back to the opener\'s sat; the YES are gone', M.markets.get(ID).C === 1 && carried(redeem.txid, 1, YES) === 0);
// --- a second market that nobody resolves: refund at half par after expiry + grace ---
const h1 = s.tip().height; const exp2 = h1 + 3, gr2 = 2; c = coin();
const open2 = mk(trader, [c], [{ value: 1, scriptPubKey: '51' }, { value: c.value - 1 - 2000, scriptPubKey: me }, R(`market:self:0:${rpub}:${exp2}:${gr2}`), R('question:Will nobody answer this?')]);
await s.submit(open2.hex); await s.produce(key); const ID2 = open2.txid, YES2 = ID2, NO2 = noIdOf(engine.hash, ID2); const mc2 = () => M.markets.get(ID2).coin; c = coin();
const split2 = mk(trader, [c], [{ value: 201, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: 1000, scriptPubKey: me }, { value: c.value - 200 - 2000 - 2000, scriptPubKey: me }, R(`split:${ID2}:0`), R(`tally:${YES2}:1=200`), R(`tally:${NO2}:2=200`)], [mc2()]);
await s.submit(split2.hex); await s.produce(key); const y2 = { outpoint: `${split2.txid}:1`, value: 1000 }, n2 = { outpoint: `${split2.txid}:2`, value: 1000 };
c = coin();
await throws('refund before expiry plus grace is refused', async () => await s.submit(mk(trader, [y2, c], [{ value: 101, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: c.value + 100 - 2000, scriptPubKey: me }, R(`redeem:${ID2}:0`)], [mc2()]).hex), /open until expiry plus grace/);
while (s.tip().height + 1 <= exp2 + gr2) await s.produce(key);
const rc3 = coin(resolverSpk);
await throws('an answer after the grace period is refused', async () => await s.submit(mk(resolver, [rc3], [{ value: 201, scriptPubKey: '51' }, { value: rc3.value - 2000, scriptPubKey: resolverSpk }, R(`resolve:${ID2}:yes`)], [mc2()]).hex), /grace period has passed/);
c = coin();
await throws('a refund that destroys too little is refused', async () => await s.submit(mk(trader, [y2, c], [{ value: 51, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: c.value + 150 - 2000, scriptPubKey: me }, R(`redeem:${ID2}:0`)], [mc2()]).hex), /destroys YES and NO worth 300/);
const refund = mk(trader, [y2, c], [{ value: 101, scriptPubKey: '51' }, { value: 1000, scriptPubKey: me }, { value: c.value + 100 - 2000, scriptPubKey: me }, R(`redeem:${ID2}:0`)], [mc2()]);
t('200 YES refund for 100 sats after expiry plus grace', (await s.submit(refund.hex)).txid === refund.txid); await s.produce(key);
t('the market is refunding with collateral 101', M.markets.get(ID2).status === 'refunding' && M.markets.get(ID2).C === 101);
// --- the invariant, checked by a keyless validator replaying the chain ---
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-markets-v-')); fs.copyFileSync(`${dir}/blocks.dat`, `${dir2}/blocks.dat`); fs.copyFileSync(`${dir}/blocks.json`, `${dir2}/blocks.json`);
const engineV = await loadEngine(chain); const v = await new Siding({ engine: engineV, chain, dir: dir2, signer, log: () => {} }).open(null);
const supply = (e, asset) => { let n = 0; for (const m of e.rules.assets.carried.values()) n += m.get(asset) ?? 0; return n; };
t('a validator with no key agrees on both markets', v.tip().hash === s.tip().hash && engineV.rules.markets.markets.get(ID).status === 'resolved' && engineV.rules.markets.markets.get(ID2).status === 'refunding');
t('collateral covers the outstanding pairs: market 1 holds 1 sat over 0 YES and 600 NO (worthless), market 2 holds 101 over 0 YES and 200 NO at half par', engineV.rules.markets.markets.get(ID).C === 1 && supply(engineV, YES) === 0 && supply(engineV, NO) === 600 && engineV.rules.markets.markets.get(ID2).C === 101 && supply(engineV, YES2) === 0 && supply(engineV, NO2) === 200);
// --- activation from a height: the history below it must carry no market records (under assets alone they mint from nothing)
const from = h0 + 1; // the height of the first market's opening block
const engineF = await loadEngine({ ...chain, rules: ['assets', 'pool', { name: 'markets', from }] }); const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-markets-f-')); fs.copyFileSync(`${dir}/blocks.dat`, `${dir3}/blocks.dat`); fs.copyFileSync(`${dir}/blocks.json`, `${dir3}/blocks.json`);
const f = await new Siding({ engine: engineF, chain, dir: dir3, signer, log: () => {} }).open(null);
t(`a validator adopting the rule from height ${from}, where the first market opened, replays the chain and agrees`, f.tip().hash === s.tip().hash && engineF.rules.markets.markets.size === 2 && engineF.rules.markets.from === from);
const engineL = await loadEngine({ ...chain, rules: ['assets', 'pool', { name: 'markets', from: from + 1 }] }); const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-markets-l-')); fs.copyFileSync(`${dir}/blocks.dat`, `${dir4}/blocks.dat`); fs.copyFileSync(`${dir}/blocks.json`, `${dir4}/blocks.json`);
await throws('adopting it from a later height leaves a market block below as an asset block that mints from nothing, which is invalid', async () => await new Siding({ engine: engineL, chain, dir: dir4, signer, log: () => {} }).open(null), /rule-assets/);
t('a validator without the rule refuses the chain by name', await loadEngine({ ...chain, rules: ['assets', 'pool', 'oracle'] }).then(() => false, (e) => /does not have/.test(e.message)));
for (const d of [dir, dir2, dir3, dir4]) fs.rmSync(d, { recursive: true, force: true }); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
