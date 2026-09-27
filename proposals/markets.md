# Markets

*Status: draft, 27 September 2026. Nothing runs yet.* A proposal to the [sidestr spec](../SPEC.md), planned in [issue 26](https://github.com/sidestr/spec/issues/26). It adds one rule, `markets`, beside `assets` and `pool` ([assets-and-pools.md](assets-and-pools.md)), and reuses both: a market's outcomes are assets, a market's price is a pool, the question and the answer are records.

A **market** is a question with two outcomes, YES and NO, minted in pairs against sats and settled by a named resolver. Split N sats and receive N YES and N NO; merge a pair and take N sats back; when the resolver answers, the winning outcome redeems one for one against the sats locked, and the losing one is worth nothing. A market the resolver never answers refunds both sides at half par after a grace period: a dead resolver costs time, not coins, which is the peg's rule (SPEC 1.5) applied to a market. Every reader validates all of this; what a trader trusts is the resolver's key, written in the market's own transaction.

## 1. Records

Records are as in assets-and-pools.md section 1: `OP_RETURN` text of at most 255 bytes, none in the coinbase. Heights are chain heights.

| record | meaning |
|---|---|
| `market:self:<vout>:<resolver>:<expiry>:<grace>` | this transaction opens a market; its id is this txid; the named output is its **market coin**; `<resolver>` is a 32-byte x-only public key as 64 hex; `<expiry>` a height after which the market may be refunded, `<grace>` the blocks after `<expiry>` the resolver still has |
| `question:<text>` | the question, UTF-8, at most 200 bytes, in the opening transaction; display only, the rule checks presence and length |
| `split:<market>:<vout>` | the transaction spends the market coin and recreates it at the named output with N more sats, and tallies N YES and N NO to outputs of its choice |
| `merge:<market>:<vout>` | recreates the market coin with N fewer sats; the transaction carries in at least N YES and N NO and tallies neither onward |
| `resolve:<market>:<yes\|no>` | the answer; valid only in a transaction one of whose inputs spends a coin paying the resolver's key (section 4) |
| `redeem:<market>:<vout>` | recreates the market coin with N fewer sats; after resolution the transaction carries in at least N of the winning outcome; after expiry plus grace without a resolution, it carries in YES and NO whose sum is at least 2N |

The **YES asset** of a market is the asset whose id is the market id. The **NO asset** is the asset whose id is `sha256("no:" ‖ <market id as 64 hex text>)`, as 64 hex. Both are assets in the sense of the `assets` rule, tallied with `tally:<id>:…` like any other, and are shown by pages with tickers `YES` and `NO`, no decimals, folded under their market. One unit of either is worth at most one sat.

## 2. The market coin

The market coin is one coin with script `OP_TRUE` (`51`), like the pool coin: anyone may spend it and the rule says how. Its value is the market's **collateral** `C`, the sats behind every outstanding pair. A transaction that spends a market coin recreates exactly one output with script `51` and the `split:`, `merge:`, `resolve:` or `redeem:` record naming it (a `resolve:` names no output; the coin is recreated with the same value). A transaction spends at most one market coin and carries at most one of these records. The coin is never tallied with an asset, and its value is at least 1 sat: the sat the opener puts in stays for the market's life.

## 3. The `markets` rule

The validator keeps, per market: the coin's outpoint, `C`, the resolver, expiry, grace, the question, and the status: **open**, **resolved** with a winner, or **refunding**. Let `h` be the block's height. In order of the transactions in a block, each transaction carrying one of the records must satisfy, or the block is invalid (`sidestr:rule-markets`, error `bad-market`):

- **open** (`market:self:`): the named output has script `51` and value `C0 ≥ 1`, the transaction carries exactly one `question:`, `expiry > h`, `grace ≥ 1`, and the transaction issues nothing and opens no pool. The market is open with `C = C0`. YES and NO exist from here with supply zero.
- **split**: the market is open, or resolved, or refunding (a pair may be minted at any time; it is always worth exactly its collateral). With `N = C' - C > 0`: the transaction tallies exactly `N` YES and exactly `N` NO in total, to any outputs. The `assets` rule exempts YES and NO in a transaction carrying `split:` for that market, as it exempts pool shares: this rule accounts for them.
- **merge**: any status. With `N = C - C' > 0`: the transaction carries in at least `N` YES and at least `N` NO and tallies onward at most (carried − N) of each. The sats go where the transaction sends them.
- **resolve**: the market is open, `h ≤ expiry + grace`, the record's outcome is `yes` or `no`, and one input of the transaction spends an output whose script is `5120` ‖ resolver. The market is resolved with that winner. A second `resolve:` for a market is invalid; so is one after the grace period.
- **redeem**, resolved: with `N = C - C' > 0`, the transaction carries in at least `N` of the winning outcome and tallies onward at most (carried − N) of it. The losing outcome is not consulted; it may be carried, spent or burned freely, and is worth nothing.
- **redeem**, unresolved and `h > expiry + grace`: the market becomes refunding (it stays so; a `resolve:` is now invalid). With `N = C - C' > 0`, the transaction carries in `a` YES and `b` NO with `a + b ≥ 2N`, and tallies onward at most (a − a′) and (b − b′) where `a′ + b′ = 2N`. Each unit refunds half a sat; the rounding is the redeemer's loss.
- **redeem** on an open market before `expiry + grace` is invalid.

Collateral never leaves except by merge and redeem, and each unit of an outcome is backed by one sat until resolution and by one sat of the winner's after it. A reader can check every market's `C` against the sum of its outstanding YES and NO at any height.

## 4. The resolver

The resolver is a key, named in the opening transaction, and the answer is a transaction that key signed: the rule asks that one input spend a coin paying `5120` ‖ resolver, which is a Taproot key-path spend by that key under the chain's own signature rules. No new signature format, and the answer sits in the chain where every reader validates it. The resolver may answer at any time before expiry plus grace, once. What a trader trusts is that key, and only that: the rule cannot be bent by the signer of the chain, the pool, or anyone else.

A market whose resolver is silent refunds at half par after the grace period. That is the floor; it is also why a market should carry a grace long enough for a resolver to notice, and short enough that a dead one does not hold coins for long. The reference page suggests 1,000 blocks.

Later, without changing this rule: a **dispute** rule could take the resolution record as its input, hold it for a window during which anyone may post a bond and a counter-answer, and hand a dispute to a panel. This proposal shapes the record so that such a rule reads it as it stands.

## 5. Prices

Nothing to add. A pool (assets-and-pools.md section 3) between YES and sats, and another between NO and sats, are the market's prices: the YES pool's price in sats per unit, out of one, reads as the probability of YES. The two need not sum to one; whenever they drift apart, splitting a pair and selling the dear side, or buying both and merging, earns the difference, which is what keeps them together.

## 6. Activation

A chain names the rule as `"markets"` in `rules`, from genesis, or as `{ "name": "markets", "from": <height> }` on a running chain: the rule then keeps no state and accepts every block below `from`, and applies from `from`. The history below `from` cannot carry market records, and need not be checked for them: under the `assets` rule alone a split mints from nothing and is invalid, so no such block exists on a chain that was valid before adoption. A validator without the rule refuses the chain by name either way (assets-and-pools.md, opening). This is the first use of an activation height in a chain document; the general mechanism, rule documents on the relay adopted per node, is SPEC 8 and is not needed for it.

## 7. Threats

- **The resolver lies.** Possible, and the whole trust of the market. Visible to everyone, attached to a key forever; the dispute rule above is the remedy when there is one.
- **The resolver dies.** Refund at half par after the grace period, by rule.
- **Someone mints pairs to move a pool.** Pairs are always fully collateralised, so this costs them the fee and the impact, as any trade does.
- **A malformed market** (expiry in the past, no question, wrong key length) is invalid at open, so it never exists.

## 8. Acceptance

1. A market opens; split, merge and the two pools work; YES + NO trade near par.
2. `resolve:` from any key but the resolver's is refused; from the resolver's it is accepted once and refused twice.
3. After resolution, the winner redeems one for one and the loser redeems nothing; before it, `redeem:` is refused.
4. With no resolution, `redeem:` is refused until `expiry + grace` and refunds at half par after.
5. Every market's collateral equals its outstanding pairs at every height, checked by a validator with no key.
6. A chain that names the rule from a height accepts its history below that height unchanged, and a validator without the rule refuses the chain by name.
