"""房间和 WebSocket 协议。单进程内一个模拟线程；网络发送始终在各连接线程完成。"""

from collections import deque
from dataclasses import dataclass, field
import json
import logging
import secrets
import threading
import time
from urllib.parse import urlsplit

from flask import request
from flask_sock import Sock
from simple_websocket import ConnectionClosed

from .database import save_record
from .game.world import MultiplayerWorld
from .game.rules import RoomRules
from .replication import FoodFrame
from .replication import encode

LOG = logging.getLogger(__name__)
RECONNECT_GRACE = 10.0
ROOM_CAPACITY = 4
BOT_NAMES = ("人机·薄荷", "人机·追猎", "人机·小橘")


@dataclass
class Peer:
    id: str
    resume_token: str = ""
    name: str = ""
    room: str = ""
    ready: bool = False
    connected: bool = True
    reconnect_deadline: float = 0
    messages: deque = field(default_factory=lambda: deque(maxlen=32))
    pending_state: object = None
    pending_foods: object = None
    food_baseline: object = None
    food_version: int = -1
    food_round: str = ""
    event_cursor: int = 0
    event_round: str = ""
    rate_start: float = 0
    rate_count: int = 0


@dataclass
class Room:
    code: str
    host: str
    members: list = field(default_factory=list)
    state: str = "waiting"
    round_id: str = ""
    world: object = None
    saved: bool = False
    broadcast_timer: float = 0
    food_version: int = -1
    food_frame: object = None
    rules: RoomRules = field(default_factory=RoomRules)


class RoomManager:
    """所有房间操作共用短锁；网络慢客户端只覆盖旧快照，不会拖住其他玩家。"""

    def __init__(self, save_score=None, clock=time.monotonic):
        self.clock = clock
        self.save_score = save_score or (lambda score: None)
        self.lock = threading.RLock()
        self.peers = {}
        self.rooms = {}
        self.pending_records = []
        self.stop_event = threading.Event()
        self.thread = None

    def connect(self):
        with self.lock:
            if len(self.peers) >= 64:
                raise ValueError("连接人数已满，请稍后再试。")
            peer = Peer(secrets.token_urlsafe(12), resume_token=secrets.token_urlsafe(24), rate_start=self.clock())
            peer.messages.append({"type": "welcome", "playerId": peer.id, "resumeToken": peer.resume_token, "protocol": 1})
            self.peers[peer.id] = peer
            return peer.id

    def start_thread(self):
        with self.lock:
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(target=self.run, name="orbit-rooms", daemon=True)
                self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=2)

    def run(self):
        previous, accumulator = self.clock(), 0
        step = 1 / 30
        while not self.stop_event.wait(.005):
            now = self.clock()
            accumulator += min(.5, max(0, now - previous))
            previous = now
            while accumulator >= step:
                try:
                    self.advance(step)
                except Exception:
                    LOG.exception("Room simulation failed")
                accumulator -= step

    def advance(self, dt):
        with self.lock:
            self.reap_disconnected()
            records, self.pending_records = self.pending_records, []
            for room in list(self.rooms.values()):
                if room.state != "playing":
                    continue
                room.world.update(dt)
                room.broadcast_timer += dt
                if room.world.finished:
                    room.state = "finished"
                    self.broadcast_room(room)
                    if not room.saved:
                        room.saved = True
                        records.append((self.human_score(room), tuple(room.members)))
                # 20Hz 状态广播让局域网输入更快反映到其他客户端；每个连接仍只保留最新快照。
                interval = 1 / 20
                if room.broadcast_timer + 1e-9 >= interval or room.state == "finished":
                    # 保留余量且容忍浮点误差：30Hz 模拟的一秒正好广播 20 次。
                    # 卡顿后只广播最新状态，不补发已经过期的中间帧。
                    intervals = int((room.broadcast_timer + 1e-9) / interval)
                    room.broadcast_timer = max(0.0, room.broadcast_timer - intervals * interval)
                    self.broadcast_state(room)
        # SQLite I/O 不持有游戏锁；只保存服务器计算出的分数。
        for score, members in records:
            try:
                self.save_score(score)
                # 保存完成后再通知浏览器读取记录，避免结算快照先到而读到旧纪录。
                with self.lock:
                    for pid in members:
                        if pid in self.peers:
                            self.peers[pid].messages.append({"type": "record_saved"})
            except Exception:
                LOG.exception("Could not persist multiplayer score")
                with self.lock:
                    self.pending_records.append((score, members))

    def drain(self, peer_id):
        with self.lock:
            peer = self.peers.get(peer_id)
            if not peer:
                return []
            messages = list(peer.messages)
            peer.messages.clear()
            if peer.pending_foods is not None:
                frame = peer.pending_foods
                baseline = peer.food_baseline if peer.food_round == frame.round_id else None
                messages.append(frame.message(baseline, peer.food_version))
                peer.food_baseline, peer.food_version, peer.food_round = frame.foods, frame.version, frame.round_id
                peer.pending_foods = None
            if peer.pending_state is not None:
                state = peer.pending_state
                cursor = peer.event_cursor if peer.event_round == state["roundId"] else 0
                events = [event for event in state["world"]["events"] if event["id"] > cursor]
                messages.append(encode({**state, "world": {**state["world"], "events": events}}))
                if events:
                    peer.event_cursor = events[-1]["id"]
                else:
                    peer.event_cursor = cursor
                peer.event_round = state["roundId"]
                peer.pending_state = None
            return messages

    def reap_disconnected(self):
        """超过宽限期仍未回来才从房间和权威世界中移除玩家。"""
        now = self.clock()
        expired = [peer.id for peer in self.peers.values()
                   if not peer.connected and peer.reconnect_deadline and peer.reconnect_deadline <= now]
        for peer_id in expired:
            self.leave(peer_id)
            self.peers.pop(peer_id, None)

    def socket_closed(self, peer_id):
        """网络断开时保留短暂恢复窗口；主动 leave 仍由 disconnect 立即清理。"""
        with self.lock:
            peer = self.peers.get(peer_id)
            if not peer:
                return
            if not peer.room:
                self.peers.pop(peer_id, None)
                return
            peer.connected = False
            peer.reconnect_deadline = self.clock() + RECONNECT_GRACE
            room = self.rooms.get(peer.room)
            if room and room.world and peer_id in room.world.players:
                room.world.stop_input(room.world.players[peer_id])
            if room:
                self.broadcast_room(room)

    def resume(self, peer_id, token):
        """把新 WebSocket 绑定回断线前的玩家身份，避免重连后变成新成员。"""
        with self.lock:
            newcomer = self.peers.get(peer_id)
            if not newcomer or not isinstance(token, str) or not token:
                raise ValueError("本局恢复凭证无效，请重新加入房间。")
            now = self.clock()
            previous = next((peer for peer in self.peers.values()
                             if peer.id != peer_id and not peer.connected and peer.resume_token == token
                             and peer.reconnect_deadline > now and peer.room), None)
            if not previous:
                raise ValueError("恢复窗口已结束，请重新加入房间。")
            room = self.rooms.get(previous.room)
            if not room:
                raise ValueError("房间已关闭，请重新加入。")
            previous.connected = True
            previous.reconnect_deadline = 0
            previous.rate_start, previous.rate_count = now, 0
            previous.messages.clear()
            previous.pending_state = previous.pending_foods = None
            previous.food_baseline, previous.food_version, previous.food_round = None, -1, ""
            if room.world and previous.id in room.world.players:
                room.world.players[previous.id]["connected"] = True
            self.peers.pop(peer_id, None)
            previous.messages.append({"type": "resumed", "playerId": previous.id, "roundId": room.round_id})
            self.broadcast_room(room)
            if room.world:
                self.broadcast_state(room)
            return previous.id

    def room_snapshot(self, room):
        ai_count = len(getattr(room.world, "bot_ids", ())) if room.world else max(0, ROOM_CAPACITY - len(room.members))
        return {"type": "room", "code": room.code, "hostId": room.host, "state": room.state,
                "roundId": room.round_id, "capacity": ROOM_CAPACITY, "aiCount": ai_count,
                "participantCount": len(room.members) + ai_count, "rules": room.rules.snapshot(),
                "members": [{"id": peer.id, "name": peer.name, "ready": peer.ready, "connected": peer.connected,
                             "team": room.world.players[pid]["team"] if room.world and pid in room.world.players
                             else index % 2 if room.rules.mode == "teams" else None}
                            for index, pid in enumerate(room.members) if (peer := self.peers.get(pid))]}

    @staticmethod
    def human_score(room):
        """最高分只取真人，避免补位人机把联机纪录写成 AI 分数。"""
        if not room.world:
            return 0
        human_ids = getattr(room.world, "human_ids", room.members)
        return max((room.world.players[pid]["score"] for pid in human_ids if pid in room.world.players), default=0)

    def broadcast_room(self, room):
        payload = self.room_snapshot(room)
        for pid in room.members:
            self.peers[pid].messages.append(payload)

    def broadcast_state(self, room):
        world = room.world.snapshot()
        foods = world.pop("foods")
        # 只保留最新食物帧；drain 相对该连接已发送的基线合成补丁。
        # 中间帧被覆盖也不会丢失食物的增加、移除或换位。
        if room.food_version != room.world.food_version:
            room.food_version = room.world.food_version
            room.food_frame = FoodFrame.capture(room.round_id, room.food_version, foods)
        payload = {"type": "state", "roundId": room.round_id, "world": world}
        for pid in room.members:
            peer = self.peers[pid]
            if peer.food_round != room.round_id or peer.food_version != room.food_version or peer.food_baseline is None:
                peer.pending_foods = room.food_frame
            peer.pending_state = payload

    @staticmethod
    def nickname(value):
        if not isinstance(value, str):
            raise ValueError("请输入昵称。")
        name = "".join(c for c in value.strip() if c.isprintable())
        if not 1 <= len(name) <= 12:
            raise ValueError("昵称需要 1～12 个字。")
        return name

    def command(self, peer_id, message):
        with self.lock:
            peer = self.peers.get(peer_id)
            if not peer:
                return peer_id
            try:
                if not isinstance(message, dict):
                    raise ValueError("无效消息。")
                now = self.clock()
                if now - peer.rate_start >= 1:
                    peer.rate_start, peer.rate_count = now, 0
                peer.rate_count += 1
                if peer.rate_count > 100:
                    return peer_id
                kind = message.get("type")
                if kind == "resume":
                    return self.resume(peer_id, message.get("token"))
                if kind == "ping":
                    peer.messages.append({"type": "pong", "sent": message.get("sent")})
                    return peer_id
                if kind in ("create", "join"):
                    if peer.room:
                        raise ValueError("请先退出当前房间。")
                    name = self.nickname(message.get("name"))
                    if kind == "create":
                        if len(self.rooms) >= 16:
                            raise ValueError("房间数量已满。")
                        code = f"{secrets.randbelow(1_000_000):06d}"
                        while code in self.rooms:
                            code = f"{secrets.randbelow(1_000_000):06d}"
                        room = Room(code, peer.id, rules=RoomRules.parse(message.get("rules")))
                        self.rooms[code] = room
                    else:
                        code = message.get("code")
                        if not isinstance(code, str) or len(code) != 6 or not code.isascii() or not code.isdigit():
                            raise ValueError("请输入 6 位数字房间号。")
                        room = self.rooms.get(code)
                        if not room:
                            raise ValueError("房间不存在，或房间已关闭。")
                        if room.state != "waiting":
                            raise ValueError("对局已开始，请等房主返回准备室。")
                        if len(room.members) >= ROOM_CAPACITY:
                            raise ValueError("房间已满，最多 4 人。")
                        if any(self.peers[pid].name == name for pid in room.members):
                            raise ValueError("昵称重复，请换一个名字。")
                    peer.name, peer.room, peer.ready = name, room.code, False
                    room.members.append(peer.id)
                    if room.rules.mode == "teams":
                        for pid in room.members:
                            self.peers[pid].ready = False
                    self.broadcast_room(room)
                    return peer_id
                if kind == "leave":
                    self.leave(peer_id)
                    peer.messages.append({"type": "left"})
                    return peer_id
                room = self.rooms.get(peer.room)
                if not room:
                    raise ValueError("请先创建或加入房间。")
                if kind == "ready":
                    if room.state != "waiting":
                        raise ValueError("对局中不能更改准备状态。")
                    peer.ready = message.get("ready") is True
                    self.broadcast_room(room)
                elif kind == "configure":
                    if room.host != peer.id or room.state != "waiting":
                        raise ValueError("只有房主可以在准备室调整规则。")
                    rules = RoomRules.parse(message.get("rules"))
                    if rules != room.rules:
                        room.rules = rules
                        # 改规则后重新确认，防止有人按旧规则准备后被直接开局。
                        for pid in room.members:
                            self.peers[pid].ready = False
                        self.broadcast_room(room)
                elif kind == "start":
                    if room.host != peer.id:
                        raise ValueError("只有房主可以开始对局。")
                    if room.state != "waiting" or not room.members or not all(self.peers[pid].ready and self.peers[pid].connected for pid in room.members):
                        raise ValueError("需要房间内真人全部准备后开始；空位会自动补人机。")
                    participants = [{"id": pid, "name": self.peers[pid].name} for pid in room.members]
                    for index in range(ROOM_CAPACITY - len(participants)):
                        participants.append({"id": f"ai-{room.code}-{index + 1}",
                                             "name": BOT_NAMES[index % len(BOT_NAMES)], "isBot": True,
                                             "role": ("forager", "rival", "hunter")[index % 3]})
                    room.world = MultiplayerWorld(participants, rules=room.rules)
                    room.round_id, room.state, room.saved = secrets.token_hex(8), "playing", False
                    room.broadcast_timer = 0
                    room.food_version = -1
                    self.broadcast_room(room)
                    self.broadcast_state(room)
                elif kind == "resync_foods":
                    if room.world and message.get("roundId") == room.round_id:
                        peer.food_baseline = None
                        self.broadcast_state(room)
                elif kind == "input":
                    if room.state == "playing" and message.get("roundId") == room.round_id:
                        room.world.set_input(peer.id, message)
                elif kind == "stop":
                    if room.state == "playing":
                        room.world.stop_input(room.world.players[peer.id])
                elif kind == "rematch":
                    if room.host != peer.id or room.state != "finished":
                        raise ValueError("等待本局结束，由房主返回准备室。")
                    room.state, room.world = "waiting", None
                    room.food_frame = None
                    for pid in room.members:
                        self.peers[pid].ready = False
                        self.peers[pid].pending_state = None
                        self.peers[pid].pending_foods = None
                        self.peers[pid].food_baseline = None
                    self.broadcast_room(room)
                else:
                    raise ValueError("不支持的房间操作。")
            except ValueError as error:
                peer.messages.append({"type": "error", "message": str(error),
                                      "code": "resume_expired" if isinstance(message, dict) and message.get("type") == "resume" else "invalid_command"})
            return peer_id

    def leave(self, peer_id):
        with self.lock:
            peer = self.peers.get(peer_id)
            if not peer:
                return
            room = self.rooms.get(peer.room)
            peer.room, peer.ready, peer.pending_state, peer.pending_foods = "", False, None, None
            if not room:
                return
            if peer_id in room.members:
                room.members.remove(peer_id)
            if not room.members:
                # 同一帧全员退出时房间也会被清理，已计算的分数仍交给模拟线程保存。
                if room.world and not room.saved:
                    room.saved = True
                    self.pending_records.append((self.human_score(room), ()))
                del self.rooms[room.code]
                return
            if room.host == peer_id:
                room.host = room.members[0]
            if room.state == "waiting" and room.rules.mode == "teams":
                # 席位变化会调整队伍，旧队伍下的准备状态不能直接沿用。
                for pid in room.members:
                    self.peers[pid].ready = False
            if room.world:
                room.world.disconnect(peer_id)
                # 保留 playing 让下一次 advance 统一处理结算和保存。
                self.broadcast_state(room)
            self.broadcast_room(room)

    def disconnect(self, peer_id):
        with self.lock:
            self.leave(peer_id)
            self.peers.pop(peer_id, None)


def init_multiplayer(app):
    def persist(score):
        with app.app_context():
            return save_record(score)
    manager = RoomManager(persist)
    app.extensions["orbit_rooms"] = manager
    app.config["SOCK_SERVER_OPTIONS"] = {"ping_interval": 15, "max_message_size": 4096}
    sock = Sock(app)

    @sock.route("/ws/arena")
    def arena(ws):
        # 浏览器只能从本服务页面连接；局域网 IP 和 localhost 各自同源即可。
        origin = request.headers.get("Origin")
        if origin and urlsplit(origin).netloc != request.host:
            ws.close(reason=1008, message="Origin rejected")
            return
        try:
            peer_id = manager.connect()
        except ValueError as error:
            ws.send(json.dumps({"type": "error", "message": str(error)}, ensure_ascii=False))
            return
        manager.start_thread()
        try:
            while ws.connected:
                for payload in manager.drain(peer_id):
                    ws.send(payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
                incoming = ws.receive(timeout=.015)
                if incoming is None:
                    continue
                try:
                    message = json.loads(incoming)
                except (ValueError, TypeError, UnicodeDecodeError):
                    message = None
                peer_id = manager.command(peer_id, message) or peer_id
        except ConnectionClosed:
            pass
        finally:
            manager.socket_closed(peer_id)
            # 接收线程会先唤醒 receive，再写关闭帧。等待它完成，防止 Werkzeug 的
            # HTTP 收尾响应抢在关闭帧之前写入同一 socket（Windows 下尤其容易出现）。
            if not ws.connected:
                ws.thread.join(timeout=1)
