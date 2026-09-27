// The parent chain as a signer sees it (SPEC 6, level 2 view): a Bitcoin-style RPC with txindex.
// Finds peg-ins for this chain, tells whether one is still unspent and how deep it is.
// Node only: reads the RPC cookie from a file. Keys never appear on a command line.
import { readFile } from 'node:fs/promises';
import { parsePegMarker } from './marker.mjs';
const enc = new TextEncoder(), dec = new TextDecoder();
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export async function makeParent({ url, cookieFile, wallet = null }) {
  // the cookie is minted anew every time the node starts: read it again on a 401 rather than dying with it (a
  // node upgrade on 21 Sep left every producer sending a stale cookie until restarted)
  const readAuth = async () => 'Basic ' + Buffer.from((await readFile(cookieFile, 'utf8')).trim()).toString('base64');
  let auth = await readAuth();
  const rpc = async (method, params = [], endpoint = url, retried = false) => {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: auth }, body: JSON.stringify({ jsonrpc: '1.0', id: 'siding', method, params }) });
    if (r.status === 401 && !retried) { auth = await readAuth(); return rpc(method, params, endpoint, true); }
    if (r.status === 401) throw new Error(`${method}: the node refused the cookie at ${cookieFile}`);
    const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
  };
  // the peg wallet's RPCs go to /wallet/<name>; without a wallet name the parent is read-only
  const walletRpc = wallet ? (method, params = []) => rpc(method, params, `${url.replace(/\/$/, '')}/wallet/${encodeURIComponent(wallet)}`) : null;
  return { rpc, walletRpc, wallet, height: () => rpc('getblockcount') };
}

// The marker: `pegin:<chain id>:` then the sidechain output script, as raw bytes (61 bytes for a
// taproot script, inside the 80-byte OP_RETURN policy limit) or, as the spec's text shows it, hex.
export { pegMarkerData, parsePegMarker } from './marker.mjs'; // pure, so a browser can build a pledge without this file's Node imports

// Peg-ins in the parent's blocks [from, to]: a transaction with our marker; its peg output is the
// taproot output the peg wallet owns (SPEC 6). A wallet's change may sit before the peg, so the
// first taproot output is taken only when no peg wallet is given to ask. Amounts in sats.
// A parent transaction handed to us over a relay (SPEC 11, kind 23503): broadcast it only if the node's own mempool
// policy accepts it as it stands — testmempoolaccept, no options, no overrides — and never retry a refusal. The node is
// the judge, not the producer; a refusal is logged with the node's reason so it can be read later.
export async function relayParentTx(parent, hex, { seen = new Set(), maxBytes = 100000 } = {}) {
  hex = String(hex ?? '').trim().toLowerCase(); if (!/^([0-9a-f]{2})+$/.test(hex) || hex.length / 2 > maxBytes) return { ok: false, reason: 'not a transaction hex' };
  let txid; try { txid = (await parent.rpc('decoderawtransaction', [hex])).txid; } catch (e) { return { ok: false, reason: `not a transaction: ${e.message}` }; }
  if (seen.has(txid)) return { ok: false, txid, reason: 'seen already', duplicate: true }; seen.add(txid);
  const [t] = await parent.rpc('testmempoolaccept', [[hex]]); if (!t.allowed) return { ok: false, txid, reason: `${t['reject-reason'] ?? 'refused'}${t['reject-details'] ? ': ' + t['reject-details'] : ''}` };
  await parent.rpc('sendrawtransaction', [hex]); return { ok: true, txid, vsize: t.vsize ?? null, fee: t.fees?.base ?? null };
}
// does the peg wallet own this parent address (its own keys, or the imported k-of-n descriptor), and is it the wallet's own change
async function pegWalletView(parent, address) { try { const i = await parent.walletRpc('getaddressinfo', [address]); return { owned: !!(i.ismine || i.iswatchonly || i.solvable), change: !!i.ischange }; } catch { return { owned: false, change: false }; } }
// did the peg wallet itself pay for this transaction (issue 15: the peg holders paying themselves is not a deposit)
async function fundedByPegWallet(parent, txid) { try { const t = await parent.walletRpc('gettransaction', [txid]); return (t.details ?? []).some((d) => d.category === 'send'); } catch { return false; } }
// which of the scanned peg-ins are new: one claim per marker transaction, whatever a re-scan finds (issue 15).
// `known` are the peg-ins already recorded, `claimedTx(txid)` says whether the chain has claimed any output of it.
export function newPegins(found, known, claimedTx = () => false) {
  const out = []; const seen = new Set(known.map((q) => q.txid));
  for (const p of found) { if (seen.has(p.txid) || claimedTx(p.txid)) continue; seen.add(p.txid); out.push(p); }
  return out;
}
// pegScript: the script the signer announces as the peg (SPEC 6); an output paying it is the peg wherever it sits.
// Without a match, with a peg wallet: the first taproot output the wallet owns that is not its own change, and only
// in a transaction the wallet did not fund. Without a wallet: the first taproot output.
export async function scanPegins(parent, { chainId, from, to, pegScript = null, onBlock = () => {}, onCoinbase = null }) {
  const found = [];
  for (let h = from; h <= to; h++) {
    const block = await parent.rpc('getblock', [await parent.rpc('getblockhash', [h]), 2]); onBlock(h);
    // the desk (SPEC 6.2) wants every taproot coinbase output: what a miner could pledge
    if (onCoinbase && block.tx[0]?.vin?.[0]?.coinbase !== undefined) for (const o of block.tx[0].vout) if (o.scriptPubKey.type === 'witness_v1_taproot') onCoinbase({ txid: block.tx[0].txid, vout: o.n, value: Math.round(o.value * 1e8), script: o.scriptPubKey.hex, height: h });
    for (const tx of block.tx) {
      let script = null; for (const o of tx.vout) { const s = parsePegMarker(o.scriptPubKey.hex, chainId); if (s) { script = s; break; } }
      if (!script) continue;
      const taproots = tx.vout.filter((o) => o.scriptPubKey.type === 'witness_v1_taproot'); let peg = pegScript ? taproots.find((o) => o.scriptPubKey.hex?.toLowerCase() === pegScript.toLowerCase()) ?? null : null;
      if (!peg && parent.walletRpc) { if (!(await fundedByPegWallet(parent, tx.txid))) for (const o of taproots) { if (!o.scriptPubKey.address) continue; const v = await pegWalletView(parent, o.scriptPubKey.address); if (v.owned && !v.change) { peg = o; break; } } } else if (!peg && !parent.walletRpc) peg = taproots[0] ?? null;
      if (!peg) continue; // a marker beside nothing the peg wallet owns is not a peg-in
      found.push({ txid: tx.txid, vout: peg.n, amount: Math.round(peg.value * 1e8), script, height: h, parentAddress: peg.scriptPubKey.address ?? null });
    }
  }
  return found;
}

// still unspent on the parent, and how many confirmations it has (null if spent or unknown)
export async function pegStatus(parent, { txid, vout }) {
  const o = await parent.rpc('gettxout', [txid, vout, true]); if (!o) return { unspent: false, confirmations: null };
  return { unspent: true, confirmations: o.confirmations };
}

// A peg-in that is not yet claimed must not be spent by the peg wallet's own payments (a peg-out,
// a checkpoint) — a spent peg-in is refused as a claim. The node keeps locks in memory, so the
// producer re-locks on every scan; a claimed output is unlocked and joins the reserve.
export async function lockOutputs(parent, outpoints, lock = true) {
  if (!parent.walletRpc || !outpoints.length) return 0; let n = 0;
  for (const o of outpoints) { try { await parent.walletRpc('lockunspent', [!lock, [{ txid: o.txid, vout: o.vout }]]); n++; } catch {} }
  return n;
}

// --- peg-outs (SPEC 7): the parent side ---------------------------------------------------
// The parent payment carries `pegout:<chain id>:` then the sidechain txid as raw bytes (61 bytes
// for this chain), so the record fits an OP_RETURN and a validator with a parent view can pair
// each burn with its payment.
export function pegoutMarkerData(chainId, sideTxid) { const head = enc.encode(`pegout:${chainId}:`); const out = new Uint8Array(head.length + 32); out.set(head); out.set(fromHex(sideTxid), head.length); return out; }
export function parsePegoutMarker(spkHex, chainId) {
  const m = /^6a(?:4c)?([0-9a-f]{2})([0-9a-f]*)$/i.exec(spkHex); if (!m) return null; const b = fromHex(m[2]); if (parseInt(m[1], 16) !== b.length) return null;
  const head = enc.encode(`pegout:${chainId}:`); if (b.length !== head.length + 32) return null; for (let i = 0; i < head.length; i++) if (b[i] !== head[i]) return null;
  return toHex(b.subarray(head.length));
}
// pay one burn from the peg wallet: the parent script gets the burned value, the marker rides along
export async function payPegout(parent, { chainId, txid, script, value }) {
  if (!parent.walletRpc) throw new Error('no peg wallet: start with --parent-wallet <name>');
  const { address } = await parent.rpc('decodescript', [script]); if (!address) throw new Error(`script ${script.slice(0, 16)}… has no address on the parent`);
  const btc = (value / 1e8).toFixed(8); const data = toHex(pegoutMarkerData(chainId, txid));
  const r = await parent.walletRpc('send', [[{ [address]: btc }, { data }], null, 'unset', 1]);
  if (!r?.complete || !r.txid) throw new Error(`send did not complete: ${JSON.stringify(r).slice(0, 200)}`);
  return { parentTxid: r.txid, address, value };
}
// every burn the peg wallet has already paid, from the wallet's own history: sidechain txid -> parent txid
export async function paidPegouts(parent, { chainId }) {
  const paid = new Map(); if (!parent.walletRpc) return paid;
  const seen = new Set(); const list = await parent.walletRpc('listtransactions', ['*', 10000, 0, true]);
  for (const t of list) { if (t.category !== 'send' || seen.has(t.txid)) continue; seen.add(t.txid);
    const g = await parent.walletRpc('gettransaction', [t.txid, true, true]);
    for (const o of g.decoded?.vout ?? []) { const side = parsePegoutMarker(o.scriptPubKey?.hex ?? '', chainId); if (side) paid.set(side, t.txid); } }
  return paid;
}
