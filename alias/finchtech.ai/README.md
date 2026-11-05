# @finchtech.ai/foga

The Finch OG Agent toolchain (FOGA) under the `finchtech.ai` scope. This package is an **alias** of
[`@finchip.ai/foga`](https://www.npmjs.com/package/@finchip.ai/foga): it carries no code of its own, only a launcher
that runs that package's `foga` binary at the pinned version. The two names are one program:

```
npx -y @finchtech.ai/foga quickstart     # the same as: npx -y @finchip.ai/foga quickstart
```

Node 22.13 or newer and Foundry's `anvil` are the only requirements of a local quickstart. The documentation, the
source and the issues are at https://github.com/garyyang-finchip/foga; the reference cell is served at
https://foga.finchip.ai. Apache-2.0.
