"""本地 Werkzeug 启动适配：WebSocket 握手后不再往连接写入第二份 HTTP 响应。"""

from urllib.parse import urlsplit

from werkzeug.serving import WSGIRequestHandler


class OrbitRequestHandler(WSGIRequestHandler):
    def run_wsgi(self):
        if (urlsplit(self.path).path != "/ws/arena"
                or self.headers.get("Upgrade", "").lower() != "websocket"):
            return super().run_wsgi()
        self.environ = self.make_environ()
        response = None
        try:
            # Flask-Sock / simple-websocket 已直接发送 101 握手和关闭帧。
            # 普通 WSGI 收尾会再发送 HTTP 200，浏览器会将它误读为 WebSocket 帧。
            def finish_response(_status, _headers, _exc_info=None):
                return lambda _data: None
            response = self.server.app(self.environ, finish_response)
            for _data in response:
                pass
        finally:
            if response is not None and hasattr(response, "close"):
                response.close()
            self.close_connection = True
