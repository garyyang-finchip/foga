# vendor/

This directory holds the pinned upstream sources of the ten reference implementations.
Only `LOCK.json` is committed. Run `npm run vendor:sync` (or `foga vendor sync`) to
materialize `vendor/<repo>/` at exactly the locked commits; the directories are
gitignored so the FOGA repository itself stays small and uploadable by hand.

The sources are needed only to (re)build `artifacts/bundle.json`. Deploying a world,
running the doctor and (later) running cells all work from the committed bundle.

The upstream repositories are CC0-1.0 (with Apache-2.0 vendored ARD material inside
ard-onchain-framework). FOGA does not modify them; changes it needs go back upstream as
separate pull requests.
