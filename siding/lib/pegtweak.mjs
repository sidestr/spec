// The peg-in tweak form (SPEC 6, issue #23): the peg output commits to its destination in the
// taproot tree instead of an OP_RETURN beside it. The output is BIP 341 exactly, so a parent
// wallet, a descriptor or a hardware wallet reproduces it from the internal key and the tree:
//   internal key   the peg holders' point P (level 1: the signer's key), used as its even-y lift
//   refund leaf    and_v(v:pk(refund), older(refundBlocks)): the pegger's way back if never claimed
//   commit leaf    pk(C), C = NUMS + t·G, t = tagged("sidestr/peg-in", chainHash32 || sha256(script))
//                  an unspendable key that commits to the chain (its hash, SPEC 3) and the sidechain
//                  output script; written as pk() so a wallet policy accepts it
//   output         Q = P + TapTweak(x(P) || root)·G, root the tree of those leaves (and, at level 2,
//                  the challenge's multi_a leaf, so the holders spend by script as they do today)
// Anyone with the reveal (internal key, refund key and blocks, chain hash, script) rebuilds the
// output and checks it against the parent transaction; two chains give two outputs from one key.
// Pure: no Node imports. Keys: 32-hex x-only or 33-hex compressed points; scripts hex; hashes hex.
import { NUMS_X } from './federation.mjs';
import { scriptToAddress } from './address.mjs';
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const compact = (n) => (n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 255, n >> 8] : [0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24]);
// a script number pushed minimally (OP_1..16 for 1..16, else little-endian with a sign byte when needed)
const pushNum = (n) => { if (!Number.isInteger(n) || n < 1 || n > 0x7fffffff) throw new Error('a block count between 1 and 2^31-1'); if (n <= 16) return (0x50 + n).toString(16); const b = []; let v = n; while (v > 0) { b.push(v & 255); v = Math.floor(v / 256); } if (b[b.length - 1] & 0x80) b.push(0); return hex([b.length, ...b]); };
const xOnlyOf = (k) => { const s = String(k).toLowerCase(); if (/^[0-9a-f]{64}$/.test(s)) return s; if (/^0[23][0-9a-f]{64}$/.test(s)) return s.slice(2); throw new Error('a key is an x-only (64 hex) or compressed (66 hex) point'); };

export const PEG_TAG = 'sidestr/peg-in';
export const LEAF_VERSION = 0xc0;
/** the refund leaf: <refund> CHECKSIGVERIFY <refundBlocks> CHECKSEQUENCEVERIFY (miniscript and_v(v:pk(refund), older(n))) */
export const refundLeaf = (refundKey, refundBlocks) => '20' + xOnlyOf(refundKey) + 'ad' + pushNum(refundBlocks) + 'b2';
/** the commitment scalar: tagged("sidestr/peg-in", chainHash32 || sha256(script)); fixed widths, no delimiters */
export function pegCommitment({ keys, hash }, { chainHash, script }) {
  if (!/^[0-9a-f]{64}$/i.test(chainHash)) throw new Error("chainHash is the chain event's id (64 hex, SPEC 3)");
  if (!/^([0-9a-f]{2})+$/i.test(script)) throw new Error('script is hex');
  return keys.taggedScalar(PEG_TAG, chainHash.toLowerCase(), hash.sha256(unhex(script)));
}
/** the commitment key C = NUMS + t·G (unspendable: NUMS has no known secret) and its leaf pk(C): <C> CHECKSIG */
export function commitLeaf({ keys, hash }, { chainHash, script }) {
  const t = pegCommitment({ keys, hash }, { chainHash, script }); const C = keys.tweakPoint('02' + NUMS_X, t);
  return { key: keys.xOnly(C), script: '20' + keys.xOnly(C) + 'ac', tweak: t };
}
export const leafHash = ({ hash }, script) => { const s = unhex(script); return hex(hash.taggedHash('TapLeaf', Uint8Array.of(LEAF_VERSION), Uint8Array.from(compact(s.length)), s)); };
// the tree: leaves paired left to right, each branch the tagged hash of its children in lexical order
// (BIP 341); every leaf gets its path of sibling hashes, which is what its control block carries
export function tapTree({ hash }, leafScripts) {
  if (!leafScripts.length) throw new Error('a tree needs a leaf');
  let level = leafScripts.map((script, i) => ({ hash: leafHash({ hash }, script), leaves: [{ i, path: [] }] }));
  while (level.length > 1) {
    const next = [];
    for (let j = 0; j < level.length; j += 2) {
      if (j + 1 >= level.length) { next.push(level[j]); continue; }
      const a = level[j], b = level[j + 1]; const [l, r] = a.hash < b.hash ? [a, b] : [b, a];
      for (const x of a.leaves) x.path.push(b.hash); for (const x of b.leaves) x.path.push(a.hash);
      next.push({ hash: hex(hash.taggedHash('TapBranch', unhex(l.hash), unhex(r.hash))), leaves: [...a.leaves, ...b.leaves] });
    }
    level = next;
  }
  const paths = []; for (const x of level[0].leaves) paths[x.i] = x.path;
  return { root: level[0].hash, paths };
}
/** everything the peg output is: from the reveal, so the pegger, the holders and a verifier all compute the same */
export function pegOutput({ keys, hash, secp }, { internal, refundKey, refundBlocks, chainHash, script, extraLeaves = [], hrp = 'tb' }) {
  const P = '02' + xOnlyOf(internal); // BIP 341 lifts the internal key; the holders' secret is normalised to it (keys.normalize)
  const refund = refundLeaf(refundKey, refundBlocks), commit = commitLeaf({ keys, hash }, { chainHash, script });
  const leafScripts = [refund, commit.script, ...extraLeaves]; const tree = tapTree({ hash }, leafScripts);
  const t = keys.tapTweak(P, tree.root); const Q = keys.tweakPoint(P, t); const outputKey = keys.xOnly(Q);
  const parity = Q[1] === '3' ? 1 : 0; const control = (i) => (LEAF_VERSION | parity).toString(16).padStart(2, '0') + xOnlyOf(internal) + tree.paths[i].join('');
  const leaves = leafScripts.map((s, i) => ({ script: s, hash: leafHash({ hash }, s), controlBlock: control(i) }));
  const scriptPubKey = '5120' + outputKey;
  const descriptor = `tr(${xOnlyOf(internal)},{and_v(v:pk(${xOnlyOf(refundKey)}),older(${refundBlocks})),pk(${commit.key})${extraLeaves.length ? ',…' : ''}})`;
  return { internalKey: xOnlyOf(internal), outputKey, outputParity: parity, scriptPubKey, address: scriptToAddress(scriptPubKey, hrp), root: tree.root, tweak: t, commitKey: commit.key, commitment: commit.tweak, leaves, refund: leaves[0], commit: leaves[1], descriptor, reveal: { internal: xOnlyOf(internal), refundKey: xOnlyOf(refundKey), refundBlocks, chainHash: chainHash.toLowerCase(), script: script.toLowerCase(), extraLeaves } };
}
/** does an output script pay the peg this reveal describes? (a verifier with the claim's reveal and the parent transaction) */
export const pegMatches = (deps, reveal, scriptPubKey, hrp) => pegOutput(deps, { ...reveal, hrp }).scriptPubKey === String(scriptPubKey).toLowerCase();
/** the key-path spending secret for the holders: the normalised secret plus the output tweak (BIP 340 sign applied inside signing) */
export const pegSpendSecret = ({ keys }, secret, out) => keys.tweakSecret(keys.normalize(secret), out.tweak);
