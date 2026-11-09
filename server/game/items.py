"""服务端权威地图道具：刷新、拾取、持续效果、磁铁和吞噬连击。"""

import math
import random

from .entities import clamp
from .obstacles import map_is_clear
from .rules import EAT_RADIUS_RATIO

ITEM_TYPES = ("shield", "magnet", "speed", "cloak")
ITEM_MODES = {
    "off": (0, 0),
    "standard": (18, 4.5),
    "rich": (36, 2.4),
}
ITEM_DURATION = {"shield": 8, "magnet": 10, "speed": 7, "cloak": 7}
ITEM_COLORS = {"shield": "#82b8d8", "magnet": "#d7bc77", "speed": "#dd8f82", "cloak": "#b2a4dc"}
ITEM_LABELS = {"shield": "护盾", "magnet": "磁铁", "speed": "加速", "cloak": "隐身"}
PICKUP_PADDING = 12
SPEED_MULTIPLIER = 1.45
MAGNET_RADIUS = 230
MAGNET_SPEED = 420
COMBO_WINDOW = 3.5


class ItemSystem:
    def __init__(self, world, mode="standard"):
        self.world = world
        self.mode = mode if mode in ITEM_MODES else "standard"
        self.items = []
        self.effects = {}
        self.combos = {}
        self.block_times = {}
        self.refill = 0.0
        self.next_id = 0
        for _ in range(ITEM_MODES[self.mode][0]):
            self.items.append(self.create())

    def create(self):
        self.next_id += 1
        kind = self.world.rng.choice(ITEM_TYPES)
        point = {"x": self.world.bounds_width / 2, "y": self.world.bounds_height / 2}
        for _ in range(30):
            candidate = {"x": self.world.rng.uniform(24, self.world.bounds_width - 24),
                         "y": self.world.rng.uniform(24, self.world.bounds_height - 24)}
            if map_is_clear(candidate, self.world.map, 12):
                point = candidate
                break
        return {"id": f"item-{self.next_id}", "type": kind, **point, "radius": 12,
                "color": ITEM_COLORS[kind], "symbol": ITEM_LABELS[kind][0]}

    def active(self, owner_id, kind):
        return self.effects.get(owner_id, {}).get(kind, -1) > self.world.elapsed

    def shield_active(self, owner_id):
        return self.active(owner_id, "shield")

    def speed_multiplier(self, owner_id):
        return SPEED_MULTIPLIER if self.active(owner_id, "speed") else 1

    def hidden_from(self, owner_id, observer_id):
        if owner_id == observer_id:
            return False
        owner, observer = self.world.players.get(owner_id), self.world.players.get(observer_id)
        if owner and observer and owner.get("team") is not None and owner.get("team") == observer.get("team"):
            return False
        return self.active(owner_id, "cloak")

    def apply(self, owner_id, kind):
        current = self.effects.setdefault(owner_id, {})
        current[kind] = self.world.elapsed + ITEM_DURATION[kind]

    def clear_owner(self, owner_id):
        self.effects.pop(owner_id, None)
        self.combos.pop(owner_id, None)
        self.block_times.pop(owner_id, None)

    def record_shield_block(self, owner_id):
        """同一被保护球在短时间内只产生一次挡吞反馈。"""
        if self.world.elapsed - self.block_times.get(owner_id, float("-inf")) < 0.75:
            return False
        self.block_times[owner_id] = self.world.elapsed
        return True

    def register_eat(self, owner_id):
        current = self.combos.get(owner_id)
        count = current["count"] + 1 if current and current["lastAt"] + COMBO_WINDOW >= self.world.elapsed else 1
        self.combos[owner_id] = {"count": count, "lastAt": self.world.elapsed}
        return count

    def combo(self, owner_id):
        current = self.combos.get(owner_id)
        remaining = max(0.0, current["lastAt"] + COMBO_WINDOW - self.world.elapsed) if current else 0
        return {"count": current["count"] if remaining else 0, "remaining": remaining, "window": COMBO_WINDOW}

    def update(self, dt):
        expired = [(owner_id, kind) for owner_id, effects in self.effects.items()
                   for kind, until in effects.items() if until <= self.world.elapsed]
        self.effects = {owner: {kind: until for kind, until in effects.items() if until > self.world.elapsed}
                        for owner, effects in self.effects.items()}
        self.effects = {owner: effects for owner, effects in self.effects.items() if effects}
        for owner_id, kind in expired:
            owner = self.world.players.get(owner_id)
            if owner:
                self.world.emit("effect-end", owner, itemType=kind, label=ITEM_LABELS[kind])
        self.pickup()
        self.magnet(dt)
        count, interval = ITEM_MODES[self.mode]
        if interval and len(self.items) < count:
            self.refill += dt
            while self.refill >= interval and len(self.items) < count:
                self.refill -= interval
                self.items.append(self.create())
        else:
            self.refill = 0

    def pickup(self):
        for item in list(self.items):
            nearest = None
            nearest_distance = float("inf")
            for cell in self.world.all_cells():
                distance = (cell["x"] - item["x"]) ** 2 + (cell["y"] - item["y"]) ** 2
                if distance <= (cell["radius"] + PICKUP_PADDING) ** 2 and distance < nearest_distance:
                    nearest, nearest_distance = cell, distance
            if nearest is None:
                continue
            self.items.remove(item)
            owner = self.world.players[nearest["ownerId"]]
            self.apply(owner["ownerId"], item["type"])
            self.world.emit("item", owner, itemType=item["type"], x=item["x"], y=item["y"],
                            color=item["color"], label=ITEM_LABELS[item["type"]])

    def magnet(self, dt):
        changed = False
        for owner_id, effects in self.effects.items():
            if effects.get("magnet", -1) <= self.world.elapsed:
                continue
            cells = self.world.cells.get(owner_id, [])
            source = max((cell for cell in cells if cell["alive"]), key=lambda cell: cell["mass"], default=None)
            if source is None:
                continue
            for food in self.world.foods:
                dx, dy = source["x"] - food["x"], source["y"] - food["y"]
                distance = math.hypot(dx, dy)
                if distance <= 0.001 or distance > MAGNET_RADIUS:
                    continue
                step = min(distance, MAGNET_SPEED * dt)
                next_x = clamp(food["x"] + dx / distance * step, food["radius"], self.world.bounds_width - food["radius"])
                next_y = clamp(food["y"] + dy / distance * step, food["radius"], self.world.bounds_height - food["radius"])
                if next_x != food["x"] or next_y != food["y"]:
                    food["x"], food["y"] = next_x, next_y
                    changed = True
        # 食物通过版本号增量同步；磁铁移动也必须进入下一帧补丁。
        if changed:
            self.world.food_version += 1

    def snapshot(self):
        return {"mode": self.mode, "items": [dict(item) for item in self.items],
                "effects": {owner: dict(effects) for owner, effects in self.effects.items()}}
