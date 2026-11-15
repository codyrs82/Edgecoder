# Public-test-network Lightning node for the EdgeCoder coordinators: Mutinynet (a public signet
# with 30 s blocks, an active Lightning network and a faucet) bitcoind + LND on one small machine.
# Test coins only, but every artifact is still pinned and verified:
#
# - bitcoind: Mutinynet needs a patched Bitcoin Core (the `signetblocktime` option; stock Core
#   rejects 30 s signet blocks). The binary is the release the Mutinynet operators themselves run
#   (github.com/MutinyWallet/mutiny-net, Dockerfile: BITCOIN_VERSION=2fda7bfc027e from
#   github.com/benthecarman/bitcoin release `mutinynet-inq-template-hash`), checked against the
#   SHA256SUMS published with that release.
# - LND: the same official lightninglabs/lnd image as deploy/lnd-mainnet, pinned by digest.
# Both run as uid 1000 (lightning); the entrypoint fixes volume ownership, then drops root.
FROM lightninglabs/lnd:v0.21.8-beta@sha256:f17b2944b1b76396cccbe58feac469b6cefb5f407557ac77f0880f136fb935f9 AS lnd

FROM debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS bitcoin
ARG MUTINYNET_RELEASE=mutinynet-inq-template-hash
ARG BITCOIN_VERSION=2fda7bfc027e
ARG BITCOIN_SHA256=c76b58a078e3e5fcc4597f50d9f9d15da8d11a5d8cf0831ab62970329bfb6115
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/bitcoin.tar.gz "https://github.com/benthecarman/bitcoin/releases/download/${MUTINYNET_RELEASE}/bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz" \
 && echo "${BITCOIN_SHA256}  /tmp/bitcoin.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/bitcoin.tar.gz -C /tmp \
 && install -m 0755 "/tmp/bitcoin-${BITCOIN_VERSION}/bin/bitcoind" "/tmp/bitcoin-${BITCOIN_VERSION}/bin/bitcoin-cli" /usr/local/bin/ \
 && rm -rf /tmp/bitcoin*

FROM debian:bookworm-20261104-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq tini xxd && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home --shell /usr/sbin/nologin lightning
COPY --from=bitcoin /usr/local/bin/bitcoind /usr/local/bin/bitcoin-cli /usr/local/bin/
COPY --from=lnd /bin/lnd /bin/lncli /usr/local/bin/
COPY --chmod=0644 bitcoin.conf /etc/bitcoin-mutinynet.conf
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
COPY --chmod=0755 lncli.sh /usr/local/bin/lnc
COPY --chmod=0755 bcli.sh /usr/local/bin/bcli
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
