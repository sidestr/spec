// lib/pegtweak.mjs: the peg-in tweak form (#23). The output is BIP 341 exactly (checked against the engine's own
// tapOutputKey/checkTapTweak); two chains give two addresses from one key; the reveal rebuilds the output; every
// leaf's control block proves its path; the holders' key-path secret signs for the output.
//   node test/pegtweak-test.mjs            (SCHEMA=<bitcoin-desktop/schema checkout>; default under ~)
import os from 'node:os';
import { makeKeys } from '../lib/keys.mjs'; import { makeSigner } from '../lib/schnorr.mjs';
import { pegOutput, pegMatches, pegSpendSecret, pegCommitment, commitLeaf, refundLeaf, tapTree, leafHash, PEG_TAG } from '../lib/pegtweak.mjs';
import { leafScript, NUMS_X } from '../lib/federation.mjs';
const SCHEMA = process.env.SCHEMA ?? os.homedir() + '/bitcoin-desktop/schema';
const [hash, secp] = await Promise.all([import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`)]);
const keys = makeKeys({ hash, secp }), S = makeSigner({ hash, secp }), deps = { keys, hash, secp };
let ok = 0, bad = 0;
const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
const throws = (f, re) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const unhex = (h) => hash.hexToBytes(h);

const holder = S.randomKey(), pegger = S.randomKey(); const P = keys.publicKey(holder), refund = keys.xOnly(keys.publicKey(pegger));
const chainA = 'aa'.repeat(32), chainB = 'bb'.repeat(32); const script = '5120' + '11'.repeat(32);
const out = pegOutput(deps, { internal: P, refundKey: refund, refundBlocks: 10000, chainHash: chainA, script });

// ---- BIP 341 exactly
t('the output key is what the engine derives for the internal key and the tree root (BIP 341 tapOutputKey)', out.outputKey === hash.bytesToHex(secp.tapOutputKey(unhex(out.internalKey), unhex(out.root))));
t('the parity in the control blocks is the output key\'s (checkTapTweak)', secp.checkTapTweak(unhex(out.internalKey), unhex(out.root), unhex(out.outputKey), out.outputParity) && !secp.checkTapTweak(unhex(out.internalKey), unhex(out.root), unhex(out.outputKey), 1 - out.outputParity));
t('the script is a v1 witness program of the output key, and the address its bech32m form', out.scriptPubKey === '5120' + out.outputKey && /^tb1p[02-9ac-hj-np-z]{58}$/.test(out.address));
t('the internal key is used as its even-y lift whatever the holder\'s parity (BIP 341)', pegOutput(deps, { internal: keys.negate(P), refundKey: refund, refundBlocks: 10000, chainHash: chainA, script }).outputKey === out.outputKey);

// ---- the leaves
t('the refund leaf is and_v(v:pk(refund), older(n)): <refund> CHECKSIGVERIFY <n> CSV, with n pushed minimally', out.refund.script === '20' + refund + 'ad' + '021027' + 'b2' && refundLeaf(refund, 16).endsWith('60b2') && refundLeaf(refund, 128).endsWith('028000b2') && throws(() => refundLeaf(refund, 0)));
const c = commitLeaf(deps, { chainHash: chainA, script });
t('the commitment leaf is pk(C) with C = NUMS + t·G, t = tagged("sidestr/peg-in", chainHash || sha256(script))', out.commit.script === '20' + c.key + 'ac' && c.key === keys.xOnly(keys.tweakPoint('02' + NUMS_X, keys.taggedScalar(PEG_TAG, chainA, hash.sha256(unhex(script))))) && out.commitment === pegCommitment(deps, { chainHash: chainA, script }));
t('a chain hash that is not 64 hex, or a script that is not hex, is refused in words', throws(() => pegCommitment(deps, { chainHash: 'sidestr:poker', script }), /chain event/) && throws(() => pegCommitment(deps, { chainHash: chainA, script: 'zz' }), /hex/));

// ---- distinct outputs
const outB = pegOutput(deps, { internal: P, refundKey: refund, refundBlocks: 10000, chainHash: chainB, script });
const outS = pegOutput(deps, { internal: P, refundKey: refund, refundBlocks: 10000, chainHash: chainA, script: '5120' + '22'.repeat(32) });
t('two chains give two addresses from the same holder key, refund key and script', outB.address !== out.address && outB.commitKey !== out.commitKey);
t('two destination scripts on one chain give two addresses', outS.address !== out.address);
t('the same reveal gives the same address every time', pegOutput(deps, out.reveal).address === out.address && pegMatches(deps, out.reveal, out.scriptPubKey) && !pegMatches(deps, outB.reveal, out.scriptPubKey));

// ---- control blocks: each leaf's path recomputes the root
const walk = (leaf, control) => { let h = leafHash({ hash }, leaf); const path = control.slice(2 + 64).match(/.{64}/g) ?? []; for (const sib of path) { const [l, r] = h < sib ? [h, sib] : [sib, h]; h = hash.bytesToHex(hash.taggedHash('TapBranch', unhex(l), unhex(r))); } return h; };
t('the refund and commit leaves\' control blocks each carry the path to the root (version 0xc0 | parity, the internal key, the sibling)', out.leaves.every((l) => walk(l.script, l.controlBlock) === out.root) && out.leaves.every((l) => l.controlBlock.length === 2 + 64 + 64 && l.controlBlock.startsWith((0xc0 | out.outputParity).toString(16))));
// level 2: the challenge's multi_a leaf rides as a third leaf, so the holders spend by script as today
const signers = [S.randomKey(), S.randomKey(), S.randomKey()].map((k) => keys.xOnly(keys.publicKey(k))); const multi = leafScript(signers, 2);
const out3 = pegOutput(deps, { internal: '02' + NUMS_X, refundKey: refund, refundBlocks: 10000, chainHash: chainA, script, extraLeaves: [multi] });
t('a three-leaf tree (refund, commit, multi_a) gives every leaf a valid path, and the output is still BIP 341', out3.leaves.length === 3 && out3.leaves.every((l) => walk(l.script, l.controlBlock) === out3.root) && out3.outputKey === hash.bytesToHex(secp.tapOutputKey(unhex(NUMS_X), unhex(out3.root))));
t('tapTree on one leaf is that leaf\'s hash with an empty path', (() => { const tr = tapTree({ hash }, [multi]); return tr.root === leafHash({ hash }, multi) && tr.paths[0].length === 0; })());

// ---- the holders spend by key path: the normalised secret plus the tweak signs for the output
const spend = pegSpendSecret(deps, holder, out); const msg = hash.sha256(unhex(out.outputKey));
t('the key-path secret (normalise(d) + tweak) signs for the output key (BIP 340), for an even- and an odd-y holder', secp.verifySchnorr(msg, S.schnorrSign(msg, spend), unhex(out.outputKey)) && (() => { const odd = keys.publicKey(holder)[1] === '3' ? holder : (keys.N - BigInt('0x' + holder)).toString(16).padStart(64, '0'); /* the other sign: an odd-y point */ const o2 = pegOutput(deps, { internal: keys.publicKey(odd), refundKey: refund, refundBlocks: 10000, chainHash: chainA, script }); const s2 = pegSpendSecret(deps, odd, o2); return secp.verifySchnorr(msg, S.schnorrSign(msg, s2), unhex(o2.outputKey)); })());
t('the descriptor names the internal key, the refund policy and pk(C), for a wallet or a device', out.descriptor === `tr(${out.internalKey},{and_v(v:pk(${refund}),older(10000)),pk(${out.commitKey})})`);

console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
