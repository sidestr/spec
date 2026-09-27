// The `evm` rule (proposals/evm.md): Ethereum transactions ride inside ordinary sidestr
// transactions as carrier records, a validator runs them in block order through ethereumjs's
// VM and keeps the account state beside the UTXO set, and the coinbase commits the state root
// so every validator agrees. Sats and EVM balance meet at a fixed rate: 1 sat = 1 gwei.
//   deposit:    an output paying the chain's reserve script, immediately followed by
//               OP_RETURN "evmin:" + 20-byte address — credits value × 1e9 wei
//   carrier:    OP_RETURN "evm:" + the signed Ethereum transaction (RLP), executed in order
//   withdrawal: an EVM transaction to WITHDRAW with 34 bytes of data (a sidechain script) and a
//               value: the value is burned in the EVM and the block's coinbase must pay
//               floor(value / 1e9) sats to that script
//   root:       the coinbase carries OP_RETURN "evmroot:" + the 32-byte state root after the block
// Execution is asynchronous, so a validator calls prepare(block) before the kernel's checks;
// the registered rule then reads the verdict prepare left for that block.
export const WITHDRAW = '0x00000000000000000000000000000000000501de'; // "sidestr" withdrawal address
export const GWEI = 1000000000n;
const enc = new TextEncoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from((h.startsWith('0x') ? h.slice(2) : h).match(/../g) ?? [], (x) => parseInt(x, 16));
const pushData = (bytes) => { const n = bytes.length; const op = n <= 75 ? [n] : n <= 255 ? [0x4c, n] : [0x4d, n & 255, n >> 8]; return '6a' + hex(Uint8Array.from(op)) + hex(bytes); };
const opReturnBytes = (spk) => { const m = /^6a(?:4c([0-9a-f]{2})|4d([0-9a-f]{4})|([0-9a-f]{2}))([0-9a-f]*)$/i.exec(spk); if (!m) return null; const n = m[1] ? parseInt(m[1], 16) : m[2] ? parseInt(m[2].slice(2) + m[2].slice(0, 2), 16) : parseInt(m[3], 16); const b = unhex(m[4]); return b.length === n ? b : null; };
const withPrefix = (b, p) => { const h = enc.encode(p); if (!b || b.length <= h.length) return null; for (let i = 0; i < h.length; i++) if (b[i] !== h[i]) return null; return b.subarray(h.length); };
export const carrierScript = (rlp) => pushData(new Uint8Array([...enc.encode('evm:'), ...rlp]));
export const depositScript = (address) => pushData(new Uint8Array([...enc.encode('evmin:'), ...unhex(address)]));
export const rootScript = (root) => pushData(new Uint8Array([...enc.encode('evmroot:'), ...unhex(root)]));
export const parseCarrier = (spk) => withPrefix(opReturnBytes(spk), 'evm:');
export const parseDeposit = (spk) => { const b = withPrefix(opReturnBytes(spk), 'evmin:'); return b && b.length === 20 ? '0x' + hex(b) : null; };
export const parseRoot = (spk) => { const b = withPrefix(opReturnBytes(spk), 'evmroot:'); return b && b.length === 32 ? '0x' + hex(b) : null; };
export const RULE = 'sidestr:rule-evm';

export function evmOverlay(chain, { claimsOf = null } = {}) {
  const cfg = chain.evm ?? {}; const chainId = Number(cfg.chainId ?? 21474), gasLimit = BigInt(cfg.gasLimit ?? 30000000), baseFee = GWEI, reserve = (cfg.reserve ?? chain.challenge).toLowerCase();
  let lib = null, vm = null, common = null; const roots = new Map(); // height -> root after that block
  const verdicts = new Map();   // block hash -> { ok, error, root, receipts, withdrawals }
  const receipts = new Map();   // eth tx hash -> receipt (+ height, sidechain txid)
  const txs = new Map();        // eth tx hash -> { tx (ethereumjs), height, index }
  const blocks = new Map();     // height -> { hashes: [eth tx hashes], root }
  const src = (m) => typeof window === 'undefined' ? m : `https://cdn.jsdelivr.net/npm/${m}@10.1.3/+esm`; // Node resolves the packages; a page takes jsdelivr's bundles
  // JSON-safe copies of receipts (BigInt gas, Uint8Array logs) for a snapshot, and back
  const pack = (v) => typeof v === 'bigint' ? { $b: v.toString() } : v instanceof Uint8Array ? { $u: hex(v) } : Array.isArray(v) ? v.map(pack) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)])) : v;
  const unpack = (v) => Array.isArray(v) ? v.map(unpack) : v && typeof v === 'object' ? ('$b' in v ? BigInt(v.$b) : '$u' in v ? unhex(v.$u) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)]))) : v;
  const self = {
    graph: { '@id': 'sidestr:overlay-evm', '@context': { sidestr: 'https://sidestr.com/ns#' }, '@graph': [
      { '@id': RULE, '@type': 'ValidationRule', ruleSet: 'btc:BlockContextRules', label: 'evm', errorCode: 'bad-evm',
        comment: 'Every carried Ethereum transaction runs in order and succeeds in being applied (a reverting call is applied too); deposits credit at 1 sat = 1 gwei; withdrawals are paid by the coinbase; the coinbase commits the state root after the block (proposals/evm.md).' } ] },
    chainId, gasLimit, reserve, receipts, txs, blocks, roots, verdicts, ready: false,
    async init() {
      if (lib) return self;
      const [vmm, tx, blk, com, util] = await Promise.all([import(src('@ethereumjs/vm')), import(src('@ethereumjs/tx')), import(src('@ethereumjs/block')), import(src('@ethereumjs/common')), import(src('@ethereumjs/util'))]);
      lib = { vmm, tx, blk, com, util }; common = com.createCustomCommon({ chainId, name: chain.id }, com.Mainnet, { hardfork: com.Hardfork.Cancun }); vm = await vmm.createVM({ common });
      roots.set(-1, hex(await vm.stateManager.getStateRoot())); self.ready = true; return self;
    },
    get vm() { return vm; }, get common() { return common; }, get lib() { return lib; },
    // the state as of the last applied height, as JSON-safe data a client can keep: the trie's backing map (every node and
    // code blob written so far; the trie is not pruned, so every root in `roots` stays readable), the roots, the block
    // records, the receipts and the carried transactions as RLP. restore(snap, height) rebuilds the VM on it at that height.
    async snapshot() {
      if (!lib) await self.init(); const map = vm.stateManager._trie.database().db._database;
      return { db: [...map].map(([k, v]) => [k, hex(v)]), roots: [...roots], blocks: [...blocks], receipts: [...receipts].map(([h, r]) => [h, pack(r)]),
        txs: [...txs].map(([h, t]) => [h, { rlp: hex(t.tx.serialize()), height: t.height, sidechainTxid: t.sidechainTxid, index: t.index }]) };
    },
    async restore(snap, height) {
      if (!lib) await self.init(); const { vmm, tx: T } = lib; const { MerkleStateManager } = await import(src('@ethereumjs/statemanager'));
      const sm = new MerkleStateManager({ common }); const map = sm._trie.database().db._database; map.clear(); for (const [k, v] of snap.db) map.set(k, unhex(v));
      vm = await vmm.createVM({ common, stateManager: sm });
      roots.clear(); for (const [h, r] of snap.roots) roots.set(h, r); blocks.clear(); for (const [h, b] of snap.blocks) blocks.set(h, b);
      receipts.clear(); for (const [h, r] of snap.receipts) receipts.set(h, unpack(r)); txs.clear(); for (const [h, t] of snap.txs) txs.set(h, { tx: T.createTxFromRLP(unhex(t.rlp), { common }), height: t.height, sidechainTxid: t.sidechainTxid, index: t.index });
      const root = roots.get(height); if (root === undefined) throw new Error(`no evm state at height ${height}`); await vm.stateManager.setStateRoot(unhex(root)); return self;
    },
    rootHex: async () => '0x' + hex(await vm.stateManager.getStateRoot()),
    // run one sidechain transaction's deposits and carriers against the current VM state; returns { ok, error, hashes, withdrawals, gasUsed }
    async applyTx(tx, txid, { height, time, index0 = 0 }) {
      const { util, blk, tx: T, vmm } = lib; const out = { ok: true, hashes: [], withdrawals: [], gasUsed: 0n };
      const block = blk.createBlock({ header: { number: BigInt(height), timestamp: BigInt(time), gasLimit, coinbase: util.createZeroAddress(), baseFeePerGas: baseFee } }, { common });
      for (let i = 0; i < tx.outputs.length; i++) {
        const o = tx.outputs[i]; const dep = parseDeposit(o.scriptPubKey);
        if (dep) { const prev = tx.outputs[i - 1]; if (!prev || prev.scriptPubKey.toLowerCase() !== reserve || !(prev.value >= 1)) return { ...out, ok: false, error: `evmin at output ${i} has no reserve payment before it` };
          const addr = util.createAddressFromString(dep); const acct = (await vm.stateManager.getAccount(addr)) ?? new util.Account(); acct.balance += BigInt(prev.value) * GWEI; await vm.stateManager.putAccount(addr, acct); continue; }
        const rlp = parseCarrier(o.scriptPubKey); if (!rlp) continue;
        let etx; try { etx = T.createTxFromRLP(rlp, { common }); } catch (e) { return { ...out, ok: false, error: `carrier at output ${i}: not an Ethereum transaction (${e.message.slice(0, 60)})` }; }
        if (!etx.isSigned() || !etx.verifySignature()) return { ...out, ok: false, error: `carrier at output ${i}: unsigned or bad signature` };
        let r; try { r = await vmm.runTx(vm, { tx: etx, block, skipBlockGasLimitValidation: true }); } catch (e) { return { ...out, ok: false, error: `carrier at output ${i}: ${e.message.slice(0, 120)}` }; }
        out.gasUsed += r.totalGasSpent; const h = '0x' + hex(etx.hash()); out.hashes.push(h);
        receipts.set(h, { transactionHash: h, status: r.receipt.status !== undefined ? Number(r.receipt.status) : 1, gasUsed: r.totalGasSpent, cumulativeGasUsed: r.totalGasSpent, logs: r.execResult.logs ?? [], contractAddress: r.createdAddress ? r.createdAddress.toString() : null, height, sidechainTxid: txid, from: etx.getSenderAddress().toString(), to: etx.to ? etx.to.toString() : null, effectiveGasPrice: r.amountSpent / (r.totalGasSpent || 1n), logsBloom: r.receipt.bitvector ? '0x' + hex(r.receipt.bitvector) : null });
        txs.set(h, { tx: etx, height, sidechainTxid: txid, index: index0 + out.hashes.length - 1 });
        // a withdrawal: value sent to WITHDRAW with a 34-byte script as data
        if (etx.to && etx.to.toString().toLowerCase() === WITHDRAW && etx.value > 0n && etx.data.length === 34 && (r.receipt.status === undefined || Number(r.receipt.status) === 1)) {
          const script = hex(etx.data); const sats = Number(etx.value / GWEI); const w = util.createAddressFromString(WITHDRAW); const acct = await vm.stateManager.getAccount(w); if (acct) { acct.balance = 0n; await vm.stateManager.putAccount(w, acct); }
          if (sats >= 1) out.withdrawals.push({ script, sats, hash: h });
        }
      }
      return out;
    },
    // the whole block, from the state after height-1: verdict remembered by block hash for the sync rule
    async prepare(block, height, codec) {
      if (!lib) await self.init(); const bh = codec.blockHash(block.header);
      const prevRoot = roots.get(height - 1); if (prevRoot === undefined) { verdicts.set(bh, { ok: false, error: `no state for height ${height - 1}` }); return verdicts.get(bh); }
      await vm.stateManager.setStateRoot(unhex(prevRoot)); await vm.stateManager.checkpoint();
      const hashes = [], withdrawals = []; let error = null; let idx = 0;
      for (let i = 1; i < block.transactions.length && !error; i++) { const tx = block.transactions[i]; const r = await self.applyTx(tx, codec.txid(tx), { height, time: block.header.time, index0: idx }); if (!r.ok) error = `tx ${i}: ${r.error}`; else { hashes.push(...r.hashes); withdrawals.push(...r.withdrawals); idx += r.hashes.length; } }
      const root = '0x' + hex(await vm.stateManager.getStateRoot()); const cb = block.transactions[0]; const committed = cb.outputs.map((o) => parseRoot(o.scriptPubKey)).find(Boolean) ?? null;
      if (!error && committed !== root) error = `coinbase commits ${committed ? committed.slice(0, 14) : 'no'} state root, the block's execution gives ${root.slice(0, 14)}`;
      if (!error) for (const w of withdrawals) { if (!cb.outputs.some((o) => o.scriptPubKey === w.script && o.value === w.sats)) { error = `withdrawal of ${w.sats} sats to ${w.script.slice(0, 12)}… is not paid by the coinbase`; break; } }
      if (error) { await vm.stateManager.revert(); for (const h of hashes) { receipts.delete(h); txs.delete(h); } verdicts.set(bh, { ok: false, error, root, withdrawals }); return verdicts.get(bh); }
      await vm.stateManager.commit(); roots.set(height, root.slice(2)); blocks.set(height, { hashes, root }); verdicts.set(bh, { ok: true, root, withdrawals, hashes }); return verdicts.get(bh);
    },
    // the mempool: run one transaction on the current state and revert — a carrier that cannot be applied is refused
    async checkTx(tx, txid, { height, time, keep = false } = {}) {
      if (!lib) await self.init(); if (!keep) await vm.stateManager.checkpoint(); const r = await self.applyTx(tx, txid, { height: height ?? 0, time: time ?? Math.floor(Date.now() / 1000) });
      if (!keep) { await vm.stateManager.revert(); for (const h of r.hashes) { receipts.delete(h); txs.delete(h); } }
      return r;
    },
    // sequencing for the block builder: begin a checkpoint, applyTx with keep, then end() with the root and withdrawals, reverting the state
    async begin() { if (!lib) await self.init(); await vm.stateManager.checkpoint(); },
    async end(hashes = []) { const root = '0x' + hex(await vm.stateManager.getStateRoot()); await vm.stateManager.revert(); for (const h of hashes) { receipts.delete(h); txs.delete(h); } return root; },
    installChecks({ blocks: kb, codec }) {
      kb.registerChecks({ blockContext: {
        [RULE]: ({ block }) => { const v = verdicts.get(codec.blockHash(block.header)); return v ? v.ok : false; },
        // the kernel's rule plus claims plus withdrawals: coinbase value <= fees + claims + withdrawals
        'btc:rule-blockctx-coinbase-amount': ({ block, height, spending }) => {
          if (spending.valueUnresolved > 0) return null; const cb = block.transactions[0]; const v = verdicts.get(codec.blockHash(block.header)); if (!v?.ok) return false;
          const claims = claimsOf ? claimsOf(cb) : 0; const paid = v.withdrawals.reduce((s, w) => s + w.sats, 0);
          return cb.outputs.reduce((s, o) => s + o.value, 0) <= kb.subsidy(height) + spending.fees + claims + paid;
        },
      } });
    },
  };
  return self;
}
