# BitVM custody

*Status: draft, nothing built.* A proposal to the [sidestr spec](../SPEC.md); the record here is the working text, promoted into the spec once it has run unchanged for a while.

The `key` and `threshold` custodies (SPEC 6.1) trust the signers to pay peg-outs. This one
takes that trust away: the pegs sit in outputs that only a pre-signed bridge can spend, peg-outs
are paid by an operator who is repaid from the pegs afterwards, and anyone who sees a false
repayment claim can stop it with a fraud proof on the parent. The signers still order blocks;
they can no longer keep the coins.

BitVM itself is still moving (BitVM2 bridges, then garbled-circuit variants with smaller
proofs). This proposal fixes what sidestr has to provide to any of them and leaves the
bridge's own machinery to the bridge.

## What does not change

- The burn (SPEC 7): a sidechain transaction paying `OP_RETURN pegout:<parent script>` asks for
  the peg-out. A wallet does not know or care which custody pays it.
- The refund leaf (SPEC 6.1) stays in every peg output, so a bridge that never comes up, or a
  chain that dies, returns the coins to the pegger.
- Blocks are signed, not mined: the bridge trusts the signers for ordering, as every level does.

## The flow

1. **Peg-in.** The pegger pays a peg output whose custody is the bridge's `n`-of-`n` key, built
   as a BitVM bridge requires (its signers pre-sign the spending graph for that deposit before
   it is funded, then delete their keys; one honest signer keeps it safe). The destination is
   in the tweak form, so the output itself commits to the chain and the sidechain script.
2. **Peg-out.** A burn is mined on the sidechain. An operator pays the burn's script its value
   on the parent from its own coins, with the usual `pegout:<chain id>:<txid>` record.
3. **Repayment.** The operator claims the same value from the pegs through the pre-signed graph.
   The claim waits out a challenge period on the parent.
4. **Challenge.** Anyone who holds the chain can show the claim is false (no such burn, a burn
   already repaid, a payment that did not match it) and stop the repayment; the operator's
   bond goes to the challenger.

## What the claim proves

The bridge needs one program, run in the clear when nobody disputes it and proven on the parent
when someone does. sidestr defines what it checks; the bridge decides how it is proven.

- **The chain.** The burn's block descends, by valid signed headers (the chain's `challenge`
  satisfied, SPEC 4), from a checkpoint the signers wrote into the parent ([checkpoints](checkpoints.md)).
  Checkpoints are what stop the signers from signing two histories and repaying burns from the
  one nobody saw: a `bitvm` chain must checkpoint, and the program accepts only the history
  that holds the newest checkpoint before the claim.
- **The burn.** The transaction is in that block (merkle proof), its output is a valid burn
  (SPEC 7), and its value and script are the ones the operator paid.
- **Once.** No earlier repayment in the bridge's record names the same sidechain txid.
- **The payment.** The parent transaction that paid the burn exists before the claim (the
  parent's own proof), pays that script at least that value, and carries the record.

The program needs the sidechain's signature check and header hash in the bridge's proof system:
Schnorr over secp256k1, and BLAKE2b or SHA256d by the parent's family (SPEC 3). That cost is
the main reason to keep blocks small and checkpoints frequent.

## Open problems

- **Operators' coins.** Every peg-out is fronted from an operator's own liquidity and repaid
  only after the challenge period, so peg-outs need operators who are paid for that wait.
- **One setup per deposit.** A peg-in can no longer be built from the tip announcement alone
  (SPEC 6, 11): the bridge's signers must pre-sign its graph first. A peg-in becomes a request
  and a reply, like the desk's pledge.
- **Data for challengers.** A challenge needs the blocks. Mirrors and torrents of the block file
  (SPEC 11) are what make "anyone can challenge" true; a chain whose blocks vanish cannot be
  defended.
- **Mass exit.** A chain closing, or moving to new custody (SPEC 6.1), is many peg-outs at
  once, the moment operators' liquidity is thinnest.
- **The parent's script.** The bridge needs taproot and the opcodes its proof uses on the
  parent. Bitcoin and the BLAKE2b chain have them; each other parent in SPEC 3.2 must be checked.

## Steps

1. The `custody` field and the table in SPEC 6.1, with `key` and `threshold` described as they
   run. Done in this draft.
2. Checkpoints required for a `bitvm` chain (a rule on the chain document).
3. The claim program as plain code over the engine: given a checkpoint, headers, a merkle proof
   and the two transactions, say yes or no. It is useful before any bridge, as the level 2
   validator's peg-out check.
4. A bridge, once BitVM's primitives have settled: the deposit graph, the operator, the
   challenge, on a test parent first.
