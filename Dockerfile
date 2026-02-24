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

# Entrypoint: start ollama serve in the background, wait up to 30s for it
# to be ready, then exec the main command (preserving PID 1 / signal handling).
RUN printf '#!/bin/sh\nset -e\nollama serve &\nfor i in $(seq 1 30); do\n  curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && echo "[entrypoint] ollama ready after ${i}s" && break\n  sleep 1\ndone\nexec "$@"\n' > /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
