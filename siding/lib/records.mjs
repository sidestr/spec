// Records (SPEC 12.1): OP_RETURN outputs whose data is UTF-8 text of at most 255 bytes, a single
// push. `issue:`, `tally:` and `pool:` are parsed here; the rules decide what they mean.
const dec = new TextDecoder('utf-8', { fatal: true }), enc = new TextEncoder();
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const MAX_AMOUNT = 2 ** 53 - 1;
// the text of an OP_RETURN output, or null when it is not a single push of <= 255 bytes of UTF-8
export function recordText(spk) {
  const m = /^6a(?:4c([0-9a-f]{2})|([0-9a-f]{2}))([0-9a-f]*)$/i.exec(spk); if (!m) return null;
  const len = parseInt(m[1] ?? m[2], 16); if (m[2] && len > 75) return null; if (m[1] && len <= 75) return null; // minimal push only
  if (m[3].length !== len * 2 || len > 255) return null; // exactly the pushed bytes: nothing after the push, nothing missing
  try { return dec.decode(Uint8Array.from(m[3].match(/../g) ?? [], (x) => parseInt(x, 16))); } catch { return null; }
}
export function recordScript(text) { const b = enc.encode(text); if (b.length > 255) throw new Error('a record is at most 255 bytes'); return '6a' + (b.length <= 75 ? b.length.toString(16).padStart(2, '0') : '4c' + b.length.toString(16).padStart(2, '0')) + toHex(b); }
export const recordsOf = (tx) => tx.outputs.map((o, vout) => ({ vout, text: recordText(o.scriptPubKey) })).filter((r) => r.text !== null);
const amount = (s) => { if (!/^[1-9]\d{0,15}$/.test(s)) return null; const n = Number(s); return n <= MAX_AMOUNT ? n : null; };
export function parseIssue(text) { const m = /^issue:([A-Z0-9]{1,8}):([0-8])$/.exec(text); return m ? { ticker: m[1], decimals: Number(m[2]) } : null; }
// { asset: <64 hex> | 'self', assigns: [{ vout, amount }] }, or null when malformed (a duplicate vout is malformed)
export function parseTally(text) {
  const m = /^tally:([0-9a-f]{64}|self):(.+)$/.exec(text); if (!m) return null; const assigns = [], seen = new Set();
  for (const part of m[2].split(',')) { const p = /^(\d{1,5})=(\d+)$/.exec(part); if (!p) return null; const vout = Number(p[1]), a = amount(p[2]); if (a === null || seen.has(vout)) return null; seen.add(vout); assigns.push({ vout, amount: a }); }
  return { asset: m[1], assigns };
}
export function parsePool(text) { const m = /^pool:([0-9a-f]{64}|self):(\d{1,5})$/.exec(text); return m ? { pool: m[1], vout: Number(m[2]) } : null; }
// every record of a transaction, classified; `bad` lists records that look like ours but do not parse
export function classify(tx) {
  const out = { issues: [], tallies: [], pools: [], bad: [] };
  for (const { vout, text } of recordsOf(tx)) {
    if (text.startsWith('issue:')) { const r = parseIssue(text); r ? out.issues.push({ vout, ...r }) : out.bad.push(text); }
    else if (text.startsWith('tally:')) { const r = parseTally(text); r ? out.tallies.push({ vout, ...r }) : out.bad.push(text); }
    else if (text.startsWith('pool:')) { const r = parsePool(text); r ? out.pools.push({ vout, ...r }) : out.bad.push(text); }
  }
  return out;
}
export const isqrt = (n) => { if (n < 0n) throw new Error('isqrt of a negative'); if (n < 2n) return n; let x = BigInt(Math.floor(Math.sqrt(Number(n)))); while (x * x > n) x--; while ((x + 1n) * (x + 1n) <= n) x++; return x; };
