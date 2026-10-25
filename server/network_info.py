"""只发现本机地址，不发送游戏数据；用于 localhost 页面生成可分享的局域网链接。"""

import ipaddress
import socket


def lan_addresses():
    addresses = []
    try:
        # UDP connect 仅选择本机路由和源地址，不发送数据包。
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 80))
            addresses.append(probe.getsockname()[0])
    except OSError:
        pass
    try:
        addresses.extend(info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    return list(dict.fromkeys(address for address in addresses
                             if ipaddress.ip_address(address).is_private
                             and not ipaddress.ip_address(address).is_loopback
                             and not ipaddress.ip_address(address).is_link_local))
