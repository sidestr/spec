// The chain document as an event and the signer's tip announcement (SPEC 3, 11). The document is a
// kind 3500 event, regular and immutable: its id is the chain's hash, the one name that is a proof.
// The tip is a NIP-333 event, kind 33333, addressable by `d` = the chain's alias (sidestr:<name>),
// content the last twelve headers, `u` tags naming mirrors that serve the block file, `e` = the
// chain event. A client that knows only the alias asks a relay for the newest tip, reads the chain
// event by its `e` tag (from a relay, or a mirror's chain-event.json), and accepts it when the id is
// the hash of its content, the signature is good, and the tip's author is the document's signer.
// A mirror is then held to the announcement: same tip hash, or it is behind or lying. A chain made
// before 0.0.5 has no `e`: its mirror's chain.json is accepted when its `signer` is the tip's author.
// The `t` = sidestr tag is what a directory filters on: relays index single-letter tags only.
// Pure: browsers and Node alike. WebSocket is the platform's.
export const TIP_KIND = 33333, TIP_HEADERS = 12, CHAIN_KIND = 3500;

// ---- the chain document as an event (SPEC 3): the event's pubkey is the signer, so the document
// carries no `signer` field; `signers` (level 2) stays, since it names the set. The content is the
// document as JSON; the id that results is the chain's hash. A document cannot carry its own hash,
// so inside it the chain is its alias (`id`)
export function chainEvent({ events, key, chain, created_at }) {
  if (!chain || typeof chain.id !== 'string' || !/^sidestr:[a-z0-9][a-z0-9-]*$/.test(chain.id)) throw new Error('the document names its alias in `id` (sidestr:<name>)');
  const doc = { ...chain }; delete doc.signer;
  return events.signEvent(key, { kind: CHAIN_KIND, tags: [['n', doc.id], ['t', 'sidestr'], ['alt', `sidestr chain document ${doc.id}`]], content: JSON.stringify(doc), ...(created_at ? { created_at } : {}) });
}
// a chain event read back: verified (id is the hash of the content, signature good), the document
// parsed, its publisher a signer of it. Returns { hash, alias, pubkey, chain } or throws in words
export function parseChainEvent(ev, { verify }) {
  if (!ev || ev.kind !== CHAIN_KIND) throw new Error('not a chain event (kind 3500)');
  let ok = false; try { ok = !!verify(ev); } catch {} if (!ok) throw new Error('the chain event does not verify (id or signature)');
  let chain; try { chain = JSON.parse(ev.content); } catch { throw new Error('the chain event\'s content is not JSON'); }
  if (!chain || typeof chain !== 'object' || typeof chain.id !== 'string') throw new Error('the chain event carries no document with an alias');
  if (chain.signer !== undefined && chain.signer !== ev.pubkey) throw new Error('the document names a signer other than the event\'s author');
  if (Array.isArray(chain.signers) && !chain.signers.includes(ev.pubkey)) throw new Error('the event\'s author is not one of the document\'s signers');
  return { hash: ev.id, alias: chain.id, pubkey: ev.pubkey, chain: { ...chain, signer: chain.signer ?? (Array.isArray(chain.signers) ? undefined : ev.pubkey) }, event: ev };
}
// one event by id, from any of the relays, within `timeout` ms; null if none answers
export function fetchEvent({ relays, id, timeout = 6000 }) {
  return new Promise((resolve) => {
    let found = null, open = relays.length, finished = false; const sockets = [];
    const done = () => { if (--open <= 0) finish(); };
    // the first answer ends the search: every socket is closed, the others' EOSE no longer awaited
    const finish = () => { if (finished) return; finished = true; clearTimeout(t); for (const w of sockets) { try { w.close(); } catch {} } resolve(found); };
    const t = setTimeout(finish, timeout); if (!relays.length) return finish();
    for (const url of relays) {
      let ws; try { ws = new WebSocket(url); } catch { done(); continue; } sockets.push(ws);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'ev', { ids: [id], limit: 1 }]));
      ws.onmessage = (m) => { let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
        if (msg[0] === 'EVENT' && msg[2]?.id === id) { found = found ?? msg[2]; finish(); }
        if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { try { ws.close(); } catch {} done(); } };
      ws.onerror = () => {}; ws.onclose = () => done();
    }
  });
}
// a header's hex width follows the chain's parent (SPEC 3): 328 for the 164-byte v2 header beside a
// BLAKE2b parent, 160 for the 80-byte stock header beside Bitcoin. An announcement carries at most
// TIP_HEADERS headers, and no multiple of 160 up to 12 headers is a multiple of 328, so the width is
// read from the content's length without knowing the parent
export const HEADER_HEX = [328, 160];
// at most TIP_HEADERS headers of hex: the disambiguation above holds only within that bound, and relay content is untrusted
export const headerWidth = (content) => { if (!content.length || !/^[0-9a-f]+$/i.test(content)) return null; const w = HEADER_HEX.find((x) => content.length % x === 0); return w && content.length / w <= TIP_HEADERS ? w : null; };

// pegScript: the parent output script a peg-in pays (SPEC 6), announced by the signer so a wallet can build one without asking anyone; the newest announcement wins, so it can rotate
export function tipEvent({ events, key, chainId, headersHex, tip, mirrors = [], pegScript = null, chainHash = null }) {
  if (chainHash != null && !/^[0-9a-f]{64}$/i.test(chainHash)) throw new Error('chainHash is the chain event\'s id (64 hex)');
  const start = tip - headersHex.length + 1; if (pegScript != null && !/^([0-9a-f]{2}){2,80}$/i.test(pegScript)) throw new Error('pegScript is a script of 2 to 80 bytes as hex');
  return events.signEvent(key, { kind: TIP_KIND, tags: [['d', chainId], ['n', chainId], ['t', 'sidestr'], ['tip', String(tip)], ['alt', `sidestr headers ${start}-${tip} of ${chainId}`], ...mirrors.map((u) => ['u', u, 'mirror']), ...(pegScript ? [['peg', pegScript.toLowerCase()]] : []), ...(chainHash ? [['e', chainHash.toLowerCase(), '', 'chain']] : [])], content: headersHex.join('') });
}
export function parseTip(ev) {
  const tag = (n) => (ev.tags ?? []).filter((t) => t[0] === n).map((t) => t[1]);
  const tip = Number(tag('tip')[0]); const content = String(ev.content ?? ''); const w = headerWidth(content); if (!Number.isInteger(tip) || !w) return null;
  return { chainId: tag('d')[0], tip, mirrors: tag('u').map((u) => String(u).replace(/\/+$/, '')), headersHex: content.match(new RegExp(`.{${w}}`, 'g')) ?? [], headerBytes: w / 2, pegScript: (() => { const p = tag('peg')[0]; return p && /^([0-9a-f]{2}){2,80}$/i.test(p) ? p.toLowerCase() : null; })(), pubkey: ev.pubkey, created_at: ev.created_at, id: ev.id, chainHash: (() => { const h = tag('e')[0]; return h && /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null; })() };
}

// the newest announcement for a chain, from any of the relays, within `timeout` ms
export function fetchLatestTip({ relays, chainId, verify = () => true, signer, timeout = 6000 }) {
  return new Promise((resolve) => {
    let best = null, open = relays.length; const done = () => { if (--open <= 0) finish(); }; const finish = () => { clearTimeout(t); resolve(best); };
    const t = setTimeout(finish, timeout); if (!relays.length) return finish();
    for (const url of relays) {
      let ws; try { ws = new WebSocket(url); } catch { done(); continue; }
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'tip', { kinds: [TIP_KIND], '#d': [chainId], limit: 5 }]));
      ws.onmessage = (m) => { let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
        if (msg[0] === 'EVENT' && msg[2]?.kind === TIP_KIND) { const ev = msg[2]; let ok = false; try { ok = !!verify(ev); } catch {} const p = ok && (!signer || ev.pubkey === signer) ? parseTip(ev) : null; if (p && p.chainId === chainId && (!best || p.tip > best.tip || (p.tip === best.tip && p.created_at > best.created_at))) best = { ...p, event: ev }; }
        if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { try { ws.close(); } catch {} done(); } };
      ws.onerror = () => {}; ws.onclose = () => done();
    }
  });
}

// Resolve a chain by its alias, or by its hash (SPEC 11). With a hash: the chain event by id, verified,
// and the newest tip by the document's alias, which must be by the document's signer. With only an
// alias: the newest tip; if it names a chain event (`e`), that event, from a relay or from a mirror's
// chain-event.json, verified, and its author must be the tip's; otherwise (a chain made before
// 0.0.5) the mirror's chain.json by its `signer` field. Returns { hash, chain, tip, mirror, mirrors,
// legacy }. The alias is a name, not a proof: with only it, the newest announcement wins, so a client
// shows the hash and the signer it ended up with; one that knows the hash takes no other document.
export async function resolveChain({ relays, alias = null, hash = null, verify, signer, fetchJson = async (u) => (await fetch(u, { cache: 'no-store' })).json(), getEvent = (id) => fetchEvent({ relays, id }), getTip = (a) => fetchLatestTip({ relays, chainId: a, verify, signer }) }) {
  if (hash != null && !/^[0-9a-f]{64}$/i.test(hash)) throw new Error('a chain hash is 64 hex');
  let tip = alias ? await getTip(alias) : null;
  const id = hash?.toLowerCase() ?? tip?.chainHash ?? null;
  if (!id) { if (!tip) throw new Error(`no announcement for ${alias} on ${relays.length} relay(s)`); const m = await chooseMirror({ tip, chainId: alias, fetchJson }); return { hash: null, chain: m.chain, tip, mirror: m.mirror, mirrors: tip.mirrors, legacy: true }; }
  let ev = await getEvent(id);
  if (!ev && tip) for (const m of tip.mirrors) { try { const c = await fetchJson(`${m}/chain-event.json`); if (c?.id === id) { ev = c; break; } } catch {} }
  if (!ev) throw new Error(`the chain event ${id.slice(0, 16)}… is on none of ${relays.length} relay(s)${tip ? ' or the mirrors the tip names' : ''}`);
  const d = parseChainEvent(ev, { verify }); if (d.hash !== id) throw new Error('the event found is not the one asked for');
  if (!tip) tip = await getTip(d.alias);
  if (tip && tip.pubkey !== d.pubkey && !(Array.isArray(d.chain.signers) && d.chain.signers.includes(tip.pubkey))) throw new Error(`the tip for ${d.alias} is by ${tip.pubkey.slice(0, 8)}…, not the chain's signer ${d.pubkey.slice(0, 8)}…`);
  if (tip && tip.chainHash && tip.chainHash !== id) throw new Error(`the newest tip for ${d.alias} names another chain (${tip.chainHash.slice(0, 16)}…)`);
  return { hash: id, chain: d.chain, alias: d.alias, pubkey: d.pubkey, tip, mirror: tip?.mirrors[0] ?? null, mirrors: tip?.mirrors ?? [], legacy: false };
}
// the pre-0.0.5 resolution: alias → tip → a mirror whose chain.json names the tip's author as signer
export async function findChain({ relays, chainId, verify, signer, fetchJson }) {
  const t = await fetchLatestTip({ relays, chainId, verify, signer }); if (!t) throw new Error(`no announcement for ${chainId} on ${relays.length} relay(s)`);
  return chooseMirror({ tip: t, chainId, fetchJson });
}
// a document is announced by its signer (level 1) or by any of its signers (level 2, SPEC 4)
export const announcedBy = (chain, pubkey) => chain.signer === pubkey || (Array.isArray(chain.signers) && chain.signers.includes(pubkey));
export async function chooseMirror({ tip: t, chainId, fetchJson = async (u) => (await fetch(u, { cache: 'no-store' })).json() }) {
  const tried = [];
  for (const m of t.mirrors) { try { const chain = await fetchJson(`${m}/chain.json`); if (chain.id === chainId && announcedBy(chain, t.pubkey)) return { mirror: m, tip: t, chain }; tried.push(`${m}: signer ${String(chain.signer ?? (chain.signers ?? []).join(',')).slice(0, 8)}… is not the announcer ${t.pubkey.slice(0, 8)}…`); } catch (e) { tried.push(`${m}: ${e.message}`); } }
  throw new Error(`${chainId}: announced at tip ${t.tip} by ${t.pubkey.slice(0, 8)}… but no mirror it names checks out (${tried.join('; ') || 'no mirrors named'})`);
}

// how a mirror stands against the announcement, given the mirror's tip height and that header's
// hex: matching, behind (the mirror has not caught up), or contradicting it (a different block,
// or blocks the signer never announced)
export function judgeMirror({ announced, height, headerHex }) {
  if (!announced) return { ok: null, note: 'no announcement to compare with' };
  if (height > announced.tip) return { ok: false, note: `the mirror is ahead of the signer's announcement (${height} > ${announced.tip})` };
  const i = height - (announced.tip - announced.headersHex.length + 1);
  if (i >= 0 && headerHex && headerHex !== announced.headersHex[i]) return { ok: false, note: `the mirror's block ${height} is not the one the signer announced` };
  return { ok: true, note: height < announced.tip ? `the mirror is ${announced.tip - height} block(s) behind the announcement` : `the mirror matches the signer's announcement of ${height}` };
}
