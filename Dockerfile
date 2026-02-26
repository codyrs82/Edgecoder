FROM node:20-bookworm-slim AS base

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates zstd python3 make g++ bluetooth bluez libbluetooth-dev libudev-dev && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://ollama.com/install.sh | sh

COPY package*.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests

RUN npm run build

EXPOSE 4301 4302 4303 4304 4305

# Entrypoint: if SKIP_OLLAMA=true, skip Ollama entirely (for portal,
# standalone coordinator).  Otherwise start Ollama in the background and
# exec the main command immediately (no blocking wait).
RUN printf '#!/bin/sh\nset -e\nif [ "$SKIP_OLLAMA" != "true" ]; then\n  ollama serve &\n  echo "[entrypoint] ollama started in background"\nfi\nexec "$@"\n' > /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
