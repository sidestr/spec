// Transactions over Nostr (SPEC section 11): a signed transaction travels as a kind 23500 event
// whose content is the transaction hex and whose `chain` tag names the chain. The event's key is
// anyone's -- the transaction authorises itself -- so a wallet signs the event with a throwaway
// key and never needs an identity. Node 22+ has WebSocket built in; there is no dependency.
export const TX_KIND = 23500;
export const FAUCET_KIND = 23501; // content: an address (or script hex); a faucet may answer with a kind 23500 payment
export const PARENT_TX_KIND = 23503; // content: a signed PARENT transaction as hex; a producer with a node broadcasts it if, and only if, its node's default policy accepts it

export function makeEvents({ signer, hash }) {
  const eventId = (ev) => hash.bytesToHex(hash.sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))));
  const signEvent = (key, { kind, tags = [], content = '', created_at = Math.floor(Date.now() / 1000) }) => {
    const ev = { pubkey: signer.pubkeyOf(key), created_at, kind, tags, content }; ev.id = eventId(ev);
    ev.sig = hash.bytesToHex(signer.schnorrSign(hash.hexToBytes(ev.id), key)); return ev;
  };
  return { eventId, signEvent, txEvent: (key, chainId, hex) => signEvent(key, { kind: TX_KIND, tags: [['chain', chainId]], content: hex }), parentTxEvent: (key, chainId, hex) => signEvent(key, { kind: PARENT_TX_KIND, tags: [['chain', chainId]], content: hex }) };
}

// One socket per relay per process, shared by every subscription and publish (relays cap connections per
// address, and a producer, a faucet, a page or a bot that opened one socket per call ran into that cap). A
// socket reconnects with backoff and re-sends its subscriptions; it closes itself two seconds after the last
// subscription and publish are gone, so a one-shot command still exits.
const pool = new Map(); // url -> { ws, open, subs: Map(id -> { filter, onMessage }), waits: Map(eventId -> resolve), backoff, timer }
function socket(url) {
  let c = pool.get(url); if (c) return c;
  c = { ws: null, open: false, subs: new Map(), waits: new Map(), backoff: 1000, timer: null, closed: false };
  const connect = () => { if (c.closed) return; let ws; try { ws = new WebSocket(url); } catch { return retry(); } c.ws = ws;
    ws.onopen = () => { c.open = true; c.backoff = 1000; for (const [id, s] of c.subs) { ws.send(JSON.stringify(['REQ', id, s.filter])); s.onOpen?.(); } };
    ws.onmessage = (m) => { let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
      if (msg[0] === 'EVENT') { const s = c.subs.get(msg[1]); if (s && msg[2] && typeof msg[2] === 'object') s.onEvent(msg[2]); }
      else if (msg[0] === 'OK') { const w = c.waits.get(msg[1]); if (w) { c.waits.delete(msg[1]); w(msg[2] ? 'ok' : (msg[3] || 'rejected')); idle(); } } };
    ws.onerror = () => {}; ws.onclose = () => { c.open = false; c.ws = null; for (const [id, w] of c.waits) { c.waits.delete(id); w('closed before OK'); } if (c.subs.size || c.waits.size) retry(); else drop(); }; };
  const retry = () => { if (c.closed) return; setTimeout(connect, c.backoff); c.backoff = Math.min(c.backoff * 2, 60000); };
  const drop = () => { c.closed = true; pool.delete(url); try { c.ws?.close(); } catch {} };
  const idle = () => { clearTimeout(c.timer); if (!c.subs.size && !c.waits.size) c.timer = setTimeout(() => { if (!c.subs.size && !c.waits.size) drop(); }, 2000); };
  c.send = (frame) => { if (c.open) { try { c.ws.send(JSON.stringify(frame)); return true; } catch {} } return false; };
  c.idle = idle; pool.set(url, c); connect(); return c;
}
export const sockets = () => new Map([...pool].map(([u, c]) => [u, c.open]));
let subSeq = 0;

// A producer's side: follow one or more relays for this chain's events of one kind, reconnecting with backoff,
// and hand each verified, not-yet-seen event to onEvent. Nothing is trusted from the relay: the event
// signature is checked, then the transaction itself must validate to be included.
export function subscribe({ relays, chainId, verify, onEvent, log = () => {}, since = 3600, kind = TX_KIND, tag = 'chain' }) {
  const seen = new Set(); const id = `k${kind}-${++subSeq}`; const handles = [];
  // filter by kind only: relays index single-letter tags for filtering and refuse `#chain`
  // ("unindexed tag filter"), so the chain tag is checked here on each event instead
  const filter = { kinds: [kind], since: Math.floor(Date.now() / 1000) - since };
  for (const url of relays) { const c = socket(url); const sub = { filter, onOpen: () => log(`relay ${url}: following kind ${kind} for ${chainId}`), onEvent: (ev) => {
      if (ev.kind !== kind || typeof ev.id !== 'string' || seen.has(ev.id)) return;
      if (!Array.isArray(ev.tags) || !ev.tags.some((t) => Array.isArray(t) && t[0] === tag && t[1] === chainId)) return; // another chain's, or untagged
      seen.add(ev.id); if (seen.size > 10000) seen.delete(seen.values().next().value);
      let ok = false; try { ok = !!verify(ev); } catch {} if (!ok) return log(`relay ${url}: event ${ev.id.slice(0, 8)}… has a bad signature`);
      onEvent(ev, url); } };
    c.subs.set(id, sub); if (c.open) { c.send(['REQ', id, filter]); sub.onOpen(); } handles.push([c, url]); }
  return { relays, close() { for (const [c] of handles) { c.subs.delete(id); c.send(['CLOSE', id]); c.idle(); } } };
}

// A wallet's or the CLI's side: publish one event to each relay over the shared socket and report what each said.
export function publish({ relays, event, timeout = 8000 }) {
  return Promise.all(relays.map((url) => new Promise((resolve) => {
    const c = socket(url); let done = false; const finish = (r) => { if (done) return; done = true; clearTimeout(t); c.waits.delete(event.id); c.idle(); resolve([url, r]); };
    const t = setTimeout(() => finish('timeout'), timeout);
    c.waits.set(event.id, finish);
    const trySend = (tries) => { if (done) return; if (c.send(['EVENT', event])) return; if (c.closed) return finish('closed before OK'); if (tries > 0) setTimeout(() => trySend(tries - 1), 250); else finish('not connected'); };
    trySend(Math.ceil(timeout / 250));
  }))).then(Object.fromEntries);
}
