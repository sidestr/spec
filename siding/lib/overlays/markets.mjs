// The `markets` rule (proposals/markets.md): a market is a question with two outcomes, YES and NO, minted in
// pairs against sats held in a market coin, settled by a named resolver whose answer is a transaction it signed,
// refunded at half par after expiry plus grace if it never answers. State: markets, derived from the chain on open.
import { classify } from '../records.mjs';
export const RULE = 'sidestr:rule-markets', MARKET_SCRIPT = '51';
const key = (txid, vout) => `${txid}:${vout}`; const enc = new TextEncoder();
// the NO asset of a market: sha256 of "no:" and the market id as text, as 64 hex (the YES asset is the market id itself)
export const noIdOf = (hash, id) => hash.bytesToHex(hash.sha256(enc.encode('no:' + id)));

export function marketsOverlay(chain, { assets, hash, markets = new Map(), from = 0 }) {
  // markets: id -> { coin, C, resolver, expiry, grace, question, status: open|resolved|refunding, winner, opened }
  const byOutpoint = new Map(); // market coin outpoint -> market id
  const journal = new Map();   // height -> [{ id, before }] to undo a re-validated height
  const noId = (id) => noIdOf(hash, id);
  // check one transaction; `view` is the assets CarryView holding this transaction's outputs; `scriptOf(prevout)` gives
  // the script an input spends (for the resolver's signature); `height` is the block's, or the next height for the mempool
  function check(tx, txid, view, { coinbase = false, height = 0, scriptOf = () => null } = {}) {
    const cls = classify(tx); const bad = (error) => ({ ok: false, error });
    if (coinbase) return cls.markets.length || cls.questions.length ? bad('the coinbase carries no records') : { ok: true };
    const spent = tx.inputs.map((i) => byOutpoint.get(key(i.prevout.txid, i.prevout.vout))).filter(Boolean);
    if (spent.length > 1) return bad('a transaction spends at most one market coin');
    if (cls.markets.length > 1) return bad('a transaction carries at most one market record');
    if (!spent.length && !cls.markets.length) return cls.questions.length ? bad('question: belongs to the transaction that opens a market') : { ok: true };
    const rec = cls.markets[0];
    const inOf = (asset) => { let s = 0; for (const i of tx.inputs) { const c = view.before(key(i.prevout.txid, i.prevout.vout)); if (c?.has(asset)) s += c.get(asset); } return s; };
    const outOf = (asset) => { let s = 0; tx.outputs.forEach((_, v) => { const m = view.get(key(txid, v)); if (m?.has(asset)) s += m.get(asset); }); return s; };
    const coinAt = (vout) => { const o = tx.outputs[vout]; if (!o || o.scriptPubKey !== MARKET_SCRIPT || !(o.value >= 1)) return null; if (view.get(key(txid, vout))) return null; return o; };
    if (rec.kind === 'open') {
      if (spent.length) return bad('a transaction opens a market or spends one, not both');
      const o = coinAt(rec.vout); if (!o) return bad('the market coin is an OP_TRUE output with value and no asset');
      if (cls.questions.length !== 1) return bad('a market has exactly one question:');
      if (!(rec.expiry > height)) return bad('expiry is a future height'); if (!(rec.grace >= 1)) return bad('grace is at least one block');
      if (cls.issues.length || cls.pools.some((p) => p.pool === 'self')) return bad('a transaction that opens a market issues nothing and opens no pool');
      return { ok: true, kind: 'open', effect: { id: txid, coin: key(txid, rec.vout), C: o.value, resolver: rec.resolver, expiry: rec.expiry, grace: rec.grace, question: cls.questions[0].text, status: 'open', winner: null, opened: height } };
    }
    if (!spent.length) return bad(`${rec.kind}: names a market this transaction does not spend`);
    const id = spent[0], m = markets.get(id); if (rec.market !== id) return bad(`${rec.kind}: names a market other than the coin spent`);
    if (cls.questions.length) return bad('question: belongs to the transaction that opens a market');
    const yes = id, no = noId(id);
    if (rec.kind === 'resolve') {
      if (m.status !== 'open') return bad('resolve: the market is not open'); if (!(height <= m.expiry + m.grace)) return bad('resolve: the grace period has passed');
      if (!tx.inputs.some((i) => scriptOf(i.prevout) === '5120' + m.resolver)) return bad('resolve: no input spends a coin of the resolver');
      const coins = tx.outputs.map((o, v) => [o, v]).filter(([o]) => o.scriptPubKey === MARKET_SCRIPT); if (coins.length !== 1 || coins[0][0].value !== m.C || view.get(key(txid, coins[0][1]))) return bad('resolve: recreates the market coin unchanged');
      return { ok: true, kind: 'resolve', effect: { ...m, coin: key(txid, coins[0][1]), status: 'resolved', winner: rec.outcome } };
    }
    const o = coinAt(rec.vout); if (!o) return bad(`${rec.kind}: the market coin is an OP_TRUE output with value and no asset`);
    const C = m.C, C2 = o.value, yin = inOf(yes), nin = inOf(no), yout = outOf(yes), nout = outOf(no);
    if (rec.kind === 'split') { const N = C2 - C; if (!(N > 0)) return bad('split: the collateral grows'); if (yout - yin !== N || nout - nin !== N) return bad(`split: tallies exactly ${N} YES and ${N} NO beyond what it carries`); return { ok: true, kind: 'split', effect: { ...m, coin: key(txid, rec.vout), C: C2 } }; }
    const N = C - C2; if (!(N > 0)) return bad(`${rec.kind}: the collateral shrinks`);
    if (rec.kind === 'merge') { if (yin < N || nin < N) return bad(`merge: carries in at least ${N} YES and ${N} NO`); if (yout > yin - N || nout > nin - N) return bad(`merge: destroys ${N} of each`); return { ok: true, kind: 'merge', effect: { ...m, coin: key(txid, rec.vout), C: C2 } }; }
    // redeem
    if (m.status === 'resolved') { const w = m.winner === 'yes' ? yes : no, win = w === yes ? yin : nin, wout = w === yes ? yout : nout; if (win < N || wout > win - N) return bad(`redeem: carries in at least ${N} of the winner and destroys ${N}`); return { ok: true, kind: 'redeem', effect: { ...m, coin: key(txid, rec.vout), C: C2 } }; }
    if (!(height > m.expiry + m.grace)) return bad('redeem: the market is open until expiry plus grace');
    if (yout > yin || nout > nin || (yin - yout) + (nin - nout) < 2 * N) return bad(`refund: destroys YES and NO worth ${2 * N} at half a sat each`);
    return { ok: true, kind: 'refund', effect: { ...m, coin: key(txid, rec.vout), C: C2, status: 'refunding' } };
  }
  function apply(effect, height, log) {
    const before = markets.get(effect.id) ?? null; log?.push({ id: effect.id, before }); if (before) byOutpoint.delete(before.coin);
    markets.set(effect.id, { ...effect }); byOutpoint.set(effect.coin, effect.id);
    if (!before && height != null) { assets.issued.set(effect.id, { ticker: 'YES', decimals: 0, height, market: effect.id }); assets.issued.set(noId(effect.id), { ticker: 'NO', decimals: 0, height, market: effect.id }); }
  }
  return {
    graph: { '@id': 'sidestr:overlay-markets', '@context': { sidestr: 'https://sidestr.com/ns#' }, '@graph': [
      { '@id': RULE, '@type': 'ValidationRule', ruleSet: 'btc:BlockContextRules', label: 'markets', errorCode: 'bad-market',
        comment: 'A market coin holds the collateral behind every YES/NO pair: split mints pairs against sats, merge burns them, the resolver\'s signed answer lets the winner redeem one for one, and an unanswered market refunds at half par after expiry plus grace (proposals/markets.md).' } ] },
    markets, byOutpoint, journal, check, apply, noId, from,
    yesNo(id) { return { yes: id, no: noId(id) }; },
    installChecks({ blocks, codec }) {
      blocks.registerChecks({ blockContext: { [RULE]: ({ block, height, spending }) => {
        if (height < from) return true; // adopted from a height: the history below it is accepted unchanged
        for (const { id, before } of (journal.get(height) ?? []).reverse()) { const cur = markets.get(id); if (cur) byOutpoint.delete(cur.coin); if (before) { markets.set(id, before); byOutpoint.set(before.coin, id); } else markets.delete(id); }
        const view = assets.lastHeight === height && assets.lastView ? assets.lastView : new assets.CarryView(assets.carried); const log = []; journal.set(height, log);
        const resolved = new Map(); for (const r of spending?.resolvedInputs ?? []) resolved.set(r.tx, (resolved.get(r.tx) ?? new Map()).set(r.inIndex, r.prevout.scriptPubKey));
        for (let i = 0; i < block.transactions.length; i++) { const tx = block.transactions[i]; const byIn = resolved.get(tx); const scriptOf = (prev) => { const j = tx.inputs.findIndex((x) => x.prevout.txid === prev.txid && x.prevout.vout === prev.vout); return byIn?.get(j) ?? null; };
          const r = check(tx, codec.txid(tx), view, { coinbase: i === 0, height, scriptOf }); if (!r.ok) return false; if (r.effect) apply(r.effect, height, log); }
        return true;
      } } });
    },
  };
}
