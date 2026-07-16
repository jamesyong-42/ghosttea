#!/bin/sh
set -eu

install -m 0600 -o ghosttea -g ghosttea /fixture/authorized_keys /home/ghosttea/.ssh/authorized_keys

for name in password keyboard partial public_key; do
  ssh-keygen -q -t ed25519 -N '' -f "/run/ghosttea-sshd/host_${name}_ed25519_key"
done
ssh-keygen -q -t ecdsa -b 256 -N '' -f /run/ghosttea-sshd/host_ecdsa_aesgcm_ecdsa_key
ssh-keygen -q -t rsa -b 3072 -N '' -f /run/ghosttea-sshd/host_rsa_sha2_rsa_key

/usr/sbin/sshd -t -f /etc/ssh/sshd_config.password
/usr/sbin/sshd -t -f /etc/ssh/sshd_config.keyboard-interactive
/usr/sbin/sshd -t -f /etc/ssh/sshd_config.partial-success
/usr/sbin/sshd -t -f /etc/ssh/sshd_config.public-key
/usr/sbin/sshd -t -f /etc/ssh/sshd_config.ecdsa-aesgcm
/usr/sbin/sshd -t -f /etc/ssh/sshd_config.rsa-sha2

/usr/sbin/sshd -f /etc/ssh/sshd_config.password
/usr/sbin/sshd -f /etc/ssh/sshd_config.keyboard-interactive
/usr/sbin/sshd -f /etc/ssh/sshd_config.partial-success
nc -lk -p 22026 >/dev/null 2>&1 &
/usr/sbin/sshd -f /etc/ssh/sshd_config.ecdsa-aesgcm
/usr/sbin/sshd -f /etc/ssh/sshd_config.rsa-sha2
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config.public-key
