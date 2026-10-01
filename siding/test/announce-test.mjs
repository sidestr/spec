// The tip announcement without a relay: build, verify, parse; choose a mirror by its signer;
// judge a mirror against the announcement. `--live` also asks the relays for the real chain.
//   node test/announce-test.mjs [--live]
import fs from 'node:fs';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { makeEvents } from '../lib/relay.mjs';
import { tipEvent, parseTip, chooseMirror, judgeMirror, fetchLatestTip, TIP_KIND, CHAIN_KIND, chainEvent, parseChainEvent, resolveChain } from '../lib/announce.mjs';
const t = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) process.exitCode = 1; };
const chain = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8')); const e = await loadEngine(chain);
const signer = makeSigner(e), events = makeEvents({ signer, hash: e.hash }); const key = signer.randomKey(), pub = signer.pubkeyOf(key);
const H = (i) => (i.toString(16).padStart(2, '0')).repeat(164);
const ev = tipEvent({ events, key, chainId: chain.id, headersHex: [H(1), H(2), H(3)], tip: 12, mirrors: ['https://a.example/siding/', 'https://b.example/siding'] });
t('the event is kind 33333, addressable by d = chain id, tagged t = sidestr, and verifies', ev.kind === TIP_KIND && ev.tags.some((x) => x[0] === 'd' && x[1] === chain.id) && ev.tags.some((x) => x[0] === 't' && x[1] === 'sidestr') && e.nostr.verifyNostrEvent(ev));
const p = parseTip(ev);
t('it parses back: tip, headers, mirrors without trailing slashes', p.tip === 12 && p.headersHex.length === 3 && p.headersHex[2] === H(3) && p.mirrors.join() === 'https://a.example/siding,https://b.example/siding' && p.pubkey === pub);
t('a malformed content is rejected', parseTip({ ...ev, content: 'abc' }) === null);
const S = (i) => (i.toString(16).padStart(2, '0')).repeat(80); // an 80-byte stock header, beside a Bitcoin parent
const evS = tipEvent({ events, key, chainId: 'sidestr:stock', headersHex: [S(4), S(5)], tip: 1, mirrors: ['https://c.example/siding'] });
const ps = parseTip(evS);
t('a stock-family announcement (80-byte headers) parses with the right width', !!ps && ps.headersHex.length === 2 && ps.headersHex[1] === S(5) && ps.headerBytes === 80 && p.headerBytes === 164);
const evP = tipEvent({ events, key, chainId: chain.id, headersHex: [H(9)], tip: 9, mirrors: ['https://a.example/siding'], pegScript: '5120' + 'AB'.repeat(32) }); const pp = parseTip(evP);
t('the peg script rides in the announcement (lower-cased) and parses back; absent otherwise', pp.pegScript === '5120' + 'ab'.repeat(32) && p.pegScript === null && (() => { try { tipEvent({ events, key, chainId: chain.id, headersHex: [H(9)], tip: 9, pegScript: 'zz' }); return false; } catch { return true; } })());
t('an empty content is rejected, not read as zero headers', parseTip({ ...ev, content: '' }) === null);
t('more than TIP_HEADERS headers, or non-hex content, is rejected before any slicing', parseTip({ ...ev, content: H(1).repeat(13) }) === null && parseTip({ ...ev, content: S(1).repeat(13) }) === null && parseTip({ ...ev, content: 'zz'.repeat(164) }) === null && parseTip({ ...ev, content: H(1).repeat(12) }) !== null);
const docs = { 'https://a.example/siding/chain.json': { id: chain.id, signer: 'ff'.repeat(32) }, 'https://b.example/siding/chain.json': { id: chain.id, signer: pub } };
const found = await chooseMirror({ tip: p, chainId: chain.id, fetchJson: async (u) => { if (!(u in docs)) throw new Error('404'); return docs[u]; } });
const fedDocs = { 'https://f.example/fed/chain.json': { id: 'sidestr:fed', signers: ['aa'.repeat(32), pub, 'bb'.repeat(32)] } }; const fedTip = parseTip(tipEvent({ events, key, chainId: 'sidestr:fed', headersHex: [H(1)], tip: 1, mirrors: ['https://f.example/fed'] }));
const fedFound = await chooseMirror({ tip: fedTip, chainId: 'sidestr:fed', fetchJson: async (u) => { if (!(u in fedDocs)) throw new Error('404'); return fedDocs[u]; } });
t('a level-2 document is accepted when the announcer is one of its signers', fedFound.mirror === 'https://f.example/fed');
t('the mirror whose chain.json names the announcer is chosen, the other skipped', found.mirror === 'https://b.example/siding' && found.chain.signer === pub);
let failed = null; try { await chooseMirror({ tip: p, chainId: chain.id, fetchJson: async () => ({ id: chain.id, signer: 'ee'.repeat(32) }) }); } catch (x) { failed = x.message; }
t('no mirror vouched for by the announcer -> a clear error', /no mirror it names checks out/.test(failed ?? ''));
t('a mirror at the announced tip with the announced header matches', judgeMirror({ announced: p, height: 12, headerHex: H(3) }).ok === true);
t('a mirror one block behind is behind, not wrong', (() => { const v = judgeMirror({ announced: p, height: 11, headerHex: H(2) }); return v.ok === true && /1 block\(s\) behind/.test(v.note); })());
t('a mirror with a different block at the announced height is caught', judgeMirror({ announced: p, height: 12, headerHex: H(9) }).ok === false);
t('a mirror ahead of the announcement is caught', judgeMirror({ announced: p, height: 13, headerHex: H(3) }).ok === false);
t('no announcement -> undecided, not a verdict', judgeMirror({ announced: null, height: 12, headerHex: H(3) }).ok === null);
// ---- SPEC 3 (0.0.5): the chain document as an immutable event; its id is the chain's hash
const verify = e.nostr.verifyNostrEvent;
const doc = { ...chain, signer: pub, challenge: '5120' + pub }; delete doc.genesisHash;
const cev = chainEvent({ events, key, chain: doc, created_at: 1759300000 });
t('the chain event is kind 3500, tagged n = alias and t = sidestr, carries the document without a signer field, and verifies', cev.kind === CHAIN_KIND && cev.tags.some((x) => x[0] === 'n' && x[1] === chain.id) && cev.tags.some((x) => x[0] === 't' && x[1] === 'sidestr') && !('signer' in JSON.parse(cev.content)) && JSON.parse(cev.content).challenge === doc.challenge && verify(cev));
t('the same document signed again at another time is another hash: a chain is final once signed', chainEvent({ events, key, chain: doc, created_at: 1759300001 }).id !== cev.id);
const d = parseChainEvent(cev, { verify });
t('it parses back: hash = event id, alias, pubkey, and the document with the author as its signer', d.hash === cev.id && d.alias === chain.id && d.pubkey === pub && d.chain.signer === pub && d.chain.challenge === doc.challenge);
const thrown = (f) => { try { f(); return null; } catch (x) { return x.message; } };
t('a chain event with a changed content is refused (the id is the hash of the content)', /does not verify/.test(thrown(() => parseChainEvent({ ...cev, content: cev.content.replace('5120', '5121') }, { verify })) ?? ''));
t('a document naming another signer than the author is refused; so is a level-2 document whose signers leave the author out', /other than the event/.test(thrown(() => parseChainEvent(events.signEvent(key, { kind: CHAIN_KIND, content: JSON.stringify({ ...doc, signer: 'ee'.repeat(32) }) }), { verify })) ?? '') && /not one of the document/.test(thrown(() => parseChainEvent(events.signEvent(key, { kind: CHAIN_KIND, content: JSON.stringify({ id: 'sidestr:fed', signers: ['aa'.repeat(32)] }) }), { verify })) ?? ''));
t('an alias that is not sidestr:<name> is refused when building', !!thrown(() => chainEvent({ events, key, chain: { ...doc, id: 'poker' } })));
const evE = tipEvent({ events, key, chainId: chain.id, headersHex: [H(7)], tip: 7, mirrors: ['https://a.example/siding'], chainHash: cev.id }); const pe = parseTip(evE);
t('the tip carries the chain hash as an e tag and parses it back; a tip without one gives null', pe.chainHash === cev.id && p.chainHash === null && evE.tags.some((x) => x[0] === 'e' && x[1] === cev.id));
// resolution without relays: the tip and the event injected
const byAlias = await resolveChain({ relays: [], alias: chain.id, verify, getTip: async () => pe, getEvent: async (id) => (id === cev.id ? cev : null) });
t('by alias: the newest tip names the event, the event verifies, its author is the tip\'s: hash, document, tip and mirror come back', byAlias.hash === cev.id && byAlias.chain.challenge === doc.challenge && byAlias.tip === pe && byAlias.mirror === 'https://a.example/siding' && byAlias.legacy === false);
const byHash = await resolveChain({ relays: [], hash: cev.id, verify, getTip: async () => pe, getEvent: async () => cev });
t('by hash: the event by id, then the tip by the document\'s alias', byHash.hash === cev.id && byHash.alias === chain.id && byHash.tip === pe);
const fromMirror = await resolveChain({ relays: [], alias: chain.id, verify, getTip: async () => pe, getEvent: async () => null, fetchJson: async (u) => { if (u === 'https://a.example/siding/chain-event.json') return cev; throw new Error('404'); } });
t('no relay has the event: a mirror the tip names serves chain-event.json, verified the same way', fromMirror.hash === cev.id && fromMirror.legacy === false);
const otherKey = signer.randomKey(); const otherTip = parseTip(tipEvent({ events, key: otherKey, chainId: chain.id, headersHex: [H(8)], tip: 8, mirrors: ['https://x.example'], chainHash: cev.id }));
let bad = null; try { await resolveChain({ relays: [], alias: chain.id, verify, getTip: async () => otherTip, getEvent: async () => cev }); } catch (x) { bad = x.message; }
t('a tip by someone else naming this chain event is refused: the tip\'s author must be the chain\'s signer', /not the chain's signer/.test(bad ?? ''));
bad = null; try { await resolveChain({ relays: [], hash: cev.id, verify, getTip: async () => pe, getEvent: async () => ({ ...cev, id: 'ab'.repeat(32) }) }); } catch (x) { bad = x.message; }
t('an event that is not the one asked for (or does not verify) is refused', !!bad);
bad = null; try { await resolveChain({ relays: [], alias: chain.id, verify, getTip: async () => pe, getEvent: async () => null, fetchJson: async () => { throw new Error('404'); } }); } catch (x) { bad = x.message; }
t('the event on no relay and no mirror -> a clear error', /on none of/.test(bad ?? ''));
const legacy = await resolveChain({ relays: [], alias: chain.id, verify, getTip: async () => p, fetchJson: async (u) => { if (!(u in docs)) throw new Error('404'); return docs[u]; } });
t('a tip with no e tag (a chain made before 0.0.5) resolves the old way: chain.json by its signer field, hash null, legacy true', legacy.legacy === true && legacy.hash === null && legacy.mirror === 'https://b.example/siding');
if (process.argv.includes('--live')) {
  const relays = ['wss://nos.lol', 'wss://relay.damus.io']; const live = await fetchLatestTip({ relays, chainId: chain.id, verify: e.nostr.verifyNostrEvent, signer: chain.signer });
  t(`the relays hold an announcement from the chain's signer (tip ${live?.tip}, ${live?.mirrors.length} mirror(s))`, !!live && live.pubkey === chain.signer && live.mirrors.length > 0);
}
process.exit();
