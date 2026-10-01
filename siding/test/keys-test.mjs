// lib/keys.mjs: keys as group elements, x-only only at the edge. The official BIP 340 and BIP 341 vectors pin the
// edge; property tests over random keys of both parities pin the arithmetic (d + t <-> P + t·G, chains, the
// normalise-once rule); keys-vectors.json pins known answers so another implementation can check the same numbers.
//   node test/keys-test.mjs            (SCHEMA=<bitcoin-desktop/schema checkout>; default under ~)
//   node test/keys-test.mjs --regen    rewrites test/keys-vectors.json from the library (then diff it)
import fs from 'node:fs'; import os from 'node:os';
import { makeKeys } from '../lib/keys.mjs'; import { makeSigner } from '../lib/schnorr.mjs';
const SCHEMA = process.env.SCHEMA ?? os.homedir() + '/bitcoin-desktop/schema';
const [hash, secp] = await Promise.all([import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`)]);
const K = makeKeys({ hash, secp }); const S = makeSigner({ hash, secp });
let ok = 0, bad = 0;
const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
const throws = (f, re) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const big = (h) => BigInt('0x' + h), hex = (n) => n.toString(16).padStart(64, '0');
const rnd = () => S.randomKey();
const vec = (f) => JSON.parse(fs.readFileSync(`${SCHEMA}/test/vectors/${f}`, 'utf8'));

// ---- the edge: official vectors
{
  const v = vec('bip341.json').scriptPubKey; let n = 0;
  for (const e of v) { const Q = K.tweakPoint('02' + e.given.internalPubkey, K.tapTweak('02' + e.given.internalPubkey, e.intermediary.merkleRoot)); if (K.xOnly(Q) === e.intermediary.tweakedPubkey) n++; }
  t(`BIP 341: our tweak on the even-y (02) internal key gives the official output key, all ${v.length} vectors`, n === v.length, `${n}`);
  let m = 0; for (const e of v) { const Q = K.tweakPoint('03' + e.given.internalPubkey, K.tapTweak('03' + e.given.internalPubkey, e.intermediary.merkleRoot)); if (K.xOnly(Q) !== e.intermediary.tweakedPubkey) m++; }
  t('BIP 341: on the odd-y (03) point of the same x it differs every time (BIP 341 lifts; we add to the point as it is)', m === v.length, `${m}`);
}
{
  const v = vec('bip340.json').vectors.filter((e) => e.valid); let n = 0;
  for (const e of v) if (secp.verifySchnorr(hash.hexToBytes(e.message), hash.hexToBytes(e.signature), hash.hexToBytes(e.pubkey))) n++;
  t(`BIP 340: the engine verifies all ${v.length} valid official vectors (the x-only edge our signatures must meet)`, n === v.length);
  // signing with the signing key verifies against the x of the point, for both parities
  let s = 0, odd = 0; for (let i = 0; i < 40; i++) { const d = rnd(), P = K.publicKey(d); if (P[1] === '3') odd++; const msg = hash.sha256(hash.hexToBytes(d)); if (secp.verifySchnorr(msg, S.schnorrSign(msg, d), hash.hexToBytes(K.xOnly(P)))) s++; }
  t(`BIP 340: a signature by a secret verifies against its point's x for both parities (40 keys, ${odd} odd-y)`, s === 40 && odd > 5 && odd < 35);
}

// ---- the arithmetic: exact on full points, whatever the parity
{
  let same = 0, oddBase = 0, oddOut = 0; const M = 500;
  for (let i = 0; i < M; i++) { const d = rnd(), tw = rnd(); const P = K.publicKey(d); if (P[1] === '3') oddBase++; const Q = K.tweakPoint(P, tw); if (Q[1] === '3') oddOut++; if (Q === K.publicKey(K.tweakSecret(d, tw))) same++; }
  t(`d + t <-> P + t·G for ${M} random keys and tweaks (${oddBase} odd-y bases, ${oddOut} odd-y results): exact every time`, same === M, `${same}`);
  let chains = 0; for (let i = 0; i < 100; i++) { const d = rnd(), tws = [rnd(), rnd(), rnd(), rnd(), rnd()]; const ps = K.chainPoints(K.publicKey(d), tws), ds = K.chainSecrets(d, tws); if (ps.every((P, j) => P === K.publicKey(ds[j]))) chains++; }
  t('chains of 5 tweaks: every point along the chain is the point of the secret along the chain (100 chains)', chains === 100);
  const d = rnd(); const small = ['01', '02', '03'].map((x) => x.padStart(64, '0'));
  t('+1, +2, +3 on the secret are +G, +2G, +3G on the point, in that order', K.chainSecrets(d, small).every((s, j) => K.publicKey(s) === K.chainPoints(K.publicKey(d), small)[j]));
  t('x(P) == x(−P): negation keeps the identifier and flips the parity', K.xOnly(K.negate(K.publicKey(d))) === K.xOnly(K.publicKey(d)) && K.negate(K.publicKey(d))[1] !== K.publicKey(d)[1]);
}

// ---- normalise once: a bare identifier (x, read as 02) is exactly the holder's point
{
  let exact = 0, flipped = 0; const M = 300;
  for (let i = 0; i < M; i++) { const d = rnd(); const n = K.normalize(d); if (n !== d) flipped++; const P = K.publicKey(n); if (P[1] === '2' && K.basePoint(K.did(P)) === P && K.xOnly(P) === K.xOnly(K.publicKey(d))) exact++; }
  t(`normalize(d) gives the even-y point with the same x, so basePoint(did) is the holder's point (${M} keys, ${flipped} negated)`, exact === M && flipped > 100 && flipped < 200);
  const d = K.normalize(rnd()); const tws = []; let fromDid, fromSecret;
  do { tws.push(rnd()); fromDid = K.chainPoints(K.basePoint(K.did(K.publicKey(d))), tws); fromSecret = K.chainSecrets(d, tws).map(K.publicKey); } while (!fromDid.some((P) => P[1] === '3') && tws.length < 64); // until the chain passes through an odd-y point
  t(`after normalising once, a chain from the bare identifier equals the chain from the secret, through ${fromDid.filter((P) => P[1] === '3').length} odd-y points, with no further lifting`, fromDid.every((P, j) => P === fromSecret[j]) && fromDid.some((P) => P[1] === '3'));
  const raw = rnd(); const odd = K.publicKey(raw)[1] === '3' ? raw : hex(K.N - big(raw));
  t('an un-normalised odd-y secret does NOT match the bare identifier: its tweaks land on other points (the bug the rule prevents)', K.tweakPoint(K.basePoint(K.did(K.publicKey(odd))), tws[0]) !== K.publicKey(K.tweakSecret(odd, tws[0])));
  t('signingKey is the normalised secret: the key a BIP 340 signature of the x needs, and it never changes the chain', K.signingKey(odd) === K.normalize(odd) && K.signingKey(K.normalize(odd)) === K.normalize(odd));
}

// ---- reading keys: identifier, Multikey, compressed point
{
  const d = rnd(), P = K.publicKey(d), x = K.xOnly(P);
  t('basePoint reads did:nostr:<x> and a bare x as the 02 point', K.basePoint('did:nostr:' + x) === '02' + x && K.basePoint(x.toUpperCase()) === '02' + x);
  t('basePoint reads a did:nostr Multikey with its parity kept (02 and 03)', K.basePoint('fe70102' + x) === '02' + x && K.basePoint('fe70103' + x) === '03' + x);
  t('basePoint reads a compressed point as it is, and multikey()/did() write them back', K.basePoint(P) === P && K.multikey(P) === 'fe701' + P && K.did(P) === 'did:nostr:' + x);
  t('the spec example: did:nostr:124c0f…fdd2 is the Multikey fe70102124c0f…fdd2', K.multikey(K.basePoint('did:nostr:124c0fa99407182ece5a24fad9b7f6674902fc422843d3128d38a0afbee0fdd2')) === 'fe70102124c0fa99407182ece5a24fad9b7f6674902fc422843d3128d38a0afbee0fdd2');
  t('an x off the curve, a bad prefix, a short key and other text are refused in words', throws(() => K.basePoint('00'.repeat(32)), /curve/) && throws(() => K.basePoint('04' + x), /not a/) && throws(() => K.basePoint(x.slice(2)), /not a/) && throws(() => K.basePoint('npub1abc'), /not a/));
}

// ---- tweaks and their limits
{
  const d = rnd(), P = K.publicKey(d);
  t('a tweak of 0 or ≥ n is refused; so is a secret of 0', throws(() => K.tweakPoint(P, 0n), /\[1, n-1\]/) && throws(() => K.tweakPoint(P, K.N), /\[1, n-1\]/) && throws(() => K.publicKey('00'.repeat(32)), /\[1, n-1\]/));
  t('a tweak that cancels the secret is refused (d + (n − d) = 0)', throws(() => K.tweakSecret(d, hex(K.N - big(d))), /cancels/));
  const s1 = K.taggedScalar('test/keys', hash.hexToBytes('abcd')), s2 = K.taggedScalar('test/keys', 'abcd'), s3 = K.taggedScalar('other', 'abcd');
  t('taggedScalar: bytes or hex chunks give the same scalar; another tag gives another', s1 === s2 && s1 !== s3 && big(s1) < K.N);
  // BIP 86: the official addresses from their child xpubs. BIP 86 lifts the child key to x-only, so the internal point
  // is the 02 point of its x whatever the child's own parity; the output is that point plus TapTweak(x) with no hash
  const { base58checkDecode } = await import(`${SCHEMA}/codec/script.js`); const { scriptToAddress } = await import('../lib/address.mjs');
  const v86 = vec('bip86.json').addresses; let n86 = 0, odd86 = 0;
  for (const e of v86) { const key = hash.bytesToHex(base58checkDecode(e.xpub).payload.slice(-33)); if (key[1] === '3') odd86++; const P = '02' + key.slice(2); if (scriptToAddress('5120' + K.xOnly(K.tweakPoint(P, K.tapTweak(P))), 'bc') === e.address) n86++; }
  t(`BIP 86: tapTweak with no hash on the lifted (02) child key gives the official addresses, all ${v86.length} (${odd86} children odd-y, lifted as BIP 86 says)`, n86 === v86.length, `${n86}`);
}

// ---- known answers: keys-vectors.json (regenerate with --regen, then review the diff)
{
  const file = new URL('./keys-vectors.json', import.meta.url);
  const d = '11'.repeat(32), oddD = (() => { let x = 1n; while (K.publicKey(hex(x))[1] !== '3') x++; return hex(x); })();
  const tws = ['01'.padStart(64, '0'), '02'.padStart(64, '0'), K.taggedScalar('keys-vectors', 'cafe')];
  const make = (secretHex) => { const P = K.publicKey(secretHex), n = K.normalize(secretHex); return { secret: secretHex, point: P, did: K.did(P), multikey: K.multikey(P), normalized: n, normalizedPoint: K.publicKey(n), tweaks: tws, chainFromSecret: K.chainSecrets(n, tws).slice(1), chainPoints: K.chainPoints(K.basePoint(K.did(P)), tws).slice(1), outputs: K.chainPoints(K.basePoint(K.did(P)), tws).slice(1).map(K.xOnly), signingKeys: K.chainSecrets(n, tws).slice(1).map(K.signingKey) }; };
  const generated = { description: 'keys.mjs known answers: a did:nostr identifier read as the 02 point, the secret normalised once, then plain additive tweaks (+1, +2, a tagged scalar) with every intermediate point kept whole; outputs are the x-only forms; signingKeys the key a BIP 340 signature of each output needs', cases: { evenSecret: make(d), oddSecret: make(oddD) } };
  if (process.argv.includes('--regen')) { fs.writeFileSync(file, JSON.stringify(generated, null, 2) + '\n'); console.log('  wrote keys-vectors.json'); }
  const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  t('keys-vectors.json matches what the library computes today', !!stored && JSON.stringify(stored) === JSON.stringify(generated), stored ? 'differs: review `node test/keys-test.mjs --regen`' : 'missing: run with --regen');
  t('the odd-secret case really is odd, and its normalised secret is n − d', generated.cases.oddSecret.point[1] === '3' && big(generated.cases.oddSecret.normalized) === K.N - big(oddD));
  let s = 0; for (const c of Object.values(generated.cases)) for (let j = 0; j < 3; j++) { const msg = hash.sha256(hash.hexToBytes(c.outputs[j])); if (secp.verifySchnorr(msg, S.schnorrSign(msg, c.chainFromSecret[j]), hash.hexToBytes(c.outputs[j]))) s++; }
  t('each chained secret signs for its output (a BIP 340 signature by it verifies against the x-only output)', s === 6);
}

console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
