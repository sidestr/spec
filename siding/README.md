# siding: the reference implementation

Start here if you are picking this up cold. `../SPEC.md` is the design; this directory is the
code that runs the chains, and this file is the map. Everything is plain ES modules for
Node 22+ and browsers; there is no build step and no dependency beyond the
[bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema) kernel, loaded from a
local checkout in Node (`SCHEMA`, default `~/bitcoin-desktop/schema`) or from jsdelivr in a page.

## What is here

| file | what |
|---|---|
| `chain.json` | the first chain, the txbt4 siding: id, parent, signer challenge, prefix `ts`, peg and fee parameters, genesis |
| `../chains/<name>/chain.json` | every other chain, one document each (`siding new` writes them) |
| `bin/siding.mjs` | the CLI: `new`, `key`, `genesis`, `produce`, `sync`, `send`, `faucet` |
| `lib/engine.mjs` | loads the schema kernel with the knots-blake2b overlay and `overlay.mjs` for one chain document |
| `lib/chain.mjs` | the chain in memory: blocks, UTXO set, mempool policy (`minFeeRate`, `pegoutMin`), `submit`, `produce`, `coins`, `pegouts` |
| `lib/overlay.mjs` | what makes a siding different from its parent: zero subsidy, the signature challenge, the claim rule (§6), the burn rule (§7) |
| `lib/block.mjs` | building a block, the signed block data, the solution push in the coinbase |
| `lib/parent.mjs` | the parent seen over RPC: peg-in scanning, confirmations, paying burns from the peg wallet, the wallet's own record |
| `lib/pledge.mjs` | the desk (§6.2): build and verify a pledge — a pre-signed maturity transaction for a locked parent reward; `parentKernel` for the parent's rules in Node or a page |
| `lib/federation.mjs`, `lib/round.mjs` | level 2: the k-of-n challenge and witness; the proposal / partial-signature / sealed-block round over the relay |
| `lib/checkpoint.mjs` | checkpoints (§11): the tip written into the parent as one OP_RETURN, the record, the parent-side send and reconciliation |
| `lib/announce.mjs` | the tip announcement (kind 33333, `d` = chain id, `t` = sidestr, `u` = mirrors): build, parse, find a chain by id, judge a mirror |
| `lib/relay.mjs` | Nostr: sign events, follow relays by kind and tag, publish |
| `lib/spend.mjs` | build a spend (or a burn) from a key's coins and deliver it over the relays or `POST /tx` |
| `lib/schnorr.mjs` | BIP-340 signing on the schema's curve; no Node imports, so a browser can use it |
| `lib/sign.mjs` | key files for the CLI (`~/.sidestr/<chain name>.key`, 32 bytes of hex, mode 0600) |
| `lib/address.mjs` | bech32 / bech32m both ways, any prefix; no `Buffer`, browsers included |
| `test/` | `claims-test` (§6 + fees), `pegout-test` (§7, chain and parent sides, no node needed), `pledge-test` (§6.2), `rules-test` (§12), `announce-test` (`--live` asks the relays) |

Three pages build on this, each pinned to a commit of this repository by full hash:

- [explorer](https://github.com/sidestr/explorer) — `?chain=<id>` or `?mirror=<URL>`; validates every block in the browser, shows blocks, transactions, addresses, claims and burns; its `explorer.mjs` is the browser-side engine.
- [wallet](https://github.com/sidestr/wallet) — keys in the browser, coins from the mirror, spends and peg-outs to a relay, a faucet button; `test/wallet-test.mjs --chain <id> [--send] [--faucet]` is the quickest end-to-end check there is.
- [play-grounds/sidestr](https://github.com/play-grounds/sidestr) — the directory: every chain that has announced itself, from the relays, ranked by activity.

## How the pieces talk (SPEC section 11)

- **Blocks** are served as a file, `[u32 height][u32 size][block]`, with a JSON index and
  `chain.json`, from any **mirror**: a directory on a web server, nothing more. The producer
  serves the same three files on its own port; a mirror is an rsync of them.
- **Tips** are announced by the signer after every block: kind 33333, `d` = chain id, `u` = its
  mirrors, content the last twelve headers. A client that knows only a chain id fetches the
  newest announcement, takes a mirror it names whose `chain.json` is signed by the announcer,
  and then holds that mirror to the announced tip. The `t` = sidestr tag is what the directory
  filters on.
- **Transactions** reach the producer either by `POST /tx` on its port or as **kind 23500
  events on a relay**, content the transaction hex, tagged `chain` = chain id. Relays index only
  single-letter tags, so a producer subscribes by kind and checks the tag itself. The event's
  key is anyone's: the transaction authorises itself. Kind 23501 (content: an address) asks a
  faucet.
- **Peg-ins** (§6): an output on the parent to the chain's peg wallet with `OP_RETURN
  pegin:<chain id>:<sidechain script bytes>`; the producer claims it at `pegConfirmations` with
  a coinbase payout followed by `claim:<txid>:<vout>`.
- **The desk** (§6.2): a chain whose document carries `pledge` pays a rate now for a coinbase
  reward locked on the parent, against the miner's pre-signed maturity transaction (kind 33502);
  the producer records every locked coinbase output it scans (`coinbases.json`) and what it paid
  (`pledges.json`), broadcasts each pledge at maturity and claims it to the float.
- **Checkpoints** (§11): with `--checkpoint-every N` the producer writes its tip into the parent
  every N blocks (`checkpoints.json`, mirrored); the explorer shows every block at or below the
  newest confirmed checkpoint as anchored in the parent and flags a rewritten history.
- **Peg-outs** (§7): a sidechain output `OP_RETURN pegout:<parent script hex>` with a value of
  at least `pegoutMin`; the producer pays it on the parent from the peg wallet, once, with
  `pegout:<chain id>:<txid>` riding along, and keeps the record in `<dir>/pegouts.json`.
- So a wallet needs a chain id and a relay, and nothing of the producer's.

## Running it

A new chain is one command:

```
siding new --name <name> --prefix <hrp> [--parent txbt4|xbt|tbtc4|btc] [--comment ...] [--interval 600]
```

It writes `../chains/<name>/chain.json`, makes the signer key at `~/.sidestr/<name>.key`, writes
genesis into `~/.sidestr/<name>`, and prints the `produce` line and the mirror and parent-wallet
steps. The document is the chain's identity (its genesis hash is derived from it), so commit it;
the hosts in the `produce` line are the operator's and stay out of this repository.

```
siding produce --chain C --dir D --port 3450 --interval 600 --tx-interval 10 \
    --relay wss://relay-a,wss://relay-b,wss://relay-c \
    --parent-rpc http://127.0.0.1:PORT/ --parent-cookie PATH/.cookie --parent-from HEIGHT --parent-wallet <name>-peg \
    --announce-mirror https://HOST/PATH/<name>
siding sync    --chain C --dir D --url http://host:3450                       # a validating follower
siding send    --chain C --relay wss://relay-a,... --to <address|script> --amount <sats>
siding send    --chain C --relay ... --pegout --to <parent address> --amount <sats>   # burn; paid on the parent
siding faucet  --chain C --url http://127.0.0.1:3450 --relay ... --key-file F --amount 100000
siding key --create --chain C ; siding genesis --chain C --dir D               # what `new` does, by hand
```

The producer makes a block every `--interval` seconds when idle and every `--tx-interval`
seconds while its mempool has something in it. Coinbase outputs (zero subsidy: fees only)
mature after `coinbaseMaturity` blocks, 100 unless the overlay says otherwise. Amounts are
always sats. Use several relays (five by default: nos.lol, damus, primal, nostr.mom, nostr.oxtr.dev): one being down, or rate-limiting you, must not hide the chain.

The producer's HTTP surface: `/` or `/status.json` (tip, coins, mempool, relays, announce,
peg-ins, peg-outs), `/chain.json`, `/tip`, `/blocks.json`, `/blocks.dat` (Range requests),
`/coins/<script hex>`, `POST /tx` (body ≤ 256 KB). Its state beside the block file:
`pegins.json` (scan position and what was found), `pegouts.json` (what was paid), `faucet.json`.

## Conventions that matter

- **Keys are files, never arguments.** `loadKey` reads them; nothing prints them.
- **No host names in this repository**, not even as defaults: a mirror is always given by the
  operator or found from an announcement; public relays are fine. Pin other repositories by
  full commit hash when loading them from a CDN; move the explorer and wallet pins together
  whenever `overlay.mjs` changes, or an older overlay rejects the new blocks.
- **A chain id is a name, not a proof.** With only the id a client takes the newest announcement
  and shows the signer it settled on; a client that knows the signer passes it and takes no other's.
- Test against a live chain before claiming a change works; the wallet harness and a
  five-line WebSocket or fetch client are enough. Node has `Buffer`; browsers do not.
- pm2 `restart` does not re-read a config file's args; `delete` then `start --only` does.

## What is specified and not yet built

1. **A second signer (level 2, §9)** — steps 1–4 built (`proposals/level-2.md`); left: `challenge` as a k-of-n script (the validator already
   runs whatever script the document names), a `cosign` role that follows block proposals on the
   relay and returns partial signatures, the producer assembling the witness, the announcement
   naming the signers, and the parent peg wallet as a matching k-of-n descriptor.
2. **The validator's view of peg-outs (§7)**: a level-2 follower with a parent view that lists
   burns unpaid after `pegoutBlocks`.
3. **Assets (§12)**: reserved.

Small known gaps: the explorer shows amounts in coins, not sats; a burn's parent txid is in the
producer's `pegouts.json` but not on the mirror, so the explorer cannot yet link it.

## Block persistence failures

If appending a block or writing its index fails (for example, `ENOSPC`), the
producer exits nonzero. The in-memory chain has already applied that block, so
continuing after the error could create successors of a block absent from disk.
`Siding` latches `SIDING_PERSISTENCE_FAILED`, refuses further production, block
admission and transaction submission, and refuses tip, height, coin, claim and peg-out queries. Its
optional synchronous `onPersistenceError(error)` hook lets an embedding service
stop its other work; the producer CLI uses it to terminate every production path.
Create a fresh instance only after checking the saved history.

This stops cascading gaps; it does not make the two-file block store crash-atomic
or repair a partial append or damaged index. Preserve both files, check that the
index is contiguous and its blocks replay, and recover from a verified copy
before restarting. Do not silently truncate or reissue a chain with live funds.

The fault-injection regression suite needs the same `SCHEMA` and `BLAKETESTNODE`
checkouts as the producer and runs without a parent node or relay:

```sh
node --test test/persistence-test.mjs
```
