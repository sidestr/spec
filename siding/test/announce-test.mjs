// The tip announcement without a relay: build, verify, parse; choose a mirror by its signer;
// judge a mirror against the announcement. `--live` also asks the relays for the real chain.
//   node test/announce-test.mjs [--live]
import fs from 'node:fs';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { makeEvents } from '../lib/relay.mjs';
import { tipEvent, parseTip, chooseMirror, judgeMirror, fetchLatestTip, TIP_KIND } from '../lib/announce.mjs';
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
if (process.argv.includes('--live')) {
  const relays = ['wss://nos.lol', 'wss://relay.damus.io']; const live = await fetchLatestTip({ relays, chainId: chain.id, verify: e.nostr.verifyNostrEvent, signer: chain.signer });
  t(`the relays hold an announcement from the chain's signer (tip ${live?.tip}, ${live?.mirrors.length} mirror(s))`, !!live && live.pubkey === chain.signer && live.mirrors.length > 0);
}
process.exit();
