// The rules a chain document names (SPEC 12): `"rules": ["assets", "pool"]`, each a name or
// `{ "name": …, "from": <height> }` for a rule adopted on a running chain (proposals/markets.md 6).
// A validator without one of them refuses the chain. Both Node and browsers import this.
import { assetsOverlay } from './assets.mjs';
import { poolOverlay } from './pool.mjs';
import { evmOverlay } from './evm.mjs';
import { marketsOverlay, noIdOf } from './markets.mjs';
import { parseClaims } from '../overlay.mjs';
export const KNOWN = ['assets', 'pool', 'evm', 'markets'];
export function ruleEntries(chain) { return (chain.rules ?? []).map((r) => typeof r === 'string' ? { name: r, from: 0 } : { name: r.name, from: Number(r.from ?? 0) }); }
// `hash` (the engine's hash module: sha256, bytesToHex) is needed by the markets rule for the NO asset's id
export function rulesFor(chain, { hash = null } = {}) {
  const entries = ruleEntries(chain); const names = entries.map((e) => e.name); for (const n of names) if (!KNOWN.includes(n)) throw new Error(`chain ${chain.id} names rule "${n}", which this validator does not have`);
  if (names.includes('pool') && !names.includes('assets')) throw new Error('the pool rule needs the assets rule');
  if (names.includes('markets') && !names.includes('assets')) throw new Error('the markets rule needs the assets rule');
  if (names.includes('markets') && !hash) throw new Error('the markets rule needs the engine\'s hash module');
  const out = { overlays: [], assets: null, pool: null, evm: null, markets: null }; if (!names.length) return out;
  if (names.includes('evm')) out.evm = evmOverlay(chain, { claimsOf: (cb) => parseClaims(cb).claims.reduce((s, c) => s + c.payout.value, 0) });
  const pools = new Map(); const markets = new Map();
  out.assets = assetsOverlay(chain, { pools: names.includes('pool') ? pools : null, marketMint: names.includes('markets') ? (asset, id) => markets.has(id) && (asset === id || asset === noIdOf(hash, id)) : null });
  if (names.includes('pool')) out.pool = poolOverlay(chain, { assets: out.assets, pools });
  if (names.includes('markets')) out.markets = marketsOverlay(chain, { assets: out.assets, hash, markets, from: entries.find((e) => e.name === 'markets').from });
  out.overlays = [out.assets, out.pool, out.markets, out.evm].filter(Boolean); return out;
}
