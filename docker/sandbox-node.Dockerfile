FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
RUN useradd -m -s /bin/sh sandbox
USER sandbox
WORKDIR /home/sandbox
ENTRYPOINT ["node", "-e"]
