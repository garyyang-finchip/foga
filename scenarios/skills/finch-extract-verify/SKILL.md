# finch-extract-verify

Extract named fields from a fixed-version public document and verify their mutual consistency.

## What the skill does

The input is one document pinned by content hash (a filing, a published report, a specification) and a field
list (`fields.json`). The skill extracts each field as it appears in the document, records where it was found,
checks the consistency rules the field list declares (totals that must add up, dates that must be ordered,
identifiers that must match across sections) and produces a deliverable with the extracted values, the
evidence spans and the verdict of every rule.

This is the first business task of a FOGA cell: structured extraction plus consistency checking over a fixed
version of public material, with the output judged by a reader or by a council (ERC-8436), not by a hash.

## Inputs

| name        | type   | meaning                                                                    |
|-------------|--------|----------------------------------------------------------------------------|
| document    | bytes  | the pinned document; its sha256 must equal `documentDigest`                |
| documentDigest | string | `sha256:<hex>` of the document                                          |
| fields      | object | the field list and rules (`fields.json` by default)                        |

## Output

A JSON deliverable: `{ "schema": "finch.extract-verify/1", "documentDigest", "fields": { name: { "value",
"evidence": [{ "page", "quote" }] } }, "rules": [{ "id", "verdict": "pass" | "fail" | "unknown", "note" }] }`.

## Rules

1. Values are copied, never computed, unless a rule says a derived value is expected.
2. Every value carries at least one evidence span.
3. A field that cannot be found yields `null` and the rules that depend on it yield `unknown`.
4. The deliverable states the document digest it was produced from.
