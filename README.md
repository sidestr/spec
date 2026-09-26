# sidestr

User activated sidechains: Bitcoin's rules beside a Bitcoin-family chain, blocks valid because
they are signed, no subsidy, every coin a coin locked on the parent, and the rules carried as
signed documents each node chooses to adopt. Signers order blocks; users enforce the rules.

- [SPEC.md](SPEC.md): the protocol, draft 0.0.4.
- [paper/sidestr.md](paper/sidestr.md): the white paper, *sidestr: User-Activated Sidechains*, draft 27 September 2026 ([PDF](paper/sidestr.pdf)).
- The first chain is the txbt4 siding, a chain beside the BLAKE2b testnet4 that keeps making
  blocks while the parent waits at its retarget. Level 1, one signer, worthless coins.

The sibling of [datstr](https://datstr.com/spec/): the same engine, the same documents, the
same rule that everything a verifier does runs in a browser tab.

## siding/

The reference implementation, on the same engine as datstr and blaketestnode:

    siding/chain.json      the txbt4 siding: id, parent, challenge, the four genesis pegs, powLimit, prefix
    chains/<name>/         every other chain, one document each (`siding new` writes them)
    siding/lib/overlay.mjs the network overlay, the block-signature rule, the claim and burn rules (SPEC 3, 4, 6, 7)
    siding/lib/announce.mjs the tip announcement: a chain found by its id alone (SPEC 11)
    siding/lib/parent.mjs  the parent over RPC: peg-ins scanned and claimed, burns paid from the peg wallet
    siding/bin/siding.mjs  new | key | genesis | produce | sync | send | faucet

    node siding/bin/siding.mjs new --name X --prefix Y     a whole chain: document, key, genesis, the lines to run it
    node siding/bin/siding.mjs produce --chain C --dir D   blocks on an interval, sooner with transactions
    node siding/bin/siding.mjs sync --url URL --dir D      validate a producer's chain, no key needed

Needs checkouts of bitcoin-desktop/schema (SCHEMA) and bitcoin-blake/blaketestnode (BLAKETESTNODE, the block-file node `lib/chain.mjs` builds on). The genesis is deterministic: the same
chain document gives the same block 0, byte for byte.

Around it: the [explorer](https://github.com/sidestr/explorer) and [wallet](https://github.com/sidestr/wallet)
take `?chain=<id>` and find the chain from its announcement; the [directory](https://github.com/play-grounds/sidestr)
lists every chain that has announced itself.

Picking this up as a developer or an agent: start with [siding/README.md](siding/README.md), the map of the reference implementation and what is not yet built.
