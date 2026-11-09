"""服务端权威圆形障碍碰撞；球体、分身和孢子共享同一推出规则。"""

from __future__ import annotations

import math

from .entities import keep_inside


def resolve_obstacles(entity, obstacles, bounds=None, passes=3):
    if not obstacles:
        return entity
    for _ in range(passes):
        changed = False
        for obstacle in obstacles:
            dx = entity["x"] - obstacle["x"]
            dy = entity["y"] - obstacle["y"]
            distance = math.hypot(dx, dy)
            minimum = entity["radius"] + obstacle["radius"]
            if distance >= minimum:
                continue
            if distance < 1e-6:
                dx, dy, distance = 1.0, 0.0, 1.0
            nx, ny = dx / distance, dy / distance
            entity["x"] = obstacle["x"] + nx * minimum
            entity["y"] = obstacle["y"] + ny * minimum
            inward = entity.get("vx", 0) * nx + entity.get("vy", 0) * ny
            if inward < 0:
                entity["vx"] -= inward * nx * 1.12
                entity["vy"] -= inward * ny * 1.12
            impulse_in = entity.get("impulseX", 0) * nx + entity.get("impulseY", 0) * ny
            if impulse_in < 0:
                entity["impulseX"] -= impulse_in * nx * 1.08
                entity["impulseY"] -= impulse_in * ny * 1.08
            changed = True
        if not changed:
            break
    if bounds:
        keep_inside(entity, bounds)
    return entity


def map_is_clear(point, game_map, radius=0):
    for obstacle in game_map.get("obstacles", []):
        if math.hypot(point["x"] - obstacle["x"], point["y"] - obstacle["y"]) < obstacle["radius"] + radius:
            return False
    return True

