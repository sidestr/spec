// The engine (bitcoin-desktop/schema) with the Knots BLAKE2b overlay and the sidestr overlay for
// one chain document. SCHEMA points at a checkout; BLAKETESTNODE at bitcoin-blake/blaketestnode.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { sidestrOverlay } from './overlay.mjs';
import { rulesFor } from './overlays/index.mjs';
import { resolveParent } from './parents.mjs';

export const SCHEMA = process.env.SCHEMA ?? `${homedir()}/bitcoin-desktop/schema`;
export const BLAKETESTNODE = process.env.BLAKETESTNODE ?? `${homedir()}/remote/github.com/bitcoin-blake/blaketestnode`;

export async function loadParentKernel(chain) { const { parentKernel } = await import('./pledge.mjs'); return parentKernel({ cdn: SCHEMA, parent: chain.parent, loadJson: async (u) => JSON.parse(await readFile(u, 'utf8')) }); }

export async function loadEngine(chain) {
  const parent = resolveParent(chain.parent); // the header format and proof of work follow the parent (SPEC 3)
  const { createKernel } = await import(`${SCHEMA}/codec/kernel.js`);
  const [pow, hash, secp, nostr] = await Promise.all([import(parent.family === 'blake2b' ? `${SCHEMA}/codec/pow/knots-header-v2.js` : `${SCHEMA}/codec/pow/sha256d.js`).catch((e) => { if (parent.family === 'blake2b') throw e; return null; }), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${SCHEMA}/codec/nostr.js`)]);
  const load = async (p) => JSON.parse(await readFile(`${SCHEMA}/${p}`, 'utf8'));
  const sidestr = sidestrOverlay(chain, { hash, secp }); const rules = rulesFor(chain, { hash }); const overlays = [sidestr, ...rules.overlays];
  if (parent.family === 'blake2b') { const { knotsBlake2b } = await import(`${SCHEMA}/codec/overlays/knots-blake2b.js`); overlays.unshift(knotsBlake2b(await load('schema/overlays/knots-blake2b.jsonld'))); }
  const k = createKernel({ core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), script: await load('schema/script.jsonld'),
    chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'), network: chain.id, overlays });
  if (rules.evm) await rules.evm.init(); // ethereumjs loads lazily; a chain without the rule never pays for it
  return { k, pow, hash, secp, nostr, sidestr, rules, parent };
}
