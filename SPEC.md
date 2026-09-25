# sidestr — user activated sidechains

Version: 0.0.4, draft, 24 September 2026 (0.0.3: 23 September; 0.0.2: 21 September; 0.0.1: 15 September). Written the day the first pegs were made, before
the first sidechain block. Nothing here is final. Field names, kinds and document shapes are
provisional, and the numbers in section 10 describe one test chain.

sidestr is a way to run a chain beside a Bitcoin-family chain: Bitcoin's transaction rules,
blocks that are valid because they are signed rather than because they were mined, no subsidy,
and every coin on it a coin locked on the parent. The name is the chain beside the chain, with
its blocks, tips and rules carried as documents the way [datstr](https://datstr.com/spec/)
carries shares: signed JSON that a relay can move unchanged and a browser can verify.

"User activated" is a claim about who enforces the rules. A sidestr chain has signers, and
signers decide the order of blocks. They do not decide the rules. The rules are documents with
activation heights; a node applies a rule because its operator adopted the document, and a
block that breaks an adopted rule is invalid to that node whatever signature it carries. The
signers can stall the chain. They cannot change it.

## 1. Principles

1. **Bitcoin's rules, one added, one removed.** Transactions, scripts, the UTXO set and block
   structure are the parent chain's, run by the same engine. Added: a block must carry a
   signature satisfying the chain's challenge. Removed: the subsidy.
2. **Every coin is a pegged coin.** The supply of a sidestr chain equals the coins locked in
   its pegs on the parent. Coins enter by peg-in and leave by peg-out. Nothing else mints.
3. **Users validate, signers order.** Any node, a phone in a browser included, validates every
   block and transaction in full. Signers choose which valid blocks exist and in what order,
   and nothing more.
4. **Rules are documents.** The chain's rule set is data with activation heights, signed and
   addressable, chosen by each node's operator. This is what "user activated" means here.
5. **Pegs come back without permission.** Every peg output has a refund path that returns the
   coins to whoever pegged them after a timelock, with no signer involved. A dead sidechain
   costs time, not coins.
6. **No native token.** Issued assets exist for testing and say so. The only thing called by
   the parent's coin name is backed one to one.

## 2. Roles

- **Signer**: holds a key in the challenge. Produces or co-signs blocks.
- **Producer**: assembles blocks from submitted transactions and collects signatures. A
  signer is usually its own producer; a producer need not be a signer.
- **Peg holder**: holds a key that can spend a peg output on the parent. In level 1 the signers
  and the peg holders are the same keys.
- **Validator**: any node that applies the rules. Needs no key, no hash and no permission.
- **Mirror**: serves block files and publishes tips. Anyone.

## 3. Chain

A sidestr chain is an engine network, defined by an overlay document extending the parent
chain's network:

| parameter | meaning |
|---|---|
| `parent` | the parent chain: a short alias from the table in 3.2 (`txbt4`, `btc`, `ltc`…), or a sidestr chain id for a nested chain (section 3.1) |
| `challenge` | a script; a block is valid when its signature satisfies it (section 4) |
| `powLimit` | blocks must still meet this proof of work, cheap enough for a laptop, so a block costs something without keys; no retarget |
| `subsidy` | 0 |
| `addressPrefix` | a bech32m prefix distinct from the parent's, so a parent address is never a sidechain address |
| `pegConfirmations` | parent confirmations before a peg-in may be claimed |
| `refundBlocks` | the relative timelock on every peg output's refund path |
| `genesis` | the genesis document (section 5) |

Everything the overlay does not set is inherited from the parent: header format and
proof-of-work hash, script rules, weight limits, the unified sighash where the parent has it.
A chain beside a BLAKE2b parent has the v2 header and BLAKE2b proof of work; one beside stock
Bitcoin has the stock header and SHA256d; one beside Litecoin has the stock header and scrypt.
Nothing in the document names a header format or a hash; the parent decides both. The same
goes for how a transaction is signed: beside a BLAKE2b parent an input's signature commits to the
unified sighash (hash type `0x21`), beside stock Bitcoin to BIP 341's (`0x01`); a wallet reads the
family from the chain's parent and a producer checks a transaction under that rule before it
enters the mempool, not only in a block.

### 3.1 Nesting

A parent may itself be a sidestr chain. A peg-in on a siding is the same transaction as a
peg-in on any parent (section 6), a child's document names the siding as `parent`, and the
child inherits the siding's rules as the siding inherits its parent's. Chains form a tree,
coins flow down by peg-in and back up by peg-out, and one validator checks every level with
the same engine.

Two consequences follow, and a child's document should state its depth:

- **The parent's blocks are the child's clock.** `refundBlocks` and `pegoutBlocks` count the
  parent's blocks. A parent that produces blocks only when it has transactions (section 11)
  keeps a heartbeat so that a child's refund path can ever open; a stalled parent freezes
  every refund below it.
- **Trust compounds.** A validator of a chain at depth n trusts, for ordering and for which
  pegs exist, every signer between it and the proof-of-work root. Depth is a cost, cheap for
  tests and agents, and a reason to keep value near the root.

### 3.2 Parents

A parent is named by a short alias. The alias resolves, through this table, to the parameters
a validator loads and to the block that fixes which chain is meant: the genesis, and for a fork,
the first block on the fork's side, since a fork shares its origin's genesis. A validator that
does not know an alias refuses the chain by name. The long ids the first chains used
(`btc:testnet4-blake2b`, `btc:mainnet`) are the kernel's internal parameter names, accepted as
aliases so that no running chain's document changes; new documents use the short form.

| alias | chain | genesis | fork block | headers, proof of work |
|---|---|---|---|---|
| `btc` | Bitcoin mainnet | `000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f` | — | stock, SHA256d |
| `tbtc4` | Bitcoin testnet4 | `00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043` | — | stock, SHA256d |
| `xbt` | BLAKE2b mainnet (Knots) | as `btc` | 961,640 `0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb` | v2, BLAKE2b, unified sighash |
| `txbt4` | BLAKE2b testnet4 (Knots) | as `tbtc4` | 150,308 `000000000000b9d1b7e1bb0e77215ee92c6ef7ec8f4473e23908380649e779b6` | v2, BLAKE2b, unified sighash |
| `ltc` | Litecoin mainnet | reserved | — | stock, scrypt |
| `vtc` | Vertcoin mainnet | reserved | — | stock, verthash |

Old spellings: `btc:mainnet` = `btc`, `btc:testnet4` = `tbtc4`, `btc:mainnet-blake2b` = `xbt`,
`btc:testnet4-blake2b` = `txbt4`. `ltc` and `vtc` are reserved until a validator carries their
parameters; a document naming them is refused until then.

## 4. Blocks

A block is valid when it is valid under the parent's rules with these changes, in this order:

1. `pow`: the header meets `powLimit`. No difficulty adjustment, no minimum-difficulty window.
2. `signature`: the coinbase's witness commitment output carries, after the commitment, one
   push (a direct push, `OP_PUSHDATA1` or `OP_PUSHDATA2`, whichever its size needs) of the
   bytes `ecc7daa2` followed by a script witness that satisfies `challenge` for the block's
   signet hash, computed as [BIP 325](https://github.com/bitcoin/bips/blob/master/bip-0325.mediawiki)
   computes it over this chain's header serialization. A block without the marker, or whose
   witness does not satisfy the challenge, is invalid.
3. `subsidy`: the coinbase's outputs sum to at most the block's fees plus the peg-in claims
   the block makes (section 6).
4. `height`, `prev`, timestamps and everything else as the parent.

The challenge is a script, so it can be one key, a `multi_a` threshold, or anything the
engine's interpreter runs. Changing the challenge is a rule change (section 8).

## 5. Genesis

The genesis document lists the peg outputs the chain starts from, and the genesis block mints
exactly those amounts:

```json
{ "chain": "<chain id>", "parent": "<parent id>",
  "pegs": [ { "txid": "…", "vout": 0, "amount": 2500000000, "script": "<sidechain output script>" } ],
  "challenge": "<script hex>", "refundBlocks": 10000 }
```

Each peg's `script` is where its coins appear on the sidechain. The genesis block's coinbase
pays those scripts those amounts and nothing else, and its `prev` is all zeros. The document
is signed by the chain's spec key and is the first rule document (section 8).

## 6. Peg-in

A peg-in is a parent-chain transaction that:

1. pays a **peg output**: a taproot output whose key path is the peg holders' key and whose
   script path is `and_v(v:pk(refund), older(refundBlocks))`, so that the pegger's refund key
   can sweep it after `refundBlocks` unspent;
2. carries an `OP_RETURN` with `pegin:<chain id>:<sidechain output script>`, naming
   where the coins appear on the sidechain. The peg output is the taproot output the peg
   holders own (level 1: the producer's parent wallet; level 2: the challenge script), at any
   position: a wallet may place its change before it. A marker transaction that pays the peg
   holders nothing is not a peg-in. The signer announces the script a peg-in should pay with
   every tip (`peg` tag, section 11): level 2 the challenge, level 1 one address of the producer's
   parent wallet, kept for the chain's life unless rotated. An output paying the announced
   script is the peg wherever it sits, so a wallet builds a peg-in from the announcement alone. The script is written as raw bytes (61 bytes in
   all for a taproot script, inside the 80-byte `OP_RETURN` policy limit); the hex text this
   document shows is also accepted.

After `pegConfirmations` parent confirmations, a sidechain block may **claim** it: the
coinbase pays the named script the peg's amount, and the very next coinbase output is an
`OP_RETURN` carrying `claim:<parent txid>:<vout>`. That pairing is what lets a validator
with no parent view bind each claimed amount to one outpoint: the coinbase may exceed the
fees by exactly the paid claims. A claim of an outpoint already claimed is invalid. A claim of a peg-in the validator cannot see is judged by level (section 9): a
level 1 validator accepts what the signers claim; a level 2 validator has a parent view and
refuses a claim it cannot verify.

The refund path means a peg-in that is never claimed, or a chain that dies, returns the coins
to the pegger after the timelock. While the parent chain is stalled the timelock does not
tick; the coins stay pegged.

### 6.2 The desk

A chain may pay now for a coinbase reward locked on the parent, against the miner's
pre-signed maturity transaction. Proposal: [proposals/desk.md](proposals/desk.md).

## 7. Peg-out

A peg-out is a sidechain transaction paying a **burn output**: `OP_RETURN` with the text
`pegout:<parent output script hex>` (a script of 2 to 40 bytes) and a value of at least
`pegoutMin` sats from the chain document. The value leaves the sidechain's supply; a burn in
the coinbase, a malformed script or a value below the minimum makes the block invalid
(`sidestr:rule-pegouts`). The peg holders then pay that script that value on the parent from
the peg outputs, the parent's fee from the same outputs, in a transaction that also carries
`OP_RETURN` `pegout:<chain id>:` followed by the sidechain txid as 32 raw bytes, so the
record fits the parent's data limit. A validator with a parent view checks that every burn is
paid within `pegoutBlocks` parent blocks and publishes the ones that are not. The reference
producer pays each burn as soon as the block holding it is on the chain, once, keeping its
record beside the chain and reconciling it with the peg wallet's own history on start. In
level 1 this is the federation's promise and the validators' record of whether it was kept.
Trust-minimised peg-out is out of scope for 0.0.1.

## 8. Rules as documents

The chain's rules are engine overlay documents: JSON-LD, one per change, each with an
activation height, published as addressable Nostr events (kind 33500, `d` = chain id :
activation height) signed by a rule key. A node is configured with the rule keys it follows.
It applies a rule from its activation height because its operator chose that key, and it
shows the rule text before applying anything from a key it has not seen.

This is the whole of "user activated". A signer who wants a rule changed publishes a document
and waits to see who adopts it. A node that adopts nothing keeps the rules it has. Two nodes
that adopted different documents will disagree from the activation height, exactly as they
would on any chain, and the block signatures do not settle it.

## 9. Levels

| level | validator has | trusts the signers for |
|---|---|---|
| 1 | the sidechain rules | which peg-ins exist, that peg-outs are paid |
| 2 | a parent-chain view (headers plus the peg outputs) | nothing about pegs; still trusts them for ordering |
| 3 | level 2 plus several independent signers with rotation and a recovery path | liveness only |

The first chain is level 1 with one signer. Section 10 says so.

### 9.1 Level 2

How a chain gets `k` of `n` signers — the challenge, the co-signing round over the relay, the
peg wallet. Proposal: [proposals/level-2.md](proposals/level-2.md).

## 10. The first chain: the txbt4 siding

- chain id: `sidestr:txbt4-siding`, parent `btc:testnet4-blake2b` (the long spelling; `txbt4` since 0.0.2)
- genesis pegs: four outputs of 25 tBTC on the parent, made on 15 September 2026 at heights
  151,152 to 151,154, 100 tBTC in total, each with a 10,000-block refund path
- challenge: one key, on one machine, which is also the peg holder. A test, not a federation.
- `powLimit`: the parent's minimum-difficulty target
- `addressPrefix`: `ts`
- `pegConfirmations`: 6; `refundBlocks`: 10,000; `pegoutBlocks`: 144

Made because the parent chain stalls at its 151,200 retarget until real hash arrives, and a
chain beside it can keep making blocks while it waits.

## 11. Distribution

A producer need not make a block when it has nothing to include. Blocks are receipts for
transactions; between them the chain idles, with a heartbeat block often enough that timelocks
and maturity keep moving and a wallet can tell an idle chain from a dead signer. The reference
producer takes a base interval and a shorter one for when its mempool is not empty.

Blocks are served as the block file blaketestnode already syncs from, `[u32 height][u32
size][block]` with a JSON index, from any mirror. Tips are published as signed events in the
NIP-333 shape with `d` = chain id, so a node cross-checks a mirror against the signers'
own announcement: kind 33333, tags `d` and `n` = chain id, `t` = `sidestr` (so a directory can
ask a relay for every sidestr chain at once), `tip` = height, `u` = a mirror's base URL (one tag
per mirror), `peg` = the parent output script a peg-in pays (section 6; optional, the newest
announcement's wins), content = the last twelve headers as hex, signed by the signer's key.
A client that knows only the chain id takes the newest announcement, reads `chain.json` from a
mirror it names, and accepts that mirror when the document's `signer` is the announcement's
author; a client that already knows the signer takes no other's. A mirror is then held to the
announcement: the header at its tip must be the announced one, and it may be behind but never
ahead of the signer. A chain id is a name, not a proof, so a client shows the signer it settled
on. Transactions reach a producer by `POST /tx` or as kind 23500 events on a
relay, content the transaction hex, tagged `chain` = chain id; relays index only single-letter
tags, so a producer subscribes by kind and checks the tag on receipt. The event's key is
anyone's: the transaction authorises itself. A producer includes what validates. A wallet with
nothing may publish a kind 23501 event, content an address, tagged the same way; a faucet that
follows the relay may answer it with a payment, at its own limits. A wallet with no node may
publish a signed *parent* transaction as a kind 23503 event, content the hex, tagged the same
way: a producer that runs a parent node broadcasts it if and only if that node's mempool policy
accepts it as it stands (no overrides), and never retries a refusal. The node is the judge; the
producer only carries. This is how a peg-in built in a browser reaches the parent.

**Checkpoints.** A producer may write its tip into the parent now and then, so the parent's
proof of work bounds the chain's history. Proposal: [proposals/checkpoints.md](proposals/checkpoints.md).

## 12. Assets

Reserved in the core. Issued assets and an automated market maker between them and the pegged
coin are rules in the sense of section 8, validated by every node, and are not part of 0.0.1. An
issued asset is unbacked and every document that names it says so. Proposal, with two rules a
chain document may name: [proposals/assets-and-pools.md](proposals/assets-and-pools.md).

## 13. Acceptance test

1. A genesis built from the peg-in records reproduces the genesis block byte for byte.
2. A validator with no key syncs the chain from a mirror and agrees with the producer on
   every block, including a block it rejects for a bad signature.
3. A peg-in on the parent is claimed once and cannot be claimed twice.
4. A peg-out burn is paid on the parent and the record shows it.
5. A rule document with a future activation height is adopted by one node and not another,
   and the two disagree from that height and not before.
6. All of it in a browser tab.

## 14. Threats

- **Signers stall**: the chain stops; pegs refund after the timelock. Liveness is the
  federation's, coins are not.
- **Signers reorder or censor**: visible to every validator; no remedy in level 1 beyond
  leaving. Level 3 adds rotation.
- **Signers mint**: impossible; a coinbase over fees plus verified claims is invalid.
- **Peg holders steal**: possible in level 1, the coins are theirs to move. The refund path
  limits it to coins not yet swept, and the record shows it. This is why level 1 is for
  coins with no value.
- **A mirror lies**: caught by the tip announcement and by validation.
- **A parent stalls**: every child's refund clock stops with it (3.1). Coins are not lost,
  they wait; a child pegged off a chain with no heartbeat waits indefinitely.

## 15. Proposals

Mechanisms tried on a chain before they are promoted into this document. Each file says its
status. The core above changes only when a proposal has run unchanged for a while.

| proposal | status |
|---|---|
| [The desk](proposals/desk.md) | running on `sidestr:txbt4-desk` |
| [Checkpoints](proposals/checkpoints.md) | running on `sidestr:gitmark` |
| [Assets and pools](proposals/assets-and-pools.md) | running on `sidestr:tally`; assets between chains: draft |
| [Level 2: several signers](proposals/level-2.md) | steps 1–7 built; running on `sidestr:txbt4-fed` |
| [The EVM as a rule](proposals/evm.md) | running on `sidestr:txbt4-evm` with a public JSON-RPC |
| [Ephemeral chains](proposals/ephemeral.md) | a note: chains made for one job, with a close, a tombstone and manners |
| [A browser signer](proposals/browser-signer.md) | draft: `window.nostr.sidestr.signTransaction`, reference signer in Podkey |

## 16. Changelog

- 2026-09-24 — 0.0.4 (later the same day): kind 23503 carries a signed parent transaction to a
  producer with a node, which broadcasts it only if its node's own policy accepts it (11).
- 2026-09-24 — 0.0.4: the signer announces the peg script with every tip (`peg` tag, 11) and
  the scanner takes the output paying it first (6): a wallet can peg in from a browser key with
  nothing but the announcement, and a third party can tell peg from change. The desk's pledge
  signs by the parent's family like every other transaction.
- 2026-09-23 — 0.0.3: the peg output is the one the peg holders own, at any position (6);
  0.0.1 and 0.0.2 took the first taproot output, which misread a wallet's change as the peg.
  Signatures follow the parent's family (3): unified beside BLAKE2b, BIP 341 beside stock
  Bitcoin, and the producer's mempool checks under that rule. Both found by the first chain
  beside stock testnet4, which ran a full peg-in, trade, peg-out loop.
- 2026-09-21 — 0.0.2: parents are named by short alias (3.2) with a table of genesis and fork
  blocks; the long kernel ids stay accepted so no running chain changes. The header format and
  proof-of-work hash follow the parent (section 3), which is what every chain already did;
  this is written down because the first chain beside a stock Bitcoin parent is being built
  ([spec PR #4](https://github.com/sidestr/spec/pull/4)).
- 2026-09-18 — the peg-out record (section 7) and the tip announcement shape (section 11)
  settled from live use; the window bound and `t` tag noted. Drafts moved to `proposals/`.
- 2026-09-15 — 0.0.1 draft.

## Appendix A. Event kinds

| kind | name | class |
|---|---|---|
| 23500 | transaction | ephemeral |
| 23501 | faucet request, content an address | ephemeral |
| 23503 | parent transaction to broadcast, content the hex | ephemeral |
| 23510 | block proposal, content the block hex without its solution (9.1) | ephemeral |
| 23511 | partial block signature, `e` = proposal (9.1) | ephemeral |
| 23512 | peg-out PSBT to co-sign (9.1) | ephemeral |
| 23513 | co-signed peg-out PSBT, `e` = 23512 (9.1) | ephemeral |
| 23514 | sealed block, content the block hex (9.1) | ephemeral |
| 33333 | tip, NIP-333 shape, `d` = chain id | addressable |
| 33500 | rule document, `d` = chain id : activation height | addressable |
| 33501 | genesis document, `d` = chain id | addressable |
| 33502 | peg record, `d` = parent txid : vout | addressable |

## Appendix B. Prior art

Elements and Liquid, whose signed-block chains with a peg this is a small copy of; BIP 325
signet, whose challenge mechanism is used as is; drivechains and spacechains, which want the
parent to enforce the peg and are the level this does not reach; RGB and Taproot Assets, for
validation by the client rather than the chain; Stellar's consensus, for the idea that trust
is chosen per node.
