FROM node:20-slim
RUN useradd -m -s /bin/sh sandbox
USER sandbox
WORKDIR /home/sandbox
ENTRYPOINT ["node", "-e"]
