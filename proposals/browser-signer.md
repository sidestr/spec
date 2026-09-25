# A browser signer

*Status: draft, 24 September 2026. Reference signer: [Podkey](https://github.com/JavaScriptSolidServer/podkey) 0.0.9, opt-in from 0.0.10; consumers: the [wallet](https://github.com/sidestr/wallet) and a forum on `sidestr:dreamlab`. A spend signed through it was mined on `sidestr:dreamlab` at block 431 (txid `7f3a6a63…`).* A proposal to the [sidestr spec](../SPEC.md); the record here is the working text, promoted into the spec once it has run unchanged for a while.

A sidestr coin pays `OP_1 <32-byte key>` with no tweak, so the key a person already holds for
Nostr is the key that spends their coins, and a NIP-07 extension that guards that key could
sign their spends. Today every page that spends holds the raw key itself (the wallet keeps it
in `localStorage`). This proposal names one method a browser signer adds beside `window.nostr`,
so that any page, on any chain, can ask for a spend without ever holding the key, and says
what the signer must check so that the page need not be trusted.

## The method

```js
const { tx, txid } = await window.nostr.sidestr.signTransaction({ chain: 'sidestr:dreamlab', tx: unsignedHex });
```

`chain` is a chain id (section 11); `tx` is the transaction as hex, with or without witnesses
(any witness is ignored and replaced). The promise resolves to the same transaction with a
key-path witness on every input, and its txid, or rejects with an `Error` whose `code` is
`rejected` (the person said no), `unsupported` (a chain, parent or rule this signer does not
take), `not-yours` (an input it will not sign), `invalid` (a transaction it cannot read) or
`unavailable` (no key, locked, or the chain could not be read). `window.nostr.sidestr.version`
is `1`; `name`, optional, is what a page may call the signer in its own words ("Podkey will show
you this spend"); `enabled` says whether the person has turned sidechain spends on. The address of the key is `5120` followed by `getPublicKey()`; there is no other method.
Nothing else is signed: a page that wants a generic signature over 32 bytes does not get one,
because that signature is also a signature over any event id and any other chain's sighash.

A signer may keep spends off until the person turns them on, since most people who hold a Nostr
key never use a sidechain. The method stays present while they are off, with `enabled` false, so
a page is never left without a way forward: the first request asks, in the signer's own window,
whether to turn spends on, and goes on to the spend if the person agrees. Declining is
`unsupported`. Turning spends off forgets every chain and its signer.

Publishing stays with the page. A transaction authorises itself, so the kind 23500 event that
carries it may come from any key (section 11) and a page should sign it with a throwaway one:
a person is asked once, for the spend.

## What the signer checks

The page is not trusted for anything but the request.

1. **The chain.** The signer resolves the chain from its id as section 11 says: the newest
   announcement, a mirror it names, `chain.json` from that mirror naming the announcer as
   signer. It validates every block from the mirror itself, as a validator would, and never
   reads chain state from the page. A chain id is a name, not a proof: the signer remembers
   the signer it settled on for each chain the first time and refuses, with the reason shown,
   when a later announcement for the same id names another. It refuses a chain whose parent is
   a mainnet until its operator enables mainnets, and a chain that names a rule it cannot
   evaluate in full.
2. **The inputs.** Every input spends an unspent, mature output in its own validated set that
   pays `5120‖its key`. An input it does not own, cannot find, or that is not yet confirmed is
   refused as `not-yours`: the signer signs only for coins it can see are its own.
3. **The sighash.** It computes each input's sighash itself, under the parent's family
   (section 3: BIP 341 beside stock Bitcoin, unified beside BLAKE2b), `SIGHASH_ALL` only, with
   the prevouts from its own set. It never signs a digest the page supplies. BIP 341 commits to
   every prevout's amount and script, so a page that lied about a coin would get an invalid
   signature, not a theft; the signer does not rely on that and reads the coins itself.
4. **What it shows.** Before asking, it decodes the transaction and shows, in its own window
   and never the page's: the requesting origin; the chain id, its signer and its parent network;
   each output as the address it pays (a `5120` output also as the Nostr key it is, since that
   is how people know each other), a record's text, or a peg-out burn; what comes back to the
   person; the fee (inputs less outputs). Where the chain names `assets` (section 12), what each
   input carries and each output receives under the rule. Where the chain names no rules, the
   signer may read records under the same rule as a view (a transaction that breaks it keeps its
   spends and carries nothing), labelled as unenforced by the chain. Either way it warns when the
   transaction destroys an asset its inputs carry, and when the fee is large against the amount.
5. **Every time.** A spend is asked for every time. Trust given to an origin for events,
   encryption or login does not extend to spends, and a signer offers no "always allow".
6. **Its own check.** Before returning, it verifies each signature as a validator would.

A signer may keep a chain's validated state between requests, so the next spend checks only the
blocks since, as the explorer does. Kept state is tied to the hash of the block at its height and
dropped, with every block checked again, when the mirror's block there differs.

## Why here

A signer that resolves and validates the chain from the id alone needs nothing from the page but
the transaction, so one method serves every page and every chain: a chain's own wallet, a forum
that tips in an issued asset, a pod's app, an agent's dashboard. The engine a signer runs is the
one the explorer and the wallet already run (`explorer.mjs` and `siding/lib`). An extension may
not load code from the network, so it carries pinned copies of both, and a rule whose code is
fetched at run time (the EVM's) is `unsupported` there until the rule is vendored too.

Command-line wallets and agents keep their key files; this is for pages.
