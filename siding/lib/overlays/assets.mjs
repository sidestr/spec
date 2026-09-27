// The `assets` rule (SPEC 12.2): issued assets ride on ordinary coins by tally records; for every
// asset, a transaction's inputs carry at least what its tallies assign, and the difference is
// destroyed. Issuance (`issue:` with `tally:self:`) is the one creation. Share assets of pools
// are the pool rule's to account for, so they are exempt here when a pool rule is present.
// State beside the UTXO set: what each unspent output carries, derived from the chain on open.
import { classify } from '../records.mjs';
export const RULE = 'sidestr:rule-assets';
const key = (txid, vout) => `${txid}:${vout}`;

// A view over the committed map with the block's own effects on top, so a transaction can spend
// what an earlier one in the same block created. `commit()` folds it in under a height.
export class CarryView {
  constructor(base) { this.base = base; this.temp = new Map(); this.spent = new Map(); }
  get(k) { if (this.spent.has(k)) return undefined; return this.temp.has(k) ? this.temp.get(k) : this.base.get(k); }
  set(k, v) { this.temp.set(k, v); }
  spend(k) { const v = this.get(k); if (v) this.spent.set(k, v); }
  before(k) { return this.spent.get(k) ?? this.get(k); } // what an outpoint carried, even if this view has spent it
}

export function assetsOverlay(chain, { pools = null, marketMint = null } = {}) {
  const carried = new Map();   // outpoint -> Map(asset id -> amount), for unspent tallied outputs
  const byHeight = new Map();  // height -> { added: [outpoints], removed: [[outpoint, carry]] }, so one height re-validated is idempotent
  const issued = new Map();    // asset id -> { ticker, decimals, height }
  const isShare = (asset, tx, txid, cls) => !!pools && (pools.has(asset) || (asset === txid && cls.pools.some((p) => p.pool === 'self')));
  const isMint = (asset, cls) => !!marketMint && cls.markets.some((r) => r.kind === 'split' && marketMint(asset, r.market)); // a split mints its market's YES and NO (proposals/markets.md)
  // check one transaction against a view; returns { ok, error, out: Map(vout -> Map(asset -> amount)) } and, when ok, writes its outputs into the view
  function check(tx, txid, view, { coinbase = false } = {}) {
    const cls = classify(tx); const bad = (error) => ({ ok: false, error });
    if (coinbase) return cls.issues.length || cls.tallies.length || cls.bad.length ? bad('the coinbase carries no records') : { ok: true, out: new Map() };
    if (cls.bad.length) return bad(`malformed record: ${cls.bad[0].slice(0, 40)}`);
    if (cls.issues.length > 1) return bad('at most one issue: per transaction');
    const opensPool = cls.pools.some((p) => p.pool === 'self'); if (cls.issues.length && opensPool) return bad('a transaction that opens a pool does not issue');
    // what the inputs carry, per asset
    const inCarry = new Map();
    for (const inp of tx.inputs) { const c = view.get(key(inp.prevout.txid, inp.prevout.vout)); if (!c) continue; for (const [a, n] of c) inCarry.set(a, (inCarry.get(a) ?? 0) + n); }
    // what the tallies assign, per asset and per output
    const out = new Map(), assigned = new Map(), seenAsset = new Set();
    for (const t of cls.tallies) {
      const asset = t.asset === 'self' ? txid : t.asset;
      if (t.asset === 'self' && !cls.issues.length && !opensPool) return bad('tally:self without issue: or pool:self:');
      if (seenAsset.has(asset)) return bad(`asset ${asset.slice(0, 8)}… tallied twice`); seenAsset.add(asset);
      for (const { vout, amount } of t.assigns) {
        const o = tx.outputs[vout]; if (!o) return bad(`tally names output ${vout}, which does not exist`); if (o.scriptPubKey.startsWith('6a')) return bad(`tally names output ${vout}, an OP_RETURN`); if (!(o.value >= 1)) return bad(`tally names output ${vout}, which has no value`);
        if (!out.has(vout)) out.set(vout, new Map()); out.get(vout).set(asset, amount); assigned.set(asset, (assigned.get(asset) ?? 0) + amount);
      }
    }
    for (const [asset, n] of assigned) {
      if (asset === txid && cls.issues.length) continue;                 // issuance: created from nothing
      if (isShare(asset, tx, txid, cls)) continue;                       // shares: the pool rule accounts
      if (isMint(asset, cls)) continue;                                 // outcomes minted by a split: the markets rule accounts
      if (n > (inCarry.get(asset) ?? 0)) return bad(`assigns ${n} of ${asset.slice(0, 8)}… but carries ${inCarry.get(asset) ?? 0}`);
    }
    for (const inp of tx.inputs) view.spend(key(inp.prevout.txid, inp.prevout.vout)); // spent: carries nothing now
    for (const [vout, m] of out) view.set(key(txid, vout), m);
    return { ok: true, out, issue: cls.issues[0] ? { id: txid, ...cls.issues[0] } : null, inCarry };
  }
  const self = {
    lastHeight: -1, lastView: null, // the view of the block just validated, so a later rule can read what its inputs carried
    graph: { '@id': 'sidestr:overlay-assets', '@context': { sidestr: 'https://sidestr.com/ns#' }, '@graph': [
      { '@id': RULE, '@type': 'ValidationRule', ruleSet: 'btc:BlockContextRules', label: 'assets', errorCode: 'bad-tally',
        comment: 'For every asset, what a transaction\'s inputs carry is at least what its tallies assign; issue: creates; the coinbase carries no records (SPEC 12.2).' } ] },
    carried, issued, check, CarryView,
    // the carried amounts of an unspent output, or null
    of(txid, vout) { return carried.get(key(txid, vout)) ?? null; },
    installChecks({ blocks, codec }) {
      blocks.registerChecks({ blockContext: { [RULE]: ({ block, height }) => {
        const prev = byHeight.get(height); if (prev) { for (const k of prev.added) carried.delete(k); for (const [k, v] of prev.removed) carried.set(k, v); } // idempotent per height
        const view = new CarryView(carried); const added = [], removed = [];
        for (let i = 0; i < block.transactions.length; i++) { const tx = block.transactions[i]; const r = check(tx, codec.txid(tx), view, { coinbase: i === 0 }); if (!r.ok) return false; }
        for (const [k, v] of view.temp) { carried.set(k, v); added.push(k); }
        for (const [k, v] of view.spent) { if (carried.has(k)) { if (!view.temp.has(k)) removed.push([k, v]); carried.delete(k); } }
        for (let i = 1; i < block.transactions.length; i++) { const tx = block.transactions[i]; const { issues } = classify(tx); if (issues[0]) issued.set(codec.txid(tx), { ...issues[0], height }); }
        byHeight.set(height, { added, removed }); self.lastHeight = height; self.lastView = view; return true;
      } } });
    },
  };
  return self;
}
