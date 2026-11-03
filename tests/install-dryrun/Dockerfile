ARG BASE=ubuntu:24.04
FROM ${BASE}
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq systemd systemd-sysv curl ca-certificates sudo >/dev/null && \
    (cd /lib/systemd/system/sysinit.target.wants/ && ls | grep -v systemd-tmpfiles-setup | xargs rm -f) && \
    rm -f /lib/systemd/system/multi-user.target.wants/* /etc/systemd/system/*.wants/* /lib/systemd/system/local-fs.target.wants/* /lib/systemd/system/sockets.target.wants/*udev* /lib/systemd/system/sockets.target.wants/*initctl* || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
