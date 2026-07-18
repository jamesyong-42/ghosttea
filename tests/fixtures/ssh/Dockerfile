FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS zellij

ADD --checksum=sha256:9a92b94ba52e2b03f3a071a978d90922693221fa8ed59fd7f4819fe90e431996 \
    https://github.com/zellij-org/zellij/releases/download/v0.44.3/zellij-no-web-aarch64-unknown-linux-musl.tar.gz \
    /tmp/zellij-aarch64.tar.gz
ADD --checksum=sha256:f901129919b0a405ac5f278f53acd7fde5d62401324c509b6233038d5c0ad1f9 \
    https://github.com/zellij-org/zellij/releases/download/v0.44.3/zellij-no-web-x86_64-unknown-linux-musl.tar.gz \
    /tmp/zellij-x86_64.tar.gz

RUN architecture="$(dpkg --print-architecture)" \
    && case "$architecture" in \
        arm64) archive=/tmp/zellij-aarch64.tar.gz ;; \
        amd64) archive=/tmp/zellij-x86_64.tar.gz ;; \
        *) echo "unsupported Zellij fixture architecture: $architecture" >&2; exit 1 ;; \
    esac \
    && tar -xzf "$archive" -C /usr/local/bin zellij \
    && chmod 0755 /usr/local/bin/zellij

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS claude-code

RUN npm install --global @anthropic-ai/claude-code@2.1.214 \
    && npm cache clean --force

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

COPY --from=zellij /usr/local/bin/zellij /usr/local/bin/zellij
COPY --from=claude-code /usr/local/bin/node /usr/local/bin/node
COPY --from=claude-code /usr/local/bin/claude /usr/local/bin/claude
COPY --from=claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        gcc \
        btop=1.2.13-1 \
        htop=3.2.2-2 \
        libc6-dev \
        libpam0g-dev \
        netcat-openbsd \
        openssh-server \
        python3-paramiko \
        tmux \
        vim-tiny \
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
    && install -d -m 0700 -o ghosttea -g ghosttea /home/ghosttea/.config/zellij \
    && printf '%s\n' 'show_startup_tips false' 'show_release_notes false' \
        > /home/ghosttea/.config/zellij/config.kdl \
    && chown ghosttea:ghosttea /home/ghosttea/.config/zellij/config.kdl \
    && chmod 0600 /home/ghosttea/.config/zellij/config.kdl \
    && install -d -m 0755 /run/sshd /run/ghosttea-sshd

COPY pam_sshd /etc/pam.d/sshd
COPY sshd_config.common /etc/ssh/sshd_config.ghosttea-common
COPY sshd_config.password /etc/ssh/sshd_config.password
COPY sshd_config.keyboard-interactive /etc/ssh/sshd_config.keyboard-interactive
COPY sshd_config.partial-success /etc/ssh/sshd_config.partial-success
COPY sshd_config.public-key /etc/ssh/sshd_config.public-key
COPY sshd_config.ecdsa-aesgcm /etc/ssh/sshd_config.ecdsa-aesgcm
COPY sshd_config.rsa-sha2 /etc/ssh/sshd_config.rsa-sha2
COPY paramiko_metadata_server.py /usr/local/bin/ghosttea-keyboard-metadata-server
COPY claude_mock_server.py /usr/local/bin/ghosttea-claude-mock-server
COPY entrypoint.sh /usr/local/bin/ghosttea-ssh-fixture

RUN chmod 0755 \
        /usr/local/bin/ghosttea-claude-mock-server \
        /usr/local/bin/ghosttea-keyboard-metadata-server \
        /usr/local/bin/ghosttea-ssh-fixture

EXPOSE 22022 22023 22024 22025 22026 22027 22028 22029

HEALTHCHECK --interval=2s --timeout=1s --retries=15 \
  CMD nc -z 127.0.0.1 22022 \
      && nc -z 127.0.0.1 22023 \
      && nc -z 127.0.0.1 22024 \
      && nc -z 127.0.0.1 22025 \
      && nc -z 127.0.0.1 22026 \
      && nc -z 127.0.0.1 22027 \
      && nc -z 127.0.0.1 22028 \
      && nc -z 127.0.0.1 22029

ENTRYPOINT ["/usr/local/bin/ghosttea-ssh-fixture"]
