#!/usr/bin/env node
// The txbt4 siding, or any sidestr chain from a chain document (SPEC 10, 11).
//   siding new --name <name> --prefix <hrp> [--parent txbt4|xbt|tbtc4|btc] [--comment ...] [--rules assets,pool] [--interval 600] [--port N] [--out FILE]
//   siding new ... --signers pk1,pk2,pk3 --threshold 2 --key-files f1,f2   a level 2 chain: the challenge is derived, the genesis sealed by k keys
//   siding produce ... on a level 2 chain, --key-file is one signer's key; blocks come from the round (kinds 23510/23511/23514) [--propose-after 30]
//   siding peg-wallet --chain C --key-file F --name W --parent-rpc URL --parent-cookie FILE   this signer's node wallet for the k-of-n peg:
//       the chain's challenge as a descriptor with this signer's key private, the others' public; peg-outs are then a PSBT round (23512/23513)
//       a whole chain: document at chains/<name>/chain.json, signer key, genesis, and the lines to run and mirror it
//   siding key --create [--chain chain.json]        the signer key (~/.sidestr/<name>.key) and its challenge
//   siding genesis --chain chain.json --dir DIR     write block 0
//   siding chain-event --chain chain.json [--key-file F] [--relay wss://a,wss://b] [--out chain-event.json]
//       the document as a kind 3500 event (SPEC 3): its id is the chain's hash; written beside the document and published
//   siding produce --chain chain.json --dir DIR [--port 3450] [--interval 600] [--tx-interval 30]
//   siding sync --url http://host:3450 --dir DIR    validate a producer's chain into DIR
//   siding send --url http://host:3450 --chain chain.json --to <address or script> --amount <sats> [--fee <sats>]
//       the fee defaults to the transaction's size at the chain's minFeeRate (chain.json, sat/vB)
//   siding send --relay wss://a,wss://b ...   the same, published as a kind 23500 event instead of POSTed
//   siding send --pegout --to <parent address> --amount <sats>   burn on the sidechain; the peg wallet pays it on the parent (SPEC 7)
//   siding send --evm --to 0x<address> --amount <sats>   on an evm chain: deposit sats into the EVM at 1 sat = 1 gwei (proposals/evm.md)
//   siding produce ... --relay wss://a,wss://b  also follow those relays for kind 23500 transactions
//   siding faucet --chain chain.json --url http://127.0.0.1:3450 --relay wss://a,wss://b --key-file F [--amount 100000] [--per-address-hours 24] [--per-hour 20]
//       pay kind 23501 requests (content: an address) from this key, once per address per period, capped per hour
//   siding produce ... --announce-mirror https://a/siding[,https://b/siding]  publish the tip (NIP-333, kind 33333, d = chain id)
//       to the relays after every block, naming those mirrors; a client that knows only the chain id finds the chain
//   siding produce ... --parent-wallet <name>  the parent wallet holding the peg outputs: every burn is paid from it (SPEC 7)
//   siding produce ... on a chain naming the evm rule: POST /evm is an Ethereum JSON-RPC (MetaMask, ethers, viem);
//       eth_sendRawTransaction is carried in a sidestr transaction the signer pays for
//   siding produce ... --checkpoint-every N [--checkpoint-wallet <name>]   every N blocks, write the tip into the parent as an OP_RETURN
//       from that wallet (default: the peg wallet; a separate fee wallet keeps checkpoints away from peg outputs altogether)
//       (SPEC 11 checkpoints), record <dir>/checkpoints.json; the parent's proof of work then vouches for the history
//       with `pledge` in the document (SPEC 6.2): records every locked coinbase output as <dir>/coinbases.json, follows kind 33502
//       pledges on the relays, pays the rate from the signer's coins, broadcasts each pledge at maturity, claims it to the float
//   siding produce ... --parent-rpc http://host:port/ --parent-cookie FILE [--parent-from H] [--parent-poll 60]
//       with a parent view (SPEC 6): scan the parent for this chain's peg-ins and claim each once it has
//       pegConfirmations; scan state in <dir>/pegins.json
import { decodeAddress, scriptToAddress } from '../lib/address.mjs';
import { writeFile, readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { existsSync, statSync, createReadStream } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { loadEngine, SCHEMA } from '../lib/engine.mjs';
import { resolveParent } from '../lib/parents.mjs';
import { signKeyPath, usesUnifiedSighash } from '../lib/txsign.mjs';
import { makeSigner, loadKey } from '../lib/sign.mjs';
import { makeEvents, subscribe, publish, TX_KIND, PARENT_TX_KIND } from '../lib/relay.mjs';
import { makeParent, scanPegins, newPegins, pegStatus, payPegout, paidPegouts, lockOutputs, relayParentTx } from '../lib/parent.mjs';
import { verifyPledge, PLEDGE_KIND, maturityOf } from '../lib/pledge.mjs';
import { sendCheckpoint, checkpointStatus, sentCheckpoints } from '../lib/checkpoint.mjs';
import { loadParentKernel } from '../lib/engine.mjs';
import { buildSpend, deliver, resolveTo } from '../lib/spend.mjs';
import { FAUCET_KIND, makeEvents as mkEvents } from '../lib/relay.mjs';
import { tipEvent, TIP_HEADERS, chainEvent, parseChainEvent } from '../lib/announce.mjs';
import { dirname, join } from 'node:path';
import { Siding } from '../lib/chain.mjs';
import { makeRound } from '../lib/round.mjs';
import { federation, partialSignature, sealFederated, wif, pegDescriptor } from '../lib/federation.mjs';
import { makePegoutRound } from '../lib/pegoutround.mjs';
import { makeEvmRpc } from '../lib/evmrpc.mjs';
import { parseClaims } from '../lib/overlay.mjs';

const args = Object.fromEntries(process.argv.slice(3).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const cmd = process.argv[2];
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
// `siding new`: a whole chain from a name — document, signer key, genesis, and the lines to run it
if (cmd === 'new') {
  const name = args.name, prefix = args.prefix; if (!name || !prefix || typeof name !== 'string' || typeof prefix !== 'string') throw new Error('siding new --name <name> --prefix <bech32 hrp> [--parent btc:testnet4-blake2b] [--comment ...] [--out chains/<name>/chain.json]');
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) throw new Error('a name is lower-case letters, digits and dashes'); if (!/^[a-z]{1,8}$/.test(prefix)) throw new Error('a prefix is 1 to 8 lower-case letters');
  const out = args.out ?? new URL(`../../chains/${name}/chain.json`, import.meta.url).pathname; if (existsSync(out)) throw new Error(`${out} exists; pick another name or remove it`);
  const magic = Array.from(new TextEncoder().encode(`sidestr:${name}`)).reduce((h, b) => ((h * 31 + b) >>> 0), 7).toString(16).padStart(8, '0');
  const doc = { id: `sidestr:${name}`, name, parent: resolveParent(args.parent ?? 'txbt4').alias, comment: args.comment ?? `A sidestr chain beside ${resolveParent(args.parent ?? 'txbt4').label}, made ${new Date().toISOString().slice(0, 10)}. Level 1: one signer. Coins with no value.`,
    challenge: '', powLimit: '7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', addressPrefix: prefix, magic, pegConfirmations: Number(args['peg-confirmations'] ?? 6), refundBlocks: 10000, pegoutBlocks: 144, pegoutMin: Number(args['pegout-min'] ?? 10000), minFeeRate: Number(args['min-fee-rate'] ?? 1),
    genesisTime: Math.floor(Date.now() / 1000), pegs: [], signer: '', ...(args.rules ? { rules: String(args.rules).split(',').map((x) => x.trim()).filter(Boolean) } : {}) };
  const eng = await loadEngine(doc); const sg = makeSigner(eng); let key = null, pub = null, kp = null, sealKeys = [];
  if (args.signers) { // level 2: the signers are given; the genesis is sealed by k of their keys
    doc.signers = String(args.signers).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); doc.threshold = Number(args.threshold ?? Math.ceil(doc.signers.length / 2 + 0.01));
    const fed = federation(eng, doc); doc.challenge = fed.challenge; delete doc.signer;
    for (const f of String(args['key-files'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)) sealKeys.push(await loadKey(f, { signer: sg }));
    if (sealKeys.length < doc.threshold) throw new Error(`--key-files: ${doc.threshold} signer key files are needed to seal the genesis`);
  } else { kp = args['key-file'] ?? `${homedir()}/.sidestr/${name}.key`; key = await loadKey(kp, { create: true, signer: sg }); pub = sg.pubkeyOf(key); doc.challenge = '5120' + pub; doc.signer = pub; }
  const dir = args.dir ?? `${homedir()}/.sidestr/${name}`; await mkdir(dir, { recursive: true }); const engine2 = await loadEngine(doc); const sg2 = makeSigner(engine2);
  const E2 = { ...engine2, interpreter: engine2.k.interpreter, schnorrSign: (m, k) => sg2.schnorrSign(m, k, new Uint8Array(32)) };
  const seal = sealKeys.length ? (g) => { const fed = engine2.sidestr.federation; const sigs = new Map(); for (const k of sealKeys) sigs.set(sg2.pubkeyOf(k), partialSignature(E2, g, fed, k)); return sealFederated(E2, g, fed, sigs); } : null;
  const s = await new Siding({ engine: engine2, chain: doc, dir, signer: sg2, log }).open(key, { seal }); doc.genesisHash = s.genesisHash;
  await mkdir(new URL('.', 'file://' + out).pathname, { recursive: true }); await writeFile(out, JSON.stringify(doc, null, 1) + '\n');
  const port = args.port ?? 3450, interval = args.interval ?? 600;
  console.log(JSON.stringify({ chain: doc.id, document: out, key: kp, signer: pub, signers: doc.signers, threshold: doc.threshold, address: scriptToAddress(doc.challenge, prefix), genesisHash: doc.genesisHash, dir }, null, 1));
  console.log(`
next:
  1. run it (a pm2 entry, or a shell; hosts are yours, never in this repository):
     siding produce --chain ${out} --dir ${dir} --port ${port} --interval ${interval} --tx-interval 10 \\
       --relay wss://nos.lol,wss://relay.damus.io,wss://relay.primal.net,wss://nostr.mom,wss://nostr.oxtr.dev \\
       --parent-rpc http://127.0.0.1:PORT/ --parent-cookie PATH/.cookie --parent-from HEIGHT --parent-wallet ${name}-peg \\
       --announce-mirror https://HOST/PATH/${name}
  2. mirror ${dir}/blocks.dat, blocks.json and the document as chain.json at that URL (rsync in a loop; CORS open, Range requests)
  3. on the parent: a wallet named ${name}-peg for the peg outputs (createwallet), and a peg-in is any output to one of its
     addresses with OP_RETURN pegin:${doc.id}:<sidechain script bytes>; the producer claims it at ${doc.pegConfirmations} confirmations
  4. explorer ?chain=${doc.id}, wallet ?chain=${doc.id}; the directory lists it after the first announcement
  5. commit ${out}: the document is the chain's identity (its genesis hash is derived from it)
  6. siding chain-event --chain ${out} --key-file ${kp} --relay wss://a,wss://b: the document as an event (SPEC 3); its id is the chain's hash, announced with every tip`);
  process.exit(0);
}
const chainFile = args.chain ?? new URL('../chain.json', import.meta.url).pathname;
const chain = JSON.parse(await readFile(chainFile, 'utf8'));
const keyPath = args['key-file'] ?? `${homedir()}/.sidestr/${chain.name}.key`;
const engine = await loadEngine(chain);
const signer = makeSigner(engine);

if (cmd === 'key') {
  const key = await loadKey(keyPath, { create: !!args.create, signer }); const pub = signer.pubkeyOf(key);
  console.log(JSON.stringify({ key: keyPath, pubkey: pub, challenge: '5120' + pub, address: scriptToAddress('5120' + pub, engine.k.params.bech32Hrp) }, null, 1));
  process.exit(0);
}
const dir = args.dir ?? `${homedir()}/.sidestr/${chain.name}`; await mkdir(dir, { recursive: true });

if (cmd === 'genesis') {
  const key = await loadKey(keyPath, { signer });
  const s = await new Siding({ engine, chain, dir, signer, log }).open(key);
  console.log(JSON.stringify({ genesisHash: s.genesisHash, height: s.height(), coins: s.utxo.size }, null, 1)); process.exit(0);
}

if (cmd === 'peg-wallet') {
  const fed = engine.sidestr.federation; if (!fed) throw new Error('not a federated chain'); const key = await loadKey(keyPath, { signer }); const pub = signer.pubkeyOf(key); if (!fed.signers.includes(pub)) throw new Error('this key is not one of the signers');
  const parent = await makeParent({ url: args['parent-rpc'], cookieFile: args['parent-cookie'] ?? `${homedir()}/.bitcoin/.cookie`, wallet: args.name }); const testnet = !resolveParent(chain.parent).mainnet;
  const desc = pegDescriptor(fed, { wifFor: (pk) => pk === pub ? wif(engine, key, { testnet }) : null }); const info = await parent.rpc('getdescriptorinfo', [desc]);
  try { await parent.rpc('createwallet', [args.name, false, true, '', false, true]); } catch (e) { if (!/already/.test(e.message)) throw e; }
  const r = await parent.walletRpc('importdescriptors', [[{ desc: `${desc}#${info.checksum}`, timestamp: 'now', active: false, label: `${chain.id} peg` }]]);
  const addr = (await parent.rpc('deriveaddresses', [`${pegDescriptor(fed)}#${(await parent.rpc('getdescriptorinfo', [pegDescriptor(fed)])).checksum}`]))[0];
  console.log(JSON.stringify({ wallet: args.name, signer: pub, imported: r[0]?.success, pegAddress: addr, challenge: fed.challenge, note: 'the same script as the chain challenge: what pays this address on the parent is a peg-in' }, null, 1)); process.exit(0);
}

// SPEC 3 (0.0.5): the chain document as an immutable event; its id is the chain's hash. Written as chain-event.json beside
// the document (a mirror serves it as it serves chain.json), published to the relays when named, and announced by `produce`
if (cmd === 'chain-event') {
  const key = await loadKey(keyPath, { signer }); const pub = signer.pubkeyOf(key);
  const fed = engine.sidestr.federation; if (fed ? !fed.signers.includes(pub) : chain.challenge !== '5120' + pub) throw new Error(`the key at ${keyPath} is not ${fed ? 'one of the chain\'s signers' : 'the chain\'s signer'}`);
  const ev = chainEvent({ events: mkEvents({ signer, hash: engine.hash }), key, chain }); parseChainEvent(ev, { verify: engine.nostr.verifyNostrEvent });
  const out = args.out ?? join(dirname(chainFile), 'chain-event.json'); await writeFile(out, JSON.stringify(ev, null, 2) + '\n');
  const relays = String(args.relay ?? '').split(',').map((x) => x.trim()).filter(Boolean); const res = relays.length ? await publish({ relays, event: ev }) : {};
  console.log(JSON.stringify({ hash: ev.id, alias: chain.id, signer: pub, written: out, published: res, note: 'the hash is the chain\'s identity: the tip announces it (e), a tweak commits to it; the alias stays for people and tags' }, null, 2));
  process.exit(0);
}

if (cmd === 'produce') {
  const key = await loadKey(keyPath, { signer }); const pub = signer.pubkeyOf(key);
  const fed = engine.sidestr.federation;
  if (fed ? !fed.signers.includes(pub) : chain.challenge !== '5120' + pub) throw new Error(`the key at ${keyPath} is not ${fed ? 'one of the chain\'s signers' : 'the chain\'s signer'}`);
  const s = await new Siding({ engine: { ...engine, signer }, chain, dir, signer, log }).open(fed ? null : key);
  const relays = String(args.relay ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  // SPEC 11: announce the tip on the relays after every block, naming the mirrors
  const mirrors = String(args['announce-mirror'] ?? '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean); let announced = -1;
  // SPEC 6: the script a peg-in pays, announced with every tip. Level 2: the challenge (the k-of-n script). Level 1: one
  // labelled address in the peg wallet, looked up once the parent is open (below), then the tip is re-announced with it.
  let pegScript = fed ? chain.challenge.toLowerCase() : null;
  // SPEC 3: the chain's hash, announced with every tip (`e`) when the document has been published as an event (siding chain-event)
  let chainHash = null; { const f = args['chain-event'] ?? join(dirname(chainFile), 'chain-event.json'); if (existsSync(f)) { const d = parseChainEvent(JSON.parse(await readFile(f, 'utf8')), { verify: engine.nostr.verifyNostrEvent }); if (d.alias !== chain.id) throw new Error(`${f} is the event of ${d.alias}, not ${chain.id}`); chainHash = d.hash; log(`chain hash ${chainHash} (${f})`); } else log(`no chain-event.json beside the document: tips carry no chain hash (siding chain-event makes one)`); }
  let announceRetryAt = 0, announcing = false; // a failed announcement is retried a minute later; one in flight at a time
  const announce = async () => {
    if (!relays.length || !mirrors.length || announcing) return; const tip = s.tip(); if (tip.height === announced || Date.now() < announceRetryAt) return; announcing = true; try {
    const from = Math.max(0, tip.height - TIP_HEADERS + 1); const headersHex = []; for (let h = from; h <= tip.height; h++) headersHex.push(engine.k.codec.encodeHex('BlockHeader', s.node.headers[h]));
    const ev = tipEvent({ events: mkEvents({ signer, hash: engine.hash }), key, chainId: chain.id, headersHex, tip: tip.height, mirrors, pegScript, chainHash });
    const res = await publish({ relays, event: ev }); const okc = Object.values(res).filter((r) => r === 'ok').length; if (okc) announced = tip.height; else announceRetryAt = Date.now() + 60000;
    log(`announced tip ${tip.height} ${tip.hash.slice(0, 16)}… (kind 33333, ${headersHex.length} headers, ${mirrors.length} mirror(s)) to ${okc}/${relays.length} relay(s)`);
    } finally { announcing = false; }
  };
  if (mirrors.length) { setInterval(() => announce().catch((e) => log(`announce: ${e.message}`)), 3000); }
  if (relays.length) subscribe({ relays, chainId: chain.id, verify: engine.nostr.verifyNostrEvent, log, onEvent: async (ev, url) => {
    try { const r = await s.submit(String(ev.content).trim()); log(`tx ${r.txid.slice(0, 16)}… from ${url} (event ${ev.id.slice(0, 8)}…) accepted, fee ${r.fee}`); }
    catch (e) { log(`${url}: event ${ev.id.slice(0, 8)}… refused: ${e.message}`); }
  } });
  log(`${chain.id}: height ${s.height()} tip ${s.tip().hash.slice(0, 16)}…, ${s.utxo.size} coins`);
  const interval = Number(args.interval ?? 600) * 1000, txInterval = Number(args['tx-interval'] ?? 30) * 1000; let last = Date.now();
  // level 2: the round makes the blocks; the tick only says when one is due and whose turn it is
  const checkClaims = async (block) => { if (!parentRef.parent) return null; const { claims, errors } = parseClaims(block.transactions[0]); if (errors.length) return errors[0]; const need = chain.pegConfirmations ?? 6;
    for (const c of claims) { if (s.claimed(c.txid, c.vout)) return `${c.txid.slice(0, 12)}… is claimed already`; const o = await parentRef.parent.rpc('gettxout', [c.txid, c.vout, true]); if (!o) return `${c.txid.slice(0, 12)}…:${c.vout} is not unspent on the parent`; if (o.confirmations < need) return `${c.txid.slice(0, 12)}… has ${o.confirmations} of ${need} confirmations`;
      if (Math.round(o.value * 1e8) !== c.payout.value || o.scriptPubKey.hex !== fed.challenge) return `${c.txid.slice(0, 12)}… does not pay the peg ${c.payout.value} sats`; const raw = await parentRef.parent.rpc('getrawtransaction', [c.txid, true]); const { parsePegMarker } = await import('../lib/marker.mjs'); const marker = raw.vout.map((v) => parsePegMarker(v.scriptPubKey.hex, chain.id)).find(Boolean); if (marker !== c.payout.scriptPubKey) return `${c.txid.slice(0, 12)}…'s marker names ${String(marker).slice(0, 12)}…, the claim pays ${c.payout.scriptPubKey.slice(0, 12)}…`; }
    return null; };
  const parentRef = { parent: null };
  const round = fed ? makeRound({ engine: { ...engine, signer }, s, chain, fed, key, pub, relays: String(args.relay ?? '').split(',').map((x) => x.trim()).filter(Boolean), events: mkEvents({ signer, hash: engine.hash }), publish, subscribe, log, proposeAfter: Number(args['propose-after'] ?? 30), onBlock: () => { last = Date.now(); }, checkClaims }) : null;
  if (fed) log(`level 2: signer ${fed.signers.indexOf(pub) + 1} of ${fed.signers.length}, threshold ${fed.threshold}, proposing after ${Number(args['propose-after'] ?? 30)} s when it is another signer's turn`);
  const tick = () => { const due = Date.now() - last >= (s.mempool.size ? txInterval : interval); if (fed) { round.tick({ due }).catch((e) => log(`round: ${e.message}`)); return; } if (!due || producing) return; producing = true; s.produce(key).then((r) => { last = Date.now(); log(`block ${r.height} ${r.hash.slice(0, 16)}… ${r.txs - 1} txs, fees ${r.fees}`); }).catch((e) => log(`produce: ${e.message}`)).finally(() => { producing = false; }); };
  let producing = false;
  setInterval(tick, 1000);
  // SPEC 6: with a parent view, claim confirmed peg-ins. Which outpoints are already claimed is
  // derived from the chain itself on open; only the scan position and what was found persist.
  const parent = args['parent-rpc'] ? await makeParent({ url: args['parent-rpc'], cookieFile: args['parent-cookie'] ?? `${homedir()}/.bitcoin/.cookie`, wallet: args['parent-wallet'] ?? null }) : null; parentRef.parent = parent;
  const pegFile = `${dir}/pegins.json`; let pegState = { scanned: Number(args['parent-from'] ?? 0) - 1, pegins: [] };
  try { pegState = JSON.parse(await readFile(pegFile, 'utf8')); } catch {}
  if (!pegScript && parent?.walletRpc) { try { const label = `${chain.id} peg`; let addr = null; try { addr = Object.keys(await parent.walletRpc('getaddressesbylabel', [label]))[0] ?? null; } catch {} if (!addr) addr = await parent.walletRpc('getnewaddress', [label, 'bech32m']); const info = await parent.walletRpc('getaddressinfo', [addr]); pegScript = String(info.scriptPubKey).toLowerCase(); announced = -1; log(`peg-ins pay ${addr} (${pegScript.slice(0, 12)}…), announced with every tip`); } catch (e) { log(`no peg address announced: ${e.message}`); } }
  // SPEC 11: parent transactions over the relays (kind 23503) — broadcast if and only if our node's policy accepts them
  if (parent && relays.length) { const seenParent = new Set(); subscribe({ relays, chainId: chain.id, kind: PARENT_TX_KIND, verify: engine.nostr.verifyNostrEvent, log, onEvent: async (ev, url) => { try { const r = await relayParentTx(parent, ev.content, { seen: seenParent }); if (r.duplicate) return; log(r.ok ? `parent tx ${r.txid.slice(0, 16)}… from ${url}: accepted by the node's policy and broadcast (${r.vsize} vB)` : `parent tx ${(r.txid ?? '?').slice(0, 16)}… from ${url}: NOT broadcast, the node refused it: ${r.reason}`); } catch (e) { log(`parent tx from ${url}: ${e.message}`); } } }); }
  // SPEC 6.2: the desk
  const desk = chain.pledge && parent ? { policy: chain.pledge, cbFile: `${dir}/coinbases.json`, plFile: `${dir}/pledges.json`, coinbases: [], pledges: {}, k: await loadParentKernel(chain) } : null;
  if (desk) { try { desk.coinbases = JSON.parse(await readFile(desk.cbFile, 'utf8')).coinbases ?? []; } catch {} try { desk.pledges = JSON.parse(await readFile(desk.plFile, 'utf8')).pledges ?? {}; } catch {} }
  const saveDesk = async () => { if (!desk) return; await writeFile(desk.cbFile, JSON.stringify({ chain: chain.id, lockedFrom: desk.policy.lockedFrom, maturity: desk.policy.maturity, updated: Math.floor(Date.now() / 1000), coinbases: desk.coinbases })); await writeFile(desk.plFile, JSON.stringify({ chain: chain.id, rate: desk.policy.rate, pledges: desk.pledges }, null, 1)); };
  const pledgedByPayTxid = () => new Map(Object.values(desk?.pledges ?? {}).map((p) => [p.payTxid, p]));
  const savePegs = () => writeFile(pegFile, JSON.stringify(pegState, null, 1)); let scanning = false;
  const pegTick = async () => {
    if (!parent || scanning) return; scanning = true;
    try {
      const tip = await parent.height();
      if (tip > pegState.scanned) {
        const found = await scanPegins(parent, { chainId: chain.id, from: pegState.scanned + 1, to: tip, pegScript, onCoinbase: desk ? (c) => { if (c.height >= desk.policy.lockedFrom && !desk.coinbases.some((x) => x.txid === c.txid && x.vout === c.vout)) desk.coinbases.push(c); } : null });
        if (desk) await saveDesk();
        for (const p of newPegins(found, pegState.pegins, (txid) => s.claimedTx(txid))) { pegState.pegins.push(p); log(`peg-in ${p.txid.slice(0, 16)}…:${p.vout}: ${p.amount} sats to ${p.script.slice(0, 12)}…, parent h${p.height}`); }
        pegState.scanned = tip; await savePegs();
      }
      // unclaimed peg-ins are locked in the peg wallet so no payment of ours spends them before the claim
      await lockOutputs(parent, pegState.pegins.filter((p) => !p.refused && !s.claimed(p.txid, p.vout)), true);
      await lockOutputs(parent, pegState.pegins.filter((p) => s.claimed(p.txid, p.vout)), false); // a claim sealed by the round (level 2) unlocks here too, not only after our own produce()
      const claims = [], need = chain.pegConfirmations ?? 6;
      for (const p of pegState.pegins) {
        if (p.refused || s.claimed(p.txid, p.vout)) continue;
        if (s.claimedTx(p.txid)) { p.refused = 'another output of this transaction is claimed'; log(`peg-in ${p.txid.slice(0, 16)}…:${p.vout}: another output of it is claimed already; not claimable`); continue; }
        const st = await pegStatus(parent, p); if (!st.unspent) { p.refused = 'spent on the parent'; log(`peg-in ${p.txid.slice(0, 16)}…:${p.vout} is spent on the parent; not claimable`); continue; }
        // a pledged reward arriving at maturity was paid for already: it is claimed to the float, not to the marker's payee
        const pledged = desk ? pledgedByPayTxid().get(p.txid) : null;
        if (st.confirmations >= need) claims.push({ txid: p.txid, vout: p.vout, amount: p.amount, script: pledged ? chain.challenge : p.script });
      }
      if (fed) round.wantClaims(claims); // empty included: a claim sealed by another signer must leave the list, or every proposal of ours throws
      else if (claims.length) { const r = await s.produce(key, { claims }); last = Date.now(); await lockOutputs(parent, claims, false); log(`block ${r.height} ${r.hash.slice(0, 16)}… claims ${claims.length} peg-in(s): ${claims.map((c) => `${c.amount} sats to ${c.script.slice(0, 12)}…`).join(', ')}`); await savePegs(); }
    } catch (e) { log(`parent: ${e.message}`); } finally { scanning = false; }
  };
  if (parent) { log(`parent ${args['parent-rpc']}: peg-ins for ${chain.id} from h${pegState.scanned + 1}, claim at ${chain.pegConfirmations ?? 6} confirmations`); setInterval(pegTick, Number(args['parent-poll'] ?? 60) * 1000); pegTick(); }
  // the desk: pledges arrive as kind 33502 events (content: the pre-signed maturity transaction, d = outpoint)
  if (desk) {
    log(`desk: ${(desk.policy.rate * 100).toFixed(0)}% now for rewards locked from ${desk.policy.lockedFrom} until ${desk.policy.maturity}; ${Object.keys(desk.pledges).length} pledge(s) so far, ${desk.coinbases.length} locked coinbase output(s) known${desk.policy.paused ? ' · PAUSED: no pledges accepted' : ''}`);
    let pledging = Promise.resolve();
    const onPledge = (ev, url) => { pledging = pledging.then(async () => {
      const d = ev.tags.find((t) => t[0] === 'd')?.[1] ?? ''; const [ptxid, pvout] = d.split(':'); if (!/^[0-9a-f]{64}$/.test(ptxid ?? '') || !/^\d+$/.test(pvout ?? '')) return;
      if (desk.pledges[d]) return; // one payment per reward, ever
      if (desk.policy.paused) return log(`pledge ${d.slice(0, 16)}… from ${url}: the desk is paused (${desk.policy.pausedNote ?? 'see chain.json'})`);
      const o = await parent.rpc('gettxout', [ptxid, Number(pvout), true]); const tip = await parent.height();
      const prevout = o ? { value: Math.round(o.value * 1e8), script: o.scriptPubKey.hex, coinbase: !!o.coinbase, height: tip - o.confirmations + 1 } : null;
      const v = verifyPledge({ k: desk.k, hex: String(ev.content ?? '').trim(), chain, prevout, parentTip: tip });
      if (!v.ok) return log(`pledge ${d.slice(0, 16)}… from ${url}: refused, ${v.error}`);
      const spendable = s.coins(chain.challenge).filter((c) => !c.coinbase || s.height() + 1 - c.height >= s.k.params.coinbaseMaturity).reduce((a, c) => a + c.value, 0);
      if (v.pays + 2000 > spendable) return log(`pledge ${d.slice(0, 16)}…: the float has ${spendable} sats, ${v.pays} needed; not paid (try later)`);
      const b = await buildSpend({ engine, chain, signer, key, url: `http://127.0.0.1:${args.port ?? 3450}`, to: v.payee, amount: v.pays }); const r = await s.submit(b.hex);
      desk.pledges[d] = { txid: ptxid, vout: Number(pvout), amount: v.amount, payee: v.payee, paid: v.pays, paidTxid: r.txid, payTxid: v.txid, hex: String(ev.content).trim(), maturity: v.maturity, at: Math.floor(Date.now() / 1000), event: ev.id, broadcast: null };
      await saveDesk(); log(`pledge ${d.slice(0, 16)}…: ${v.amount} sats locked until ${v.maturity}; paid ${v.pays} sats to ${v.payee.slice(0, 12)}… in ${r.txid.slice(0, 16)}…`);
    }).catch((e) => log(`pledge: ${e.message}`)); };
    subscribe({ relays, chainId: chain.id, verify: engine.nostr.verifyNostrEvent, log, onEvent: onPledge, kind: PLEDGE_KIND, since: 30 * 86400 });
    // at maturity, every pledge is broadcast; the scanner then sees it as a peg-in and claims it to the float
    const matureTick = async () => { try { const tip = await parent.height(); for (const [d, p] of Object.entries(desk.pledges)) { if (p.broadcast || tip < p.maturity) continue; try { const txid = await parent.rpc('sendrawtransaction', [p.hex]); p.broadcast = { txid, at: Math.floor(Date.now() / 1000) }; log(`pledge ${d.slice(0, 16)}… matured: broadcast ${txid.slice(0, 16)}…`); } catch (e) { p.broadcastError = e.message; log(`pledge ${d.slice(0, 16)}… matured but could not broadcast: ${e.message}`); } } await saveDesk(); } catch (e) { log(`desk: ${e.message}`); } };
    setInterval(matureTick, 600000); setTimeout(matureTick, 20000);
  }
  // SPEC 7: every burn the chain validated is paid on the parent from the peg wallet, once. The
  // record is <dir>/pegouts.json, reconciled on start with the wallet's own history so a crash
  // between paying and recording cannot pay twice.
  const outFile = `${dir}/pegouts.json`; let outState = { paid: {} }; let paying = false;
  try { outState = JSON.parse(await readFile(outFile, 'utf8')); } catch { await writeFile(outFile, JSON.stringify(outState, null, 1)); } // present from the start, so a mirror can carry it
  const pegoutTick = async () => {
    if (!parent?.walletRpc || paying) return; paying = true;
    try {
      const due = s.pegouts().filter((b) => !outState.paid[`${b.txid}:${b.vout}`]); if (!due.length) return;
      const already = await paidPegouts(parent, { chainId: chain.id });
      for (const b of due) { const key = `${b.txid}:${b.vout}`;
        if (already.has(b.txid)) { outState.paid[key] = { parentTxid: already.get(b.txid), value: b.value, script: b.script, height: b.height, at: Math.floor(Date.now() / 1000), reconciled: true }; log(`peg-out ${key.slice(0, 16)}… was already paid on the parent in ${already.get(b.txid).slice(0, 16)}…`); continue; }
        const r = await payPegout(parent, { chainId: chain.id, txid: b.txid, script: b.script, value: b.value });
        outState.paid[key] = { parentTxid: r.parentTxid, address: r.address, value: b.value, script: b.script, height: b.height, at: Math.floor(Date.now() / 1000) };
        await writeFile(outFile, JSON.stringify(outState, null, 1)); log(`peg-out ${key.slice(0, 16)}…: paid ${b.value} sats to ${r.address} on the parent, txid ${r.parentTxid.slice(0, 16)}…`); }
      await writeFile(outFile, JSON.stringify(outState, null, 1));
    } catch (e) { log(`peg-out: ${e.message}`); } finally { paying = false; }
  };
  const pegoutRound = fed && parent?.walletRpc ? makePegoutRound({ parent, fed, pub, key, chain, s, relays: String(args.relay ?? '').split(',').map((x) => x.trim()).filter(Boolean), events: mkEvents({ signer, hash: engine.hash }), publish, subscribe, log, proposeAfter: Number(args['propose-after'] ?? 30), outState, save: () => writeFile(outFile, JSON.stringify(outState, null, 1)), verifyEvent: engine.nostr.verifyNostrEvent }) : null;
  const reconcile = async () => { try { const already = await paidPegouts(parent, { chainId: chain.id }); let changed = false; for (const b of s.pegouts()) { const k = `${b.txid}:${b.vout}`; if (!outState.paid[k] && already.has(b.txid)) { outState.paid[k] = { parentTxid: already.get(b.txid), value: b.value, script: b.script, height: b.height, at: Math.floor(Date.now() / 1000), reconciled: true }; changed = true; log(`peg-out ${k.slice(0, 16)}… was paid by the federation in ${already.get(b.txid).slice(0, 16)}…`); } } if (changed) await writeFile(outFile, JSON.stringify(outState, null, 1)); } catch (e) { log(`peg-out reconcile: ${e.message}`); } };
  if (pegoutRound) { log(`parent wallet ${parent.wallet}: peg-outs for ${chain.id} are paid by the federation's PSBT round (${fed.threshold} of ${fed.signers.length}), ${Object.keys(outState.paid).length} paid so far`); setInterval(() => { reconcile().then(() => pegoutRound.tick()).catch((e) => log(`peg-out round: ${e.message}`)); }, Number(args['parent-poll'] ?? 60) * 1000); setTimeout(() => reconcile().then(() => pegoutRound.tick()), 8000); }
  else if (parent?.walletRpc) { log(`parent wallet ${parent.wallet}: peg-outs for ${chain.id} are paid from it, ${Object.keys(outState.paid).length} paid so far`); setInterval(pegoutTick, Number(args['parent-poll'] ?? 60) * 1000); setTimeout(pegoutTick, 5000); }
  else if (parent) log('no --parent-wallet: peg-outs are recorded but not paid');
  // SPEC 11: checkpoints — the tip into the parent every N blocks, one OP_RETURN from the peg wallet
  const ckptEvery = Number(args['checkpoint-every'] ?? 0); const ckFile = `${dir}/checkpoints.json`;
  const ckParent = args['checkpoint-wallet'] && parent ? await makeParent({ url: args['parent-rpc'], cookieFile: args['parent-cookie'] ?? `${homedir()}/.bitcoin/.cookie`, wallet: args['checkpoint-wallet'] }) : parent; let ck = { chain: chain.id, every: ckptEvery, checkpoints: [] }; let checkpointing = false;
  try { ck = JSON.parse(await readFile(ckFile, 'utf8')); ck.every = ckptEvery; } catch {}
  const saveCk = () => writeFile(ckFile, JSON.stringify(ck, null, 1));
  const checkpointTick = async () => {
    if (!ckParent?.walletRpc || !ckptEvery || checkpointing) return; checkpointing = true;
    try {
      const tip = s.tip(); const last = ck.checkpoints.at(-1);
      if (!last || tip.height - last.height >= ckptEvery) {
        const already = await sentCheckpoints(ckParent, { chainId: chain.id }); const key = `${tip.height}:${tip.hash}`;
        const parentTxid = already.get(key) ?? (await sendCheckpoint(ckParent, { chainId: chain.id, height: tip.height, hash: tip.hash })).parentTxid;
        ck.checkpoints.push({ height: tip.height, hash: tip.hash, parentTxid, at: Math.floor(Date.now() / 1000), parentHeight: null, confirmations: 0 }); await saveCk();
        log(`checkpoint ${tip.height} ${tip.hash.slice(0, 16)}… written to the parent in ${parentTxid.slice(0, 16)}…${already.has(key) ? ' (found in the wallet history)' : ''}`);
      }
      // where the recent ones sit on the parent now
      let changed = false; for (const c of ck.checkpoints.slice(-20)) { if (c.confirmations >= 6) continue; const st = await checkpointStatus(ckParent, c.parentTxid); if (st.parentHeight !== c.parentHeight || st.confirmations !== c.confirmations) { Object.assign(c, { parentHeight: st.parentHeight, parentBlock: st.parentBlock, parentTime: st.time, confirmations: st.confirmations }); changed = true; } }
      if (changed) await saveCk();
    } catch (e) { log(`checkpoint: ${e.message}`); } finally { checkpointing = false; }
  };
  if (ckParent?.walletRpc && ckptEvery) { log(`checkpoints: every ${ckptEvery} block(s) into the parent from ${ckParent.wallet}; ${ck.checkpoints.length} so far${ck.checkpoints.length ? `, last at ${ck.checkpoints.at(-1).height}` : ''}`); setInterval(checkpointTick, 30000); setTimeout(checkpointTick, 8000); }
  // the evm rule's JSON-RPC: raw Ethereum transactions are wrapped in a carrier the signer's coins pay for
  const carrier = async (spk) => {
    const me = '5120' + pub; const rate = s.minFeeRate(); const coins = s.coins(me).filter((c) => (!c.coinbase || s.height() + 1 - c.height >= s.k.params.coinbaseMaturity) && !s.mempoolSpent.has(c.outpoint)).sort((a, b) => b.value - a.value);
    const c = coins[0]; if (!c) throw new Error('the signer has no spendable coin to carry it');
    const [txid, vout] = c.outpoint.split(':'); const lay = (fee) => [{ value: 0, scriptPubKey: spk }, { value: c.value - fee, scriptPubKey: me }];
    const tx = { version: 2, inputs: [{ prevout: { txid, vout: Number(vout) }, scriptSig: '', sequence: 0xfffffffd }], outputs: lay(0), lockTime: 0, witness: [] };
    const sized = { ...tx, witness: [['00'.repeat(65)]] }; const fee = Math.ceil(Math.ceil(engine.k.codec.txWeight(sized) / 4) * rate); tx.outputs = lay(fee);
    signKeyPath({ k: engine.k, hash: engine.hash, signer }, tx, [{ value: c.value, scriptPubKey: me }], key); // sighash by the parent's family
    return s.submit(engine.k.codec.encodeHex('Transaction', tx));
  };
  const evmRpc = engine.rules?.evm ? makeEvmRpc({ s, chain, evm: engine.rules.evm, carrier, log }) : null; if (evmRpc) log(`evm: chain id ${engine.rules.evm.chainId}, JSON-RPC at POST /evm, 1 sat = 1 gwei, reserve ${engine.rules.evm.reserve.slice(0, 12)}…`);
  const port = Number(args.port ?? 3450);
  http.createServer(async (req, res) => {
    const path = req.url.split('?')[0]; const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'range, content-type, if-none-match', 'access-control-expose-headers': 'etag, accept-ranges, content-range', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(o)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (evmRpc && path === '/evm' && req.method === 'POST') { let body = ''; for await (const c of req) { body += c; if (body.length > 1048576) { req.destroy(); return json(413, { error: 'too large' }); } } let parsed; try { parsed = JSON.parse(body); } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); } return json(200, await evmRpc(parsed)); }
    if (path === '/pegouts.json') return json(200, outState);
    if (path === '/checkpoints.json') return json(200, ck);
    if (desk && path === '/coinbases.json') return json(200, { chain: chain.id, lockedFrom: desk.policy.lockedFrom, maturity: desk.policy.maturity, coinbases: desk.coinbases });
    if (desk && path === '/pledges.json') return json(200, { chain: chain.id, rate: desk.policy.rate, pledges: desk.pledges });
    if (path === '/' || path === '/status.json') return json(200, { chain: chain.id, parent: chain.parent, ...s.tip(), coins: s.utxo.size, mempool: s.mempool.size, rejected: s.rejected.size, minFeeRate: s.minFeeRate(), relays, announce: mirrors.length ? { mirrors, announced } : null, pegouts: { burned: s.pegouts().length, paid: Object.keys(outState.paid).length, min: s.pegoutMin(), payer: parent?.wallet ?? null }, checkpoints: ckptEvery ? { every: ckptEvery, count: ck.checkpoints.length, last: ck.checkpoints.at(-1) ?? null } : null, desk: desk ? { rate: desk.policy.rate, maturity: desk.policy.maturity, coinbases: desk.coinbases.length, pledges: Object.keys(desk.pledges).length, paid: Object.values(desk.pledges).reduce((a, p) => a + p.paid, 0) } : null, pegins: parent ? { scanned: pegState.scanned, known: pegState.pegins.length, claimed: pegState.pegins.filter((p) => s.claimed(p.txid, p.vout)).length, pending: pegState.pegins.filter((p) => !p.refused && !s.claimed(p.txid, p.vout)).length } : null, signer: pub, genesis: s.genesisHash, interval: interval / 1000 });
    if (path === '/chain.json') return json(200, { ...chain, genesisHash: s.genesisHash });
    if (path === '/tip') return json(200, s.tip());
    if (path === '/blocks.json') { // the index changes only with a block: an ETag of the tip lets a client's refresh cost a 304
      const tag = `"${s.index.to}-${(s.index.blocks.at(-1)?.hash ?? '').slice(0, 16)}"`; if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag, ...cors }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', etag: tag, ...cors }); return res.end(JSON.stringify(s.index)); }
    if (path === '/blocks.dat') {
      const size = statSync(s.dat).size; const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? ''); const start = m ? Number(m[1]) : 0, end = m && m[2] ? Number(m[2]) : size - 1;
      res.writeHead(m ? 206 : 200, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}), ...cors });
      return createReadStream(s.dat, { start, end }).pipe(res);
    }
    if (path.startsWith('/coins/')) return json(200, s.coins(path.slice(7).toLowerCase()));
    if (path === '/tx' && req.method === 'POST') { let body = ''; for await (const c of req) { body += c; if (body.length > 262144) { req.destroy(); return json(413, { error: 'transaction over 256 KB' }); } } try { const r = await s.submit(body.trim()); log(`tx ${r.txid.slice(0, 16)}… accepted, fee ${r.fee}`); return json(200, r); } catch (e) { return json(400, { error: e.message }); } }
    json(404, { error: 'not found' });
  }).listen(port, '127.0.0.1', () => log(`producer on http://127.0.0.1:${port}/ every ${interval / 1000} s (${txInterval / 1000} s with transactions)`));
}

if (cmd === 'sync') {
  const base = args.url.replace(/\/$/, '');
  const remote = JSON.parse(await readFile(chainFile, 'utf8'));
  const s = await new Siding({ engine, chain: remote, dir, signer, log }).open(existsSync(`${dir}/blocks.json`) ? null : await loadKey(keyPath, { signer }).catch(() => null));
  const index = await (await fetch(`${base}/blocks.json`)).json();
  let n = 0;
  for (const e of index.blocks) {
    if (e.height <= s.height()) { if (s.node.chain[e.height] !== e.hash) throw new Error(`disagree at ${e.height}: ours ${s.node.chain[e.height]} theirs ${e.hash}`); continue; }
    const bytes = new Uint8Array(await (await fetch(`${base}/blocks.dat`, { headers: { range: `bytes=${e.offset + 8}-${e.offset + 8 + e.size - 1}` } })).arrayBuffer());
    await s.addBlock(Buffer.from(bytes).toString('hex'), e.hash); n++;
  }
  console.log(JSON.stringify({ synced: n, height: s.height(), tip: s.tip().hash, coins: s.utxo.size, agree: true }, null, 1)); process.exit(0);
}

if (cmd === 'send') {
  // spend this key's mature coins as the producer reports them; the fee from size unless --fee
  const key = await loadKey(keyPath, { signer }); const relays = String(args.relay ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const b = await buildSpend({ engine, chain, signer, key, url: args.url ?? 'http://127.0.0.1:3450', to: args.to, amount: args.amount, fee: args.fee != null ? Number(args.fee) : null, pegout: !!args.pegout, evmDeposit: !!args.evm });
  if (b.note) console.error(`note: ${b.note}`);
  const d = await deliver({ engine, chain, signer, hex: b.hex, relays, url: args.url ?? 'http://127.0.0.1:3450' });
  console.log(JSON.stringify({ txid: b.txid, ...d, inputs: b.inputs, amount: b.amount, fee: b.fee, vsize: b.vsize }, null, 1)); process.exit(d.error ? 1 : 0);
}
if (cmd === 'faucet') {
  // SPEC 11: a kind 23501 event asks for coins at the address in its content; pay it from this key,
  // once per address per --per-address-hours, at most --per-hour payouts an hour. State on disk.
  const key = await loadKey(keyPath, { signer }); const me = signer.pubkeyOf(key); const url = args.url ?? 'http://127.0.0.1:3450';
  const relays = String(args.relay ?? '').split(',').map((x) => x.trim()).filter(Boolean); if (!relays.length) throw new Error('--relay is needed: the faucet listens on relays');
  const amount = Number(args.amount ?? 100000), perAddressMs = Number(args['per-address-hours'] ?? 24) * 3600e3, perHour = Number(args['per-hour'] ?? 20);
  const stateFile = args.state ?? `${args.dir ?? `${homedir()}/.sidestr/${chain.name}`}/faucet.json`; let state = { paid: {}, recent: [] };
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch {}
  const save = () => writeFile(stateFile, JSON.stringify(state, null, 1));
  log(`faucet for ${chain.id}: ${amount} sats per request, ${perHour}/h, one per address per ${perAddressMs / 3600e3} h; key ${me.slice(0, 12)}…, coins from ${url}`);
  let busy = Promise.resolve();
  subscribe({ relays, chainId: chain.id, kind: FAUCET_KIND, verify: engine.nostr.verifyNostrEvent, log, onEvent: (ev, from) => { busy = busy.then(async () => {
    let dest; try { dest = resolveTo(String(ev.content ?? '').trim(), engine.k.params.bech32Hrp); } catch (e) { return log(`request ${ev.id.slice(0, 8)}… ignored: ${e.message}`); }
    const now = Date.now(); state.recent = (state.recent ?? []).filter((t) => now - t < 3600e3);
    const last = state.paid[dest.script]; if (last && now - last < perAddressMs) return log(`request ${ev.id.slice(0, 8)}… for ${dest.script.slice(0, 12)}… refused: paid ${Math.round((now - last) / 60e3)} min ago`);
    if (state.recent.length >= perHour) return log(`request ${ev.id.slice(0, 8)}… refused: ${perHour} payouts already this hour`);
    try {
      const b = await buildSpend({ engine, chain, signer, key, url, to: dest.script, amount }); const d = await deliver({ engine, chain, signer, hex: b.hex, relays, url });
      if (d.error) return log(`request ${ev.id.slice(0, 8)}…: could not deliver: ${d.error}`);
      state.paid[dest.script] = now; state.recent.push(now); await save();
      log(`paid ${amount} sats to ${dest.script.slice(0, 12)}… (${scriptToAddress(dest.script, engine.k.params.bech32Hrp)}) tx ${b.txid.slice(0, 16)}… via ${d.via}, request ${ev.id.slice(0, 8)}… from ${from}`);
    } catch (e) { log(`request ${ev.id.slice(0, 8)}…: ${e.message}`); }
  }).catch((e) => log(`faucet: ${e.message}`)); } });
}
if (!['key', 'genesis', 'produce', 'sync', 'send', 'faucet'].includes(cmd)) { console.error('siding key|genesis|produce|sync|send|faucet'); process.exit(2); }
