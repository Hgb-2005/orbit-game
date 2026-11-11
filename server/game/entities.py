"""移动、分裂和合体；参数与单机 core/entities.js、core/cells.js 保持一致。"""

import math

from .rules import BOUNDARY_POLICY, BOUNDARY_RESTITUTION

BOUNDS = {"width": 3200, "height": 2200}
INITIAL_MASS = 36
MAX_CELLS = 8


def clamp(value, low, high):
    return max(low, min(high, value))


def grow(ball, amount):
    ball["mass"] += amount
    ball["radius"] = math.sqrt(ball["mass"]) * 3
    ball["speed"] = max(65, 220 * (36 / ball["mass"]) ** .25)


def ball(ball_id, owner, position):
    entity = {"id": ball_id, "ownerId": owner["ownerId"], **position,
              "name": owner["name"], "color": owner["color"], "mass": 0,
              "ballSkin": owner.get("ballSkin", "mint-orbit"),
              "sporeSkin": owner.get("sporeSkin", "dew-drop"),
              "vx": 0, "vy": 0, "impulseX": 0, "impulseY": 0,
              "mergeRemaining": 0, "alive": True, "isPlayer": False}
    entity["team"] = owner.get("team")
    entity["spikeCooldown"] = 0
    grow(entity, INITIAL_MASS)
    return entity


def keep_inside(cell, bounds=None, policy=None, restitution=None):
    """Apply every boundary correction through one clamp/bounce implementation."""
    bounds = bounds or BOUNDS
    policy = policy or BOUNDARY_POLICY
    restitution = BOUNDARY_RESTITUTION if restitution is None else restitution

    def fix_axis(position_key, velocity_key, impulse_key, size):
        if cell["radius"] * 2 >= size:
            cell[position_key] = size / 2
            cell[velocity_key] = 0
            if impulse_key in cell:
                cell[impulse_key] = 0
            return
        minimum, maximum = cell["radius"], size - cell["radius"]
        position, velocity = cell[position_key], cell[velocity_key]
        impulse = cell.get(impulse_key, 0)
        if position < minimum:
            cell[position_key] = minimum
            if policy == "bounce" and velocity < 0:
                cell[velocity_key] = -velocity * restitution
                if impulse_key in cell and impulse < 0:
                    cell[impulse_key] = -impulse * restitution
            else:
                if velocity < 0:
                    cell[velocity_key] = 0
                if impulse_key in cell and impulse < 0:
                    cell[impulse_key] = 0
        elif position > maximum:
            cell[position_key] = maximum
            if policy == "bounce" and velocity > 0:
                cell[velocity_key] = -velocity * restitution
                if impulse_key in cell and impulse > 0:
                    cell[impulse_key] = -impulse * restitution
            else:
                if velocity > 0:
                    cell[velocity_key] = 0
                if impulse_key in cell and impulse > 0:
                    cell[impulse_key] = 0

    fix_axis("x", "vx", "impulseX", bounds["width"])
    fix_axis("y", "vy", "impulseY", bounds["height"])
    return cell


def move(cell, direction, dt, multiplier=1, bounds=None, obstacles=None):
    dx, dy = direction
    length = max(1, math.hypot(dx, dy))
    smoothing = 1 - math.exp(-12 * dt)
    cell["vx"] += (dx / length * cell["speed"] * multiplier - cell["vx"]) * smoothing
    cell["vy"] += (dy / length * cell["speed"] * multiplier - cell["vy"]) * smoothing
    decay = math.exp(-5 * dt)
    impulse_time = (1 - decay) / 5
    cell["x"] += cell["vx"] * dt + cell["impulseX"] * impulse_time
    cell["y"] += cell["vy"] * dt + cell["impulseY"] * impulse_time
    cell["impulseX"] *= decay
    cell["impulseY"] *= decay
    keep_inside(cell, bounds)
    if obstacles:
        # 延迟导入避免障碍模块与实体模块形成初始化环。
        from .obstacles import resolve_obstacles
        resolve_obstacles(cell, obstacles, bounds or BOUNDS)


def split(cells, direction, next_id, bounds=None, obstacles=None):
    length = math.hypot(*direction)
    if length < .05 or len(cells) >= MAX_CELLS:
        return []
    dx, dy = (value / length for value in direction)
    sources = sorted((cell for cell in cells if cell["mass"] >= 72),
                     key=lambda cell: -cell["mass"])[:MAX_CELLS - len(cells)]
    children = []
    for source in sources:
        grow(source, -source["mass"] / 2)
        child = {**source, "id": next_id(), "impulseX": dx * 620, "impulseY": dy * 620,
                 "x": source["x"] + dx * source["radius"] * .65,
                 "y": source["y"] + dy * source["radius"] * .65}
        source["mergeRemaining"] = child["mergeRemaining"] = 10
        keep_inside(child, bounds)
        if obstacles:
            from .obstacles import resolve_obstacles
            resolve_obstacles(child, obstacles, bounds or BOUNDS)
        children.append(child)
    cells.extend(children)
    return children


def merge(cells, dt, bounds=None, obstacles=None):
    for cell in cells:
        cell["mergeRemaining"] = max(0, cell["mergeRemaining"] - dt)
    for index, a in enumerate(cells):
        if not a["alive"]:
            continue
        for b in cells[index + 1:]:
            if not b["alive"]:
                continue
            dx, dy = b["x"] - a["x"], b["y"] - a["y"]
            distance = math.hypot(dx, dy)
            nx, ny = (dx / distance, dy / distance) if distance > .001 else (1, 0)
            ready = a["mergeRemaining"] == b["mergeRemaining"] == 0
            mass_a, mass_b = a["mass"], b["mass"]
            total = mass_a + mass_b
            if ready and distance <= (a["radius"] + b["radius"]) * .65:
                for key in ("x", "y", "vx", "vy", "impulseX", "impulseY"):
                    a[key] = (a[key] * mass_a + b[key] * mass_b) / total
                grow(a, mass_b)
                b["alive"] = False
            else:
                overlap = a["radius"] + b["radius"] - distance
                shift = min(distance * .25, 260 * dt) if ready else (
                    -overlap * (1 - math.exp(-18 * dt)) if overlap > 0 else 0)
                a["x"] += nx * shift * mass_b / total
                a["y"] += ny * shift * mass_b / total
                b["x"] -= nx * shift * mass_a / total
                b["y"] -= ny * shift * mass_a / total
            keep_inside(a, bounds)
            keep_inside(b, bounds)
            if obstacles:
                from .obstacles import resolve_obstacles
                resolve_obstacles(a, obstacles, bounds or BOUNDS)
                resolve_obstacles(b, obstacles, bounds or BOUNDS)
    return [cell for cell in cells if cell["alive"]]
