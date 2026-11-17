# EdgeCoder's own watchtower (README.md here): a second, minimal LND in watchtower server mode, in
# its own Fly app and region, watching the chain for edgecoder-lnd. Same pinned LND release as
# the main node (../Dockerfile). The tower holds no funds: a justice transaction pays the client's
# own sweep address, and this tower is altruist (no reward).
FROM lightninglabs/lnd:v0.21.8-beta@sha256:f17b2944b1b76396cccbe58feac469b6cefb5f407557ac77f0880f136fb935f9
COPY --chmod=0755 entrypoint.sh /tower-entrypoint.sh
ENTRYPOINT ["/bin/sh", "/tower-entrypoint.sh"]
