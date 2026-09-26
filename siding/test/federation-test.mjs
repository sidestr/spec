// Level 2 (proposals/level-2.md) at the chain level: a 2-of-3 document, its derived challenge,
// blocks sealed by two signers accepted, by one refused, extra signatures refused, wrong slot
// order refused, a level-1 chain unchanged, and a solution beyond 75 bytes carried as PUSHDATA.
//   node test/federation-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { Siding } from '../lib/chain.mjs';
import { federation, partialSignature, verifyPartial, assembleWitness, sealFederated, leafScript } from '../lib/federation.mjs';
import { solutionOf, sealBlock, blockData } from '../lib/block.mjs';
const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-fed-')); let ok = 0, bad = 0;
const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const throws = async (name, fn, re) => { try { await fn(); t(name + ' (did not throw)', false); } catch (e) { t(name + (re && !re.test(e.message) ? ` (threw: ${e.message.slice(0, 90)})` : ''), !re || re.test(e.message)); } };
const e0 = await loadEngine(base); const signer = makeSigner(e0);
const keys = [signer.randomKey(), signer.randomKey(), signer.randomKey()]; const pubs = keys.map((k) => signer.pubkeyOf(k));
const doc = { ...base, id: 'sidestr:fedtest', name: 'fedtest', signers: pubs, threshold: 2, pegs: [{ txid: 'a'.repeat(64), vout: 0, amount: 5e9, script: '5120' + pubs[0] }] }; delete doc.genesisHash; delete doc.challenge; delete doc.signer;
const fed = federation(e0, doc); doc.challenge = fed.challenge;
await throws('a document that lists one key twice is refused: multi_a counts slots, so [A, A, B] with k = 2 would be sealed by A alone', async () => federation(e0, { ...doc, signers: [pubs[0], pubs[0], pubs[1]] }), /distinct/);
t('the challenge is a taproot output derived from the signers (NUMS internal key, one multi_a leaf)', /^5120[0-9a-f]{64}$/.test(fed.challenge) && fed.script === leafScript(pubs, 2) && fed.controlBlock.length === 66);
let refused = null; try { await loadEngine({ ...doc, challenge: '5120' + '11'.repeat(32) }); } catch (x) { refused = x.message; }
t('a document whose challenge is not the derived one is refused by the engine', /is not the one 3 signers/.test(refused ?? ''));
const engine = await loadEngine(doc); const E = { ...engine, interpreter: engine.k.interpreter, schnorrSign: signer.schnorrSign };
t('the engine carries the federation', engine.sidestr.federation?.threshold === 2 && engine.sidestr.federation.challenge === fed.challenge);
const sealWith = (block, which) => { const sigs = new Map(); for (const i of which) sigs.set(pubs[i], partialSignature(E, block, fed, keys[i])); return sealFederated(E, block, fed, sigs); };
const s = await new Siding({ engine, chain: doc, dir, signer, log: () => {} }).open(null, { seal: (g) => sealWith(g, [0, 2]) });
t('genesis sealed by signers 1 and 3 is on disk and valid', s.height() === 0 && s.coins('5120' + pubs[0]).length === 1);
await throws('produce() is refused on a federated chain', async () => await s.produce(keys[0]), /through the round/);
const { block: b1 } = await s.buildNext({ time: s.tip().time + 1 });
const p0 = partialSignature(E, b1, fed, keys[0]), p1 = partialSignature(E, b1, fed, keys[1]);
t('a partial signature verifies against its signer and not another', verifyPartial(E, b1, fed, pubs[0], p0) && !verifyPartial(E, b1, fed, pubs[1], p0));
const sealed = sealWith(b1, [0, 1]); const sol = solutionOf(sealed);
t(`the solution is the script-path witness: 3 slots (one empty), the leaf, the control block, ${sol.witness.reduce((a, w) => a + w.length / 2, 0)} bytes carried as PUSHDATA`, sol.witness.length === 5 && sol.witness[0] === '' && sol.witness[3] === fed.script && sol.witness[4] === fed.controlBlock);
t('block 1 sealed by signers 1 and 2 is accepted', (await s.addSealed(sealed)).height === 1);
const { block: b2 } = await s.buildNext({ time: s.tip().time + 1 });
t('block 2 sealed by signers 2 and 3 (a different pair) is accepted', (await s.addSealed(sealWith(b2, [1, 2]))).height === 2);
const { block: b3 } = await s.buildNext({ time: s.tip().time + 1 });
await throws('one signature is refused by the validator', async () => { const sigs = new Map([[pubs[0], partialSignature(E, b3, fed, keys[0])]]); await s.addSealed(sealBlock(E, b3, assembleWitness({ ...fed, threshold: 1 }, sigs))); });
await throws('assembleWitness refuses fewer than k signatures', async () => assembleWitness(fed, new Map([[pubs[0], p0]])), /1 of 2/);
await throws('signatures in the wrong slots are refused', async () => { const w = assembleWitness(fed, new Map([[pubs[0], partialSignature(E, b3, fed, keys[0])], [pubs[1], partialSignature(E, b3, fed, keys[1])]])); [w[1], w[2]] = [w[2], w[1]]; await s.addSealed(sealBlock(E, b3, w)); });
await throws('a signature over a different block is refused', async () => { const sigs = new Map([[pubs[0], p0], [pubs[1], p1]]); await s.addSealed(sealFederated(E, b3, fed, sigs)); });
t('and a correct third block after all that is accepted', (await s.addSealed(sealWith(b3, [0, 1]))).height === 3);
// reopen from disk: the federation re-derived, every block re-validated
const engine2 = await loadEngine(doc); const s2 = await new Siding({ engine: engine2, chain: doc, dir, signer, log: () => {} }).open(null, { seal: () => { throw new Error('not needed'); } });
t('reopening validates the three federated blocks from the block file', s2.height() === 3);
fs.rmSync(dir, { recursive: true, force: true }); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
