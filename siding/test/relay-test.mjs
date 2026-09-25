// The relay module keeps one socket per relay per process, shared by subscriptions and publishes, and closes
// it when nothing uses it. Live, against public relays; publishes one ephemeral event (kind 29999) nobody follows.
//   node test/relay-test.mjs
import { subscribe, publish, sockets, makeEvents } from '../lib/relay.mjs'; import { makeSigner } from '../lib/sign.mjs';
const hash = await import(`${process.env.SCHEMA ?? process.env.HOME + '/bitcoin-desktop/schema'}/codec/hash.js`); const secp = await import(`${process.env.SCHEMA ?? process.env.HOME + '/bitcoin-desktop/schema'}/codec/secp256k1.js`);
const relays = ['wss://nos.lol', 'wss://nostr.mom', 'wss://nostr.oxtr.dev', 'wss://relay.primal.net']; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const verify = () => true; const a = subscribe({ relays, chainId: 'sidestr:test', kind: 23500, verify, onEvent: () => {} }); const b = subscribe({ relays, chainId: 'sidestr:test', kind: 23501, verify, onEvent: () => {} });
await sleep(4000); const s1 = sockets();
t('two subscriptions on four relays share four sockets, not eight', s1.size === relays.length && [...s1.values()].filter(Boolean).length >= 2);
const signer = makeSigner({ hash, secp }); const ev = makeEvents({ signer, hash }).signEvent(signer.randomKey(), { kind: 29999, tags: [['chain', 'sidestr:test']], content: 'relay-test' });
const r = await publish({ relays, event: ev }); const s2 = sockets();
t('a publish rides the same sockets and gets an OK from at least one relay', Object.values(r).some((x) => x === 'ok') && s2.size === relays.length);
a.close(); b.close(); await sleep(3500); const s3 = sockets();
t('with the subscriptions closed and nothing pending, the sockets close themselves', s3.size === 0);
const r2 = await publish({ relays: relays.slice(0, 2), event: { ...ev, id: ev.id } }); await sleep(3500);
t('a one-shot publish opens, answers, and closes again (a command can exit)', Object.keys(r2).length === 2 && sockets().size === 0);
console.log(`${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
