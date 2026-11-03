# Regtest Lightning test network for exercising EdgeCoder payouts end to end (no real funds).
# One image, three Fly process groups: bitcoind, hub (the coordinators' payout node) and payee
# (stands in for an agent's wallet). LND is a static Go binary, so it runs on the bitcoind base.
FROM lightninglabs/lnd:v0.20.7-beta@sha256:022c478db1f69be30500fa832d4a4266490a2b9211fa3a6b2669ca0b3ff16495 AS lnd
FROM polarlightning/bitcoind:30.0@sha256:6b15e7efb79995a18441806f509e40316428a901f1cdc5c54cd25b03ac513cb9
RUN apt-get update && apt-get install -y --no-install-recommends curl jq ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=lnd /bin/lnd /bin/lncli /usr/local/bin/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
