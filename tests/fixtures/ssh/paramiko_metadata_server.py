#!/usr/bin/python3

import socket
import sys
import threading
import time

import paramiko


HOST = "0.0.0.0"
PORT = 22029
USERNAME = "ghosttea"
NAME = "Ghosttea metadata fixture"
INSTRUCTION = "Supply both test factors."


class MetadataServer(paramiko.ServerInterface):
    def __init__(self):
        self.request = None
        self.command = b""
        self.request_ready = threading.Event()

    def get_allowed_auths(self, username):
        return "keyboard-interactive"

    def check_auth_interactive(self, username, submethods):
        if username != USERNAME:
            return paramiko.AUTH_FAILED
        return paramiko.InteractiveQuery(
            NAME,
            INSTRUCTION,
            ("Fixture password: ", False),
            ("Verification code: ", True),
        )

    def check_auth_interactive_response(self, responses):
        if responses == ["ghosttea-password", "123456"]:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        if kind == "session":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        self.request = "exec"
        self.command = command if isinstance(command, bytes) else command.encode("utf-8")
        self.request_ready.set()
        return True

    def check_channel_shell_request(self, channel):
        self.request = "shell"
        self.request_ready.set()
        return True

    def check_channel_pty_request(
        self,
        channel,
        term,
        width,
        height,
        pixelwidth,
        pixelheight,
        modes,
    ):
        return True


def serve_client(client, host_key):
    transport = paramiko.Transport(client)
    transport.add_server_key(host_key)
    server = MetadataServer()
    try:
        transport.start_server(server=server)
        channel = transport.accept(10)
        if channel is None or not server.request_ready.wait(10):
            return
        channel.settimeout(10)
        if server.request == "exec":
            if b"ghosttea-libssh2-candidate-ok" in server.command:
                channel.sendall(b"ghosttea-libssh2-candidate-ok\n")
            elif b"ghosttea-metadata-ok" in server.command:
                channel.sendall(b"ghosttea-metadata-ok\n")
            else:
                channel.sendall(b"ghosttea-metadata-command-ok\n")
            channel.send_exit_status(0)
            channel.shutdown_write()
            deadline = time.monotonic() + 5
            while (
                transport.is_active()
                and not channel.closed
                and time.monotonic() < deadline
            ):
                time.sleep(0.01)
            return

        received = b""
        while b"GHOSTTEA_%s" not in received and len(received) < 65536:
            chunk = channel.recv(4096)
            if not chunk:
                return
            received += chunk
        channel.sendall(b"GHOSTTEA_READY\n")
        while transport.is_active():
            chunk = channel.recv(4096)
            if not chunk:
                return
    except (EOFError, OSError, paramiko.SSHException, socket.timeout) as error:
        print(f"metadata fixture connection failed: {error}", file=sys.stderr, flush=True)
        return
    finally:
        transport.close()
        client.close()


def main():
    host_key = paramiko.Ed25519Key.from_private_key_file(
        "/run/ghosttea-sshd/host_metadata_ed25519_key"
    )
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((HOST, PORT))
    listener.listen(32)
    while True:
        client, _ = listener.accept()
        threading.Thread(
            target=serve_client,
            args=(client, host_key),
            daemon=True,
        ).start()


if __name__ == "__main__":
    main()
