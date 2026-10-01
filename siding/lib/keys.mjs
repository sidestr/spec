// Keys as group elements, with the x-only form only at the edge. A did:nostr identifier is the
// x-coordinate of a secp256k1 point; a document's Multikey carries the full compressed point
// (02/03 + x); BIP 340 signatures and taproot outputs use the x alone. Everything in between
// (tweaks, chains, derived deposit addresses) is plain arithmetic on full points, which is exact:
//   d + t  <->  P + t·G   for every d, whatever the parity of P or of P + t·G.
// The one rule that makes a bare identifier exact too: a holder normalises the secret once, to
// the secret of the even-y (02) point the identifier denotes; after that nothing is ever lifted
// or negated again, except the sign a BIP 340 signature needs, which stays inside the signing.
// Pure: no Node imports, so a browser can load it as it is. Keys are hex strings: 64 for a
// secret or an x, 66 for a compressed point. Tweaks are 64-hex scalars or bigints, in [1, n-1].
export function makeKeys({ hash, secp }) {
  const { taggedHash, hexToBytes, bytesToHex } = hash; const { publicKeyFromPrivate, ckdPubKey, parsePubkey, liftX, N } = secp;
  const big = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
  const bytes32 = (n) => { const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };
  const hex32 = (n) => bytesToHex(bytes32(n));
  const scalar = (t) => { const n = typeof t === 'bigint' ? t : big(hexToBytes(String(t))); if (n <= 0n || n >= N) throw new Error('a tweak is a scalar in [1, n-1]'); return n; };
  const secret = (d) => { const n = big(hexToBytes(d)); if (n <= 0n || n >= N) throw new Error('a secret is a scalar in [1, n-1]'); return n; };
  const isPoint = (p) => typeof p === 'string' && /^0[23][0-9a-f]{64}$/.test(p) && !!parsePubkey(hexToBytes(p));
  const point = (p) => { if (!isPoint(p)) throw new Error('not a compressed secp256k1 point (02/03 + x, on the curve)'); return p; };

  // ---- the holder's side
  /** the public point of a secret, compressed (02/03 + x) */
  const publicKey = (d) => { const P = publicKeyFromPrivate(bytes32(secret(d))); if (!P) throw new Error('bad secret'); return bytesToHex(P); };
  /** the secret of the even-y point with the same x: d itself when d·G is even, else n − d. Done once, so a bare
   *  identifier (x only, read as 02) names exactly this holder's point; after it, nothing is lifted again */
  const normalize = (d) => (publicKey(d)[1] === '3' ? hex32(N - secret(d)) : d.toLowerCase());
  /** the key a BIP 340 signature of this point's x needs: d, or n − d when the point has odd y. Stays inside signing;
   *  it is never the key the next tweak is added to */
  const signingKey = (d) => (publicKey(d)[1] === '3' ? hex32(N - secret(d)) : d.toLowerCase());

  // ---- reading and writing keys
  /** the full point behind an identifier or encoding: did:nostr:<x> or a bare x (read as the even-y point, 02),
   *  a did:nostr Multikey (fe70102…/fe70103…, which carries the parity), or a compressed point (02/03 + x) */
  function basePoint(id) {
    const s = String(id).trim().toLowerCase();
    const x = /^(?:did:nostr:)?([0-9a-f]{64})$/.exec(s)?.[1]; if (x) { if (!liftX(hexToBytes(x))) throw new Error('that x is not on the curve'); return point('02' + x); }
    const mk = /^fe701(0[23][0-9a-f]{64})$/.exec(s)?.[1]; if (mk) return point(mk);
    if (/^0[23][0-9a-f]{64}$/.test(s)) return point(s);
    throw new Error('not a did:nostr identifier, a did:nostr Multikey, or a compressed point');
  }
  /** the x-only form: a did:nostr identifier, a BIP 340 public key, a taproot output key */
  const xOnly = (P) => point(P).slice(2);
  const did = (P) => 'did:nostr:' + xOnly(P);
  /** the did:nostr Multikey (publicKeyMultibase): f + e701 + the compressed point, parity kept */
  const multikey = (P) => 'fe701' + point(P);
  const negate = (P) => (point(P)[1] === '2' ? '03' : '02') + P.slice(2);

  // ---- arithmetic: exact on full points
  /** d + t mod n */
  const tweakSecret = (d, t) => { const r = (secret(d) + scalar(t)) % N; if (r === 0n) throw new Error('the tweak cancels the secret'); return hex32(r); };
  /** P + t·G, the point of d + t when P is the point of d */
  const tweakPoint = (P, t) => { const Q = ckdPubKey(hexToBytes(point(P)), bytes32(scalar(t))); if (!Q) throw new Error('the tweak lands on infinity'); return bytesToHex(Q); };
  /** a chain: each tweak added to the point before it, kept whole (never lifted) between steps; returns every point */
  const chainPoints = (P, tweaks) => { const out = [point(P)]; for (const t of tweaks) out.push(tweakPoint(out[out.length - 1], t)); return out; };
  const chainSecrets = (d, tweaks) => { const out = [d.toLowerCase()]; secret(d); for (const t of tweaks) out.push(tweakSecret(out[out.length - 1], t)); return out; };

  // ---- tweaks from data
  /** a scalar committed to data, with domain separation: int(taggedHash(tag, ...chunks)) mod n, never 0 */
  const taggedScalar = (tag, ...chunks) => { const n = big(taggedHash(tag, ...chunks.map((c) => (typeof c === 'string' ? hexToBytes(c) : c)))) % N; if (n === 0n) throw new Error('the tweak is zero: refuse this data'); return hex32(n); };
  /** BIP 341's tweak for a point and a 32-byte hash (a merkle root, or any commitment): taggedHash("TapTweak", x || h).
   *  Added to the point as it is (not re-lifted): equal to BIP 341's output key exactly when the point is even-y */
  const tapTweak = (P, h32 = null) => taggedScalar('TapTweak', xOnly(P), ...(h32 ? [h32] : []));

  return { publicKey, normalize, signingKey, basePoint, xOnly, did, multikey, negate, tweakSecret, tweakPoint, chainPoints, chainSecrets, taggedScalar, tapTweak, isPoint, N };
}
