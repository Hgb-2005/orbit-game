"""开发启动入口：在项目目录运行 python app.py。"""

import os

from server import create_app
from server.network_info import lan_addresses
from server.serving import OrbitRequestHandler

app = create_app()

if __name__ == "__main__":
    if os.environ.get("HOST") == "0.0.0.0":
        for address in lan_addresses():
            print(f"LAN game URL: http://{address}:{os.environ.get('PORT', '5000')}/", flush=True)
    # 默认仅监听本机；需要局域网访问时自行设置 HOST=0.0.0.0。
    app.run(host=os.environ.get("HOST", "127.0.0.1"),
            port=int(os.environ.get("PORT", "5000")), debug=False, threaded=True,
            request_handler=OrbitRequestHandler)
