// The signer's tip announcement (SPEC 11): a NIP-333 event, kind 33333, addressable by `d` =
// chain id, content the last twelve headers, `u` tags naming mirrors that serve the block file.
// A client that knows only a chain id asks a relay for this, takes a mirror from it, reads that
// mirror's chain.json, and accepts the mirror when the document's signer is the event's author.
// A mirror is then held to the announcement: same tip hash, or it is behind or lying. The `t` =
// sidestr tag is what a directory filters on: relays index single-letter tags only.
// Pure: browsers and Node alike. WebSocket is the platform's.
export const TIP_KIND = 33333, TIP_HEADERS = 12;
// a header's hex width follows the chain's parent (SPEC 3): 328 for the 164-byte v2 header beside a
// BLAKE2b parent, 160 for the 80-byte stock header beside Bitcoin. An announcement carries at most
// TIP_HEADERS headers, and no multiple of 160 up to 12 headers is a multiple of 328, so the width is
// read from the content's length without knowing the parent
export const HEADER_HEX = [328, 160];
// at most TIP_HEADERS headers of hex: the disambiguation above holds only within that bound, and relay content is untrusted
export const headerWidth = (content) => { if (!content.length || !/^[0-9a-f]+$/i.test(content)) return null; const w = HEADER_HEX.find((x) => content.length % x === 0); return w && content.length / w <= TIP_HEADERS ? w : null; };

// pegScript: the parent output script a peg-in pays (SPEC 6), announced by the signer so a wallet can build one without asking anyone; the newest announcement wins, so it can rotate
export function tipEvent({ events, key, chainId, headersHex, tip, mirrors = [], pegScript = null }) {
  const start = tip - headersHex.length + 1; if (pegScript != null && !/^([0-9a-f]{2}){2,80}$/i.test(pegScript)) throw new Error('pegScript is a script of 2 to 80 bytes as hex');
  return events.signEvent(key, { kind: TIP_KIND, tags: [['d', chainId], ['n', chainId], ['t', 'sidestr'], ['tip', String(tip)], ['alt', `sidestr headers ${start}-${tip} of ${chainId}`], ...mirrors.map((u) => ['u', u, 'mirror']), ...(pegScript ? [['peg', pegScript.toLowerCase()]] : [])], content: headersHex.join('') });
}
export function parseTip(ev) {
  const tag = (n) => (ev.tags ?? []).filter((t) => t[0] === n).map((t) => t[1]);
  const tip = Number(tag('tip')[0]); const content = String(ev.content ?? ''); const w = headerWidth(content); if (!Number.isInteger(tip) || !w) return null;
  return { chainId: tag('d')[0], tip, mirrors: tag('u').map((u) => String(u).replace(/\/+$/, '')), headersHex: content.match(new RegExp(`.{${w}}`, 'g')) ?? [], headerBytes: w / 2, pegScript: (() => { const p = tag('peg')[0]; return p && /^([0-9a-f]{2}){2,80}$/i.test(p) ? p.toLowerCase() : null; })(), pubkey: ev.pubkey, created_at: ev.created_at, id: ev.id };
}

// the newest announcement for a chain, from any of the relays, within `timeout` ms
export function fetchLatestTip({ relays, chainId, verify = () => true, signer, timeout = 6000 }) {
  return new Promise((resolve) => {
    let best = null, open = relays.length; const done = () => { if (--open <= 0) finish(); }; const finish = () => { clearTimeout(t); resolve(best); };
    const t = setTimeout(finish, timeout);
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

// Resolve a chain id to a mirror the chain's own signer vouches for: the announcement's author
// must be the signer named in the mirror's chain.json. Returns { mirror, tip, chain }. A chain id
// is a name, not a proof: with only the id, the newest announcement wins, so a client shows the
// signer it ended up with; one that already knows the signer passes it and takes no other's.
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
