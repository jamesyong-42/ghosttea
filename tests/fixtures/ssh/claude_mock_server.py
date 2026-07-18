#!/usr/bin/env python3
"""Deterministic Anthropic-compatible stream for the Claude Code TUI gate."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys
import time
from urllib.parse import urlparse


HOST = "127.0.0.1"
PORT = 22100
MODEL = "claude-sonnet-4-5-20250929"
RESPONSE = "ghosttea-claude-response-ok"
INTERRUPT_RESPONSE = "ghosttea-claude-interrupt-streaming"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string, *args):
        sys.stderr.write("claude-mock: " + format_string % args + "\n")

    def _json(self, status, payload):
        encoded = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _sse_event(self, name, payload):
        encoded = (
            f"event: {name}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"
        ).encode()
        self.wfile.write(encoded)
        self.wfile.flush()

    @staticmethod
    def _request_text(request):
        text = []
        for message in request.get("messages", []):
            content = message.get("content", [])
            if isinstance(content, str):
                text.append(content)
                continue
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text.append(block.get("text", ""))
        return "\n".join(text)

    def do_GET(self):
        if urlparse(self.path).path == "/v1/models":
            self._json(
                200,
                {
                    "data": [
                        {
                            "id": MODEL,
                            "type": "model",
                            "display_name": "Ghosttea Fixture",
                            "created_at": "2026-07-18T00:00:00Z",
                        }
                    ],
                    "has_more": False,
                    "first_id": MODEL,
                    "last_id": MODEL,
                },
            )
            return
        self._json(404, {"type": "error", "error": {"type": "not_found_error", "message": self.path}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            request = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "invalid JSON"}})
            return

        path = urlparse(self.path).path
        self.log_message("POST %s model=%s stream=%s", path, request.get("model"), request.get("stream"))
        if path.endswith("/count_tokens"):
            self._json(200, {"input_tokens": 32})
            return
        if path != "/v1/messages":
            self._json(404, {"type": "error", "error": {"type": "not_found_error", "message": path}})
            return
        if not request.get("stream"):
            self._json(
                200,
                {
                    "id": "msg_ghosttea_fixture",
                    "type": "message",
                    "role": "assistant",
                    "model": request.get("model", MODEL),
                    "content": [{"type": "text", "text": RESPONSE}],
                    "stop_reason": "end_turn",
                    "stop_sequence": None,
                    "usage": {"input_tokens": 32, "output_tokens": 8},
                },
            )
            return

        events = [
            (
                "message_start",
                {
                    "type": "message_start",
                    "message": {
                        "id": "msg_ghosttea_fixture",
                        "type": "message",
                        "role": "assistant",
                        "model": request.get("model", MODEL),
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": 32, "output_tokens": 1},
                    },
                },
            ),
            (
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text", "text": ""},
                },
            ),
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for name, payload in events:
                self._sse_event(name, payload)

            interrupt = "ghosttea-interrupt-request" in self._request_text(request)
            response = INTERRUPT_RESPONSE if interrupt else RESPONSE
            midpoint = len(response) // 2
            for chunk in (response[:midpoint], response[midpoint:]):
                self._sse_event(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": chunk},
                    },
                )
                time.sleep(0.05)

            if interrupt:
                time.sleep(30)

            self._sse_event(
                "content_block_stop", {"type": "content_block_stop", "index": 0}
            )
            self._sse_event(
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": 8},
                },
            )
            self._sse_event("message_stop", {"type": "message_stop"})
        except (BrokenPipeError, ConnectionResetError):
            self.log_message("client cancelled stream")


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
