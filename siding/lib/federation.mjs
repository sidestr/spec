// Level 2 (proposals/level-2.md): a chain with n signers and a threshold k. The challenge is a
// taproot output whose internal key is provably unspendable (the BIP 341 NUMS point tweaked by
// the chain id) and whose single leaf is multi_a(k, pk_1 … pk_n). A block's solution is the
// script-path witness: n signature slots in leaf order (empty for a signer who did not sign),
// the leaf script, the control block. Pure: browsers and Node alike.
import { blockSigHash, sealBlock } from './block.mjs';
export const NUMS_X = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'; // BIP 341's H
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const compact = (n) => n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 255, n >> 8] : [0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];

// the internal key: H + int(tagged("sidestr/nums", chain id))·G, so it is unspendable and per chain
export function numsKey({ hash, secp }, chainId) {
  const t = hash.taggedHash('sidestr/nums', new TextEncoder().encode(chainId));
  const K = secp.ckdPubKey(unhex('02' + NUMS_X), t); if (!K) throw new Error('nums derivation failed');
  return hex(K.slice(1));
}
// the leaf: <pk_1> CHECKSIG <pk_2> CHECKSIGADD … <pk_n> CHECKSIGADD <k> NUMEQUAL
export function leafScript(signers, threshold) {
  if (!Array.isArray(signers) || signers.length < 1 || signers.length > 16) throw new Error('1 to 16 signers'); if (!(threshold >= 1 && threshold <= signers.length)) throw new Error('threshold between 1 and the number of signers');
  for (const s of signers) if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`signer ${s} is not an x-only key`);
  // a key listed twice fills two slots with one signature: multi_a counts slots, not keys, so a
  // 2-of-3 whose signers are [A, A, B] is sealed by A alone. Signers are distinct keys.
  if (new Set(signers).size !== signers.length) throw new Error('signers must be distinct keys');
  return signers.map((pk, i) => '20' + pk + (i === 0 ? 'ac' : 'ba')).join('') + (0x50 + threshold).toString(16) + '9c';
}
export function leafHashOf({ hash }, script) { const s = unhex(script); return hash.taggedHash('TapLeaf', Uint8Array.of(0xc0), Uint8Array.from(compact(s.length)), s); }
// everything a document with `signers` and `threshold` implies
export function federation({ hash, secp }, chain) {
  const signers = chain.signers.map((s) => String(s).toLowerCase()), threshold = Number(chain.threshold);
  const script = leafScript(signers, threshold); const leaf = leafHashOf({ hash }, script); const internal = numsKey({ hash, secp }, chain.id);
  const out = secp.tapOutputKey(unhex(internal), leaf); if (!out) throw new Error('tap tweak failed');
  const outputKey = hex(out); const parity = secp.liftX ? (() => { const Q = secp.liftX(out); return 0; })() : 0;
  // the control block's parity bit is that of the output key's Y; tapOutputKey gives only x, so both are tried by the validator-side checker here
  const challenge = '5120' + outputKey;
  const control = (p) => (0xc0 | p).toString(16).padStart(2, '0') + internal;
  const parityBit = secp.checkTapTweak(unhex(internal), leaf, out, 0) ? 0 : 1;
  return { signers, threshold, script, leafHash: hex(leaf), internalKey: internal, outputKey, challenge, controlBlock: control(parityBit) };
}
// one signer's partial signature over a block, as hex (64 bytes: SIGHASH_DEFAULT)
export function partialSignature({ k, hash, interpreter, schnorrSign }, block, fed, privHex) {
  const msg = blockSigHash({ k, hash, interpreter }, block, fed.challenge, unhex(fed.leafHash));
  return hex(schnorrSign(msg, privHex));
}
export function verifyPartial({ k, hash, interpreter, secp }, block, fed, pubkey, sigHex) {
  const msg = blockSigHash({ k, hash, interpreter }, block, fed.challenge, unhex(fed.leafHash));
  try { return secp.verifySchnorr(msg, unhex(sigHex), unhex(pubkey)) === true; } catch { return false; }
}
// the witness from a map pubkey -> signature: slots in reverse leaf order (pk_1's on top), then the script, then the control block
export function assembleWitness(fed, sigs) {
  const have = fed.signers.filter((pk) => sigs.has(pk)); if (have.length < fed.threshold) throw new Error(`${have.length} of ${fed.threshold} signatures`);
  const chosen = new Set(have.slice(0, fed.threshold)); // exactly k: extra signatures would make NUMEQUAL fail
  const slots = fed.signers.map((pk) => chosen.has(pk) ? sigs.get(pk) : '').reverse();
  return [...slots, fed.script, fed.controlBlock];
}
// a block sealed with k of n signatures
export function sealFederated(engine, block, fed, sigs) { return sealBlock(engine, block, assembleWitness(fed, sigs)); }

// --- the peg wallet (step 6): the same k-of-n on the parent ------------------------------
// The parent's peg output is the chain's challenge, literally: tr(<internal>, multi_a(k, …)) in a
// node's descriptor language derives the same address. Each signer imports it with its own key
// private (WIF), the others' public, so it can sign a PSBT that spends the peg.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function wif({ hash }, privHex, { testnet = true } = {}) {
  const p = new Uint8Array(34); p[0] = testnet ? 0xef : 0x80; p.set(unhex(privHex), 1); p[33] = 1; const c = hash.sha256(hash.sha256(p)); const all = new Uint8Array(38); all.set(p); all.set(c.subarray(0, 4), 34);
  let n = BigInt('0x' + hex(all)), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s;
}
export function pegDescriptor(fed, { wifFor = null } = {}) {
  const keys = fed.signers.map((pk) => (wifFor && wifFor(pk)) || pk);
  return `tr(${fed.internalKey},multi_a(${fed.threshold},${keys.join(',')}))`;
}
