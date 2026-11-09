"""服务端地图契约：分享链接和 WebSocket 数据都必须经过这里校验。"""

from __future__ import annotations

import copy
import math
import re


MAP_VERSION = 1
MAP_LIMITS = {
    "min_width": 1600,
    "max_width": 4800,
    "min_height": 1200,
    "max_height": 3600,
    "max_spikes": 32,
    "max_obstacles": 48,
    "max_spawns": 4,
}
DEFAULT_MAP = {
    "version": MAP_VERSION,
    "id": "default",
    "name": "微光标准场",
    "width": 3200,
    "height": 2200,
    "spawnPoints": [
        {"id": "spawn-1", "x": 800, "y": 550},
        {"id": "spawn-2", "x": 2400, "y": 1650},
        {"id": "spawn-3", "x": 2400, "y": 550},
        {"id": "spawn-4", "x": 800, "y": 1650},
    ],
    "spikes": [],
    "obstacles": [],
}

_ID = re.compile(r"^[a-z0-9_-]{1,48}$")
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class MapValidationError(ValueError):
    """地图不符合当前协议。"""


def _number(value, label, low, high, *, integer=False):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise MapValidationError(f"{label}必须是 {low}～{high} 之间的数字。")
    if integer and not float(value).is_integer():
        raise MapValidationError(f"{label}必须是整数。")
    return round(float(value), 3)


def _text(value, label, fallback, maximum=32, *, required=False):
    clean = value.strip() if isinstance(value, str) else ""
    clean = "".join(character for character in clean if character.isprintable())[:maximum]
    if not clean and required:
        raise MapValidationError(f"{label}不能为空。")
    if not clean:
        clean = fallback
    return clean


def _identifier(value, label, fallback, *, required=False):
    clean = value.strip().lower() if isinstance(value, str) else ""
    if required and not clean:
        raise MapValidationError(f"{label}不能为空。")
    if not clean:
        clean = fallback
    if not _ID.fullmatch(clean):
        raise MapValidationError(f"{label}格式无效。")
    return clean


def _point(value, width, height, label, margin=20):
    if not isinstance(value, dict):
        raise MapValidationError(f"{label}必须是坐标对象。")
    x, y = _number(value.get("x"), f"{label} x", margin, width - margin), _number(
        value.get("y"), f"{label} y", margin, height - margin
    )
    return {"x": x, "y": y}


def normalize_map(value, strict=True):
    """返回独立、规范化副本；strict=False 时坏数据回退标准场。"""
    if not strict:
        try:
            return normalize_map(value, strict=True)
        except (MapValidationError, TypeError, ValueError):
            return copy.deepcopy(DEFAULT_MAP)
    if not isinstance(value, dict) or isinstance(value, list):
        raise MapValidationError("地图必须是 JSON 对象。")
    version = value.get("version", MAP_VERSION)
    if version != MAP_VERSION:
        raise MapValidationError(f"不支持的地图版本：{version!r}。")
    width = _number(value.get("width"), "地图宽度", MAP_LIMITS["min_width"], MAP_LIMITS["max_width"], integer=True)
    height = _number(value.get("height"), "地图高度", MAP_LIMITS["min_height"], MAP_LIMITS["max_height"], integer=True)
    spawn_values = value.get("spawnPoints", [])
    spike_values = value.get("spikes", [])
    obstacle_values = value.get("obstacles", [])
    for label, items, limit in (
        ("出生点", spawn_values, MAP_LIMITS["max_spawns"]),
        ("刺球", spike_values, MAP_LIMITS["max_spikes"]),
        ("障碍物", obstacle_values, MAP_LIMITS["max_obstacles"]),
    ):
        if not isinstance(items, list) or len(items) > limit:
            raise MapValidationError(f"{label}格式无效或超过 {limit} 个。")
    if len(spawn_values) < 1:
        raise MapValidationError("地图至少需要一个出生点。")

    spawns = []
    for index, item in enumerate(spawn_values):
        if not isinstance(item, dict):
            raise MapValidationError("出生点必须是坐标对象。")
        spawns.append({
            "id": _identifier(item.get("id"), "出生点 ID", f"spawn-{index + 1}", required=True),
            **_point(item, width, height, f"出生点 {index + 1}", 80),
        })
    spikes = []
    for index, item in enumerate(spike_values):
        if not isinstance(item, dict):
            raise MapValidationError("刺球必须是坐标对象。")
        color = item.get("color")
        if not isinstance(color, str) or not _COLOR.fullmatch(color):
            raise MapValidationError(f"刺球 {index + 1} 颜色必须使用 #RRGGBB。")
        spikes.append({
            "id": _identifier(item.get("id"), "刺球 ID", f"spike-{index + 1}", required=True),
            **_point(item, width, height, f"刺球 {index + 1}", 24),
            "radius": _number(item.get("radius"), "刺球半径", 24, 110),
            "color": color,
        })
    obstacles = []
    for index, item in enumerate(obstacle_values):
        if not isinstance(item, dict):
            raise MapValidationError("障碍物必须是坐标对象。")
        color = item.get("color")
        if not isinstance(color, str) or not _COLOR.fullmatch(color):
            raise MapValidationError(f"障碍物 {index + 1} 颜色必须使用 #RRGGBB。")
        obstacle = {
            "id": _identifier(item.get("id"), "障碍物 ID", f"obstacle-{index + 1}", required=True),
            **_point(item, width, height, f"障碍物 {index + 1}", 20),
            "radius": _number(item.get("radius"), "障碍物半径", 30, 360),
            "color": color,
        }
        for spawn in spawns:
            if math.hypot(obstacle["x"] - spawn["x"], obstacle["y"] - spawn["y"]) < obstacle["radius"] + 72:
                raise MapValidationError(f"{obstacle['id']} 覆盖了出生点。")
        for other in obstacles:
            if math.hypot(obstacle["x"] - other["x"], obstacle["y"] - other["y"]) < obstacle["radius"] + other["radius"]:
                raise MapValidationError("障碍物不能互相覆盖。")
        obstacles.append(obstacle)

    identifiers = [item["id"] for item in spawns + spikes + obstacles]
    if len(identifiers) != len(set(identifiers)):
        raise MapValidationError("地图物件 ID 不能重复。")
    return {
        "version": MAP_VERSION,
        "id": _identifier(value.get("id"), "地图 ID", "custom-map", required=True),
        "name": _text(value.get("name"), "地图名称", "未命名球场", required=True),
        "width": width,
        "height": height,
        "spawnPoints": spawns,
        "spikes": spikes,
        "obstacles": obstacles,
    }


def map_summary(value):
    game_map = normalize_map(value, strict=False)
    return {
        key: game_map[key] for key in ("version", "id", "name", "width", "height")
    } | {
        "spawnPoints": len(game_map["spawnPoints"]),
        "spikes": len(game_map["spikes"]),
        "obstacles": len(game_map["obstacles"]),
    }

