FROM python:3.12-slim
RUN useradd -m -s /bin/sh sandbox
USER sandbox
WORKDIR /home/sandbox
ENTRYPOINT ["python3", "-c"]
