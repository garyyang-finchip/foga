# FOGA toolchain image: Node 22 + Foundry (anvil, forge, cast) + this repository.
# The committed artifacts/bundle.json means no Solidity build is needed to deploy a world.
#
#   docker build -f docker/Dockerfile -t foga:dev .
#   docker run --rm --network host foga:dev foga demo
#
# Multi-arch: docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile .

FROM ghcr.io/foundry-rs/foundry:v1.7.1 AS foundry

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/forge /usr/local/bin/cast /usr/local/bin/
WORKDIR /opt/foga
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY bin ./bin
COPY src ./src
COPY build ./build
COPY artifacts ./artifacts
COPY worlds ./worlds
COPY vendor/LOCK.json ./vendor/LOCK.json
COPY contracts ./contracts
COPY scripts ./scripts
COPY docs ./docs
COPY README.md LICENSE NOTICE ./
RUN npm run build && ln -s /opt/foga/bin/foga.js /usr/local/bin/foga && chmod +x /usr/local/bin/foga
VOLUME ["/opt/foga/deployments"]
ENTRYPOINT []
CMD ["foga", "--help"]
