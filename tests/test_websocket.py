"""真实 HTTP 升级与关闭握手回归，用临时库和随机本机端口。"""

import base64
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest

from werkzeug.serving import make_server
from server import create_app
from server.serving import OrbitRequestHandler


class WebSocketTransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.app = create_app({"DATABASE": str(Path(self.directory.name) / "test.sqlite3")})
        self.server = make_server("127.0.0.1", 0, self.app, threaded=True, request_handler=OrbitRequestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.app.extensions["orbit_rooms"].close()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.directory.cleanup()

    def upgrade(self, origin=None):
        sock = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=3)
        headers = (f"GET /ws/arena HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\n"
                   "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {base64.b64encode(b'0123456789abcdef').decode()}\r\nSec-WebSocket-Version: 13\r\n")
        if origin:
            headers += f"Origin: {origin}\r\n"
        sock.sendall((headers + "\r\n").encode())
        data = b""
        while b"\r\n\r\n" not in data:
            data += sock.recv(4096)
        header, rest = data.split(b"\r\n\r\n", 1)
        self.assertIn(b"101 Switching Protocols", header)
        return sock, rest

    def test_close_frame_is_not_followed_by_http_response(self):
        sock, data = self.upgrade()
        try:
            while len(data) < 2 or len(data) < 2 + (data[1] & 127):
                data += sock.recv(4096)
            welcome = json.loads(data[2:2 + (data[1] & 127)])
            self.assertEqual(welcome["type"], "welcome")
            # 发送带掩码的 1000 正常关闭帧。
            mask, payload = b"1234", b"\x03\xe8"
            sock.sendall(b"\x88\x82" + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(payload)))
            closed = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                closed += chunk
            self.assertEqual(closed, b"\x88\x02\x03\xe8")
            self.assertNotIn(b"HTTP/1.1 200", closed)
        finally:
            sock.close()

    def test_foreign_browser_origin_is_rejected(self):
        sock, data = self.upgrade("https://other.example")
        try:
            while len(data) < 4:
                data += sock.recv(4096)
            self.assertEqual(data[0], 0x88)
            self.assertEqual(int.from_bytes(data[2:4], "big"), 1008)
        finally:
            sock.close()
