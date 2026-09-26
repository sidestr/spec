# Level 2: several signers

*Status: steps 1–4 built 18 September 2026 (the challenge, PUSHDATA solutions, partial signatures, the round over the relay); `test/federation-test.mjs` and `test/round-test.sh` (three signers on one box: rotation, one down tolerated, two halts, one back resumes). Live on `sidestr:txbt4-fed` (2 of 3) since 18 September: 70+ blocks sealed with the proposer rotating; two peg-in claims (10 tBTC and 0.05 tBTC) proposed by different signers and co-signed after each co-signer checked the claim against its own parent node (step 7). Step 6 exercised live on 19 September: a 20,000-sat burn was mined by the round, signer 1 proposed the PSBT payment, all three signed and it finalised. Three faults found and fixed in the same evening: a claim sealed by another signer left the peg-in locked in every co-signer's wallet (the level-1 unlock ran only after one's own `produce()`), so the wallets could fund nothing; a claim sealed by another signer stayed in a co-signer's claim list, so every proposal of theirs threw and one signer proposed every block; and the wallet's fee for a script-path spend came out under the relay minimum (fee rate doubled). With those fixes the round paid the burn on the parent the same evening: one transaction spending the federation's peg output with a 2-of-3 script-path witness (two 65-byte signatures, an empty slot, the leaf, the control block), 20,000 sats to the burn's address, the `pegout:<chain id>:<txid>` marker, change back to the federation, 274 vB, confirmed. A transaction posted to one signer's `/tx` reaches the others only when that signer proposes, so wallets should publish over the relays. Not yet: a signer on another machine, changing the set.* A proposal to the [sidestr spec](../SPEC.md); the record here is the working text, promoted into the spec once it has run unchanged for a while.

A level 2 chain has `n` signers and a threshold `k`. Nothing changes for a validator:
the challenge is still a script and a block is still valid when its solution satisfies it.

**Challenge.** A taproot output whose internal key is provably unspendable (the BIP 341 NUMS
point tweaked by the chain id) and whose single leaf is `multi_a(k, pk_1, …, pk_n)`:
`<pk_1> CHECKSIG <pk_2> CHECKSIGADD … <pk_n> CHECKSIGADD <k> NUMEQUAL`. The document lists
`signers` (the `pk_i`, in leaf order, distinct: a key listed twice would fill two slots with one
signature) and `threshold`, and `challenge` is derived from them,
so a validator can check the derivation. The solution is the script-path witness: `n`
signature slots in leaf order, an empty item for a signer who did not sign, then the leaf
script and the control block; it is carried as one push of any length after the witness
commitment (section 4), `OP_PUSHDATA1` or `OP_PUSHDATA2` as its size needs.

**Signer keys are Nostr keys.** A signer's `pk_i` is the key it publishes events with, so a
proposal or a partial signature is authenticated by the event itself and no second identity
is needed.

**The round.** Every signer runs a producer: the same validator, the same mempool, its own
mirror. At each height the proposer is signer `height mod n`; after `proposeAfter` seconds
without a block, the next signer in order may propose, and so on around the ring.

1. The proposer builds the block without its solution and publishes it as a kind 23510 event:
   content the block hex, tags `chain` = chain id, `h` = height. It signs the block data itself
   and includes its own partial signature as a kind 23511 event referencing the proposal.
2. Each other signer validates the proposal against its own chain and rules exactly as it
   would a block from the mirror, requires that every transaction is one it has seen valid,
   that the height is its tip plus one, that the proposer is entitled at this time, and that it
   has not signed another proposal for this height. If all hold it publishes a kind 23511
   event: content its BIP 340 signature over the block data (section 4, the same message the
   level 1 signature covers), tags `chain`, `h`, `e` = the proposal event id.
3. With `k` signatures the proposer assembles the witness in leaf order, appends the solution,
   adds the block to its chain, and announces it (section 11). Every signer's producer adds
   the announced block from any signer's mirror as a follower does, and the next round starts.

A signer that signs two proposals for one height is faulty; the documents of a chain say what
its signers do about that, and a validator sees both signatures on the relay. A block needs
`k` of `n` signers online; with fewer the chain halts, heartbeats included, and every child's
refund clock with it (section 3.1). Level 3 adds rotation and a recovery path.

**Announcements.** Any signer may publish the kind 33333 tip event. A client that knows the
document accepts an announcement from any listed signer and prefers the highest tip; the `u`
tags name every signer's mirror.

**The peg wallet.** The peg outputs on the parent are the same `k`-of-`n` under the same keys:
a `tr(NUMS, multi_a(k, …))` descriptor. A peg-out (section 7) is a PSBT the proposer publishes
as kind 23512 and the co-signers return signed as kind 23513, the same round with the same
rule of one signature per burn per signer, finalized and broadcast by the proposer.

**Changing the signers.** A new `signers`/`threshold` pair with its derived challenge is a
rule document (section 8) with an activation height; the peg outputs move to the new
descriptor by a peg-out to it, paid by the old set.

**As built (steps 1–4).** `lib/federation.mjs` derives the challenge (internal key = H +
tagged("sidestr/nums", chain id)·G; leaf `<pk_1> CHECKSIG <pk_2> CHECKSIGADD … <k> NUMEQUAL`);
the witness carries the slots in reverse leaf order, exactly `k` of them filled (a `k+1`-th
signature would fail NUMEQUAL), then the leaf, then the control block. `lib/round.mjs` runs the
round; the sealed block is also published as a kind 23514 event so every signer adds it at once,
mirrors aside. Two rules the draft did not state: a signer's "one signature per height" relaxes
once the proposal it signed has had `proposeAfter` seconds to seal and has not — otherwise a
proposer that dies after collecting fewer than `k` strands the height — and a proposer drops its
own proposal after `proposeAfter × n` seconds. A federated chain's genesis is sealed by `k` keys
at `siding new --signers … --key-files …`; each signer starts from a copy of that block file
(fetching it from a mirror is step 8).
