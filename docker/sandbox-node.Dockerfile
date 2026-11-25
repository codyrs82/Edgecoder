FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
RUN useradd -m -s /bin/sh sandbox
USER sandbox
WORKDIR /home/sandbox
ENTRYPOINT ["node", "-e"]
