FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        gcc \
        libc6-dev \
        libpam0g-dev \
        netcat-openbsd \
        openssh-server \
    && rm -rf /var/lib/apt/lists/*

COPY pam_ghosttea_fixture.c /tmp/pam_ghosttea_fixture.c

RUN gcc -Wall -Wextra -Werror -fPIC -shared \
        -o /usr/lib/$(gcc -dumpmachine)/security/pam_ghosttea_fixture.so \
        /tmp/pam_ghosttea_fixture.c -lpam \
    && rm /tmp/pam_ghosttea_fixture.c \
    && apt-get purge --yes gcc libc6-dev libpam0g-dev \
    && apt-get autoremove --yes \
    && useradd --create-home --shell /bin/sh ghosttea \
    && printf '%s\n' 'ghosttea:ghosttea-password' | chpasswd \
    && install -d -m 0700 -o ghosttea -g ghosttea /home/ghosttea/.ssh \
    && install -d -m 0755 /run/sshd /run/ghosttea-sshd

COPY pam_sshd /etc/pam.d/sshd
COPY sshd_config.common /etc/ssh/sshd_config.ghosttea-common
COPY sshd_config.password /etc/ssh/sshd_config.password
COPY sshd_config.keyboard-interactive /etc/ssh/sshd_config.keyboard-interactive
COPY sshd_config.partial-success /etc/ssh/sshd_config.partial-success
COPY sshd_config.public-key /etc/ssh/sshd_config.public-key
COPY sshd_config.ecdsa-aesgcm /etc/ssh/sshd_config.ecdsa-aesgcm
COPY entrypoint.sh /usr/local/bin/ghosttea-ssh-fixture

RUN chmod 0755 /usr/local/bin/ghosttea-ssh-fixture

EXPOSE 22022 22023 22024 22025 22026 22027

HEALTHCHECK --interval=2s --timeout=1s --retries=15 \
  CMD nc -z 127.0.0.1 22022 \
      && nc -z 127.0.0.1 22023 \
      && nc -z 127.0.0.1 22024 \
      && nc -z 127.0.0.1 22025 \
      && nc -z 127.0.0.1 22026 \
      && nc -z 127.0.0.1 22027

ENTRYPOINT ["/usr/local/bin/ghosttea-ssh-fixture"]
