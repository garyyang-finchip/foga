# foga-probe

Probe one address against the ten-ERC agent stack at one block and produce a canonical report.

## What the skill does

Given a subject address, a block number and the world's address book, read — at that block and only through
view calls — what each of the ten registries says about the subject, and emit one JSON document in RFC 8785
canonical form. The report is deterministic: two independent runs against the same chain, block and inputs
produce byte-identical output. That is what makes it usable as the known answer of a hashlock tender
(ERC-8414, profile x-hashlock-v1): the demander runs it first and commits `sha256(report)`; a fulfiller runs it
again and settles by revealing the same bytes.

## Inputs

| name      | type                 | meaning                                                             |
|-----------|----------------------|---------------------------------------------------------------------|
| subject   | address              | the account to probe                                                |
| block     | integer              | the block at which every read is made                               |
| kya       | object               | `{ "schemeId": bytes32, "issuers": [address] }` — the standing scheme and the issuers the report trusts |
| world     | string               | the world id (address book) the probe reads                         |

## Output

`foga.probe/1` — see `probe.schema.json`. Sections, one per standard: erc8004, erc8434, erc8419, erc8468,
erc8444, erc8454, erc8338, erc8414, erc8447, erc8436, erc8471. Every number is a decimal string, every address
is lower-case, the block hash is included so a report is bound to one chain history.

## Rules

1. Read at `block`; never at `latest`.
2. Never write. The skill has no transaction.
3. No clocks, no randomness, no environment-dependent values in the report.
4. A registry that reverts or is absent for the subject yields `null` for that section, never an omission.
