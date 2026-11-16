# Mainnet Lightning node for the EdgeCoder coordinators: LND, plus Bitcoin Core (pruned) for the
# bundled fallback. One image. fly.toml (external mode, the default) runs only the `lnd` process
# against ocean-node; fly.bundled.toml also runs the `bitcoind` process. Real funds: every
# artifact is pinned and verified.
#
# - Bitcoin Core: the official release tarball, checked against the SHA256SUMS entry published
#   at https://bitcoincore.org/bin/bitcoin-core-<version>/SHA256SUMS. Bumping BITCOIN_VERSION
#   needs the matching BITCOIN_SHA256 (x86_64-linux-gnu.tar.gz), or the build fails.
# - LND: the binaries from the official lightninglabs/lnd image, pinned by digest.
# Both run as uid 1000 (lightning); the entrypoint fixes volume ownership, then drops root.
FROM lightninglabs/lnd:v0.21.8-beta@sha256:f17b2944b1b76396cccbe58feac469b6cefb5f407557ac77f0880f136fb935f9 AS lnd

FROM debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS bitcoin
ARG BITCOIN_VERSION=32.1
ARG BITCOIN_SHA256=61545c17c3120fb7412f896d248b11993af04ec8817aad3649c55b2afb044963
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/bitcoin.tar.gz "https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz" \
 && echo "${BITCOIN_SHA256}  /tmp/bitcoin.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/bitcoin.tar.gz -C /tmp \
 && install -m 0755 "/tmp/bitcoin-${BITCOIN_VERSION}/bin/bitcoind" "/tmp/bitcoin-${BITCOIN_VERSION}/bin/bitcoin-cli" /usr/local/bin/ \
 && rm -rf /tmp/bitcoin*

FROM debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq tini && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home --shell /usr/sbin/nologin lightning
COPY --from=bitcoin /usr/local/bin/bitcoind /usr/local/bin/bitcoin-cli /usr/local/bin/
COPY --from=lnd /bin/lnd /bin/lncli /usr/local/bin/
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
COPY --chmod=0755 lncli.sh /usr/local/bin/lnc
COPY --chmod=0755 check-backend.sh /usr/local/bin/check-backend
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
