"""人机只生成普通输入；难度改变决策和反应时间，不改变速度或吞噬规则。"""
import math
from .rules import has_eat_advantage
from .teamplay import cooperate

PROFILES = {
    "casual": {"reaction": .5, "chase": 300, "margin": 1.35, "maxCells": 1, "splitRest": 18, "splitChase": False},
    "standard": {"reaction": .28, "chase": 500, "margin": 1.14, "maxCells": 2, "splitRest": 14, "splitChase": False},
    "challenge": {"reaction": .16, "chase": 760, "margin": 1.08, "maxCells": 4, "splitRest": 9, "splitChase": True},
}


def unit(x, y):
    length = math.hypot(x, y) or 1
    return x / length, y / length


def segment_distance(point, start, end):
    dx, dy = end["x"] - start["x"], end["y"] - start["y"]
    t = max(0, min(1, ((point["x"] - start["x"]) * dx + (point["y"] - start["y"]) * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(point["x"] - start["x"] - t * dx, point["y"] - start["y"] - t * dy)


def avoid_spikes(cell, direction, spikes):
    """沿当前路径看一小段：远处侧绕，已经贴刺时向外退，避免反复扎同一颗刺。"""
    if cell["mass"] < 72:
        return direction
    dx, dy = direction
    end = {"x": cell["x"] + dx * 160, "y": cell["y"] + dy * 160}
    danger = min((spike for spike in spikes if segment_distance(spike, cell, end) < cell["radius"] + spike["radius"] * .72 + 28),
                 key=lambda spike: math.hypot(spike["x"] - cell["x"], spike["y"] - cell["y"]), default=None)
    if not danger:
        return direction
    ax, ay = cell["x"] - danger["x"], cell["y"] - danger["y"]
    distance = math.hypot(ax, ay)
    if distance < cell["radius"] + danger["radius"] * .72 + 18:
        return unit(ax or 1, ay)
    nx, ny = unit(ax, ay)
    side = 1 if dx * -ny + dy * nx >= 0 else -1
    return unit(dx * .25 - ny * side + nx * .5, dy * .25 + nx * side + ny * .5)


def decide(owner, cells, world):
    profile = PROFILES[world.rules.botDifficulty]
    bot = max(cells, key=lambda cell: cell["mass"])
    zone = world.safe_zone.at(world.elapsed) if getattr(world, 'safe_zone', None) else None
    if zone:
        edge = zone['nextRadius'] if zone['phase'] == 'warning' else zone['radius']
        exposed = max(cells, key=lambda cell: math.hypot(cell['x'] - zone['x'], cell['y'] - zone['y']))
        if math.hypot(exposed['x'] - zone['x'], exposed['y'] - zone['y']) > edge - 90:
            dx, dy = avoid_spikes(exposed, unit(zone['x'] - exposed['x'], zone['y'] - exposed['y']), world.spikes)
            return {'x': dx, 'y': dy, 'target': None, 'regroup': False, 'split': False}
    enemies = [cell for cell in world.all_cells() if cell["ownerId"] != owner["ownerId"]
               and not world.allies(owner, world.players[cell["ownerId"]])
               and max(owner["protectedUntil"], world.players[cell["ownerId"]]["protectedUntil"]) <= world.elapsed]
    # 休闲档只觅食和漫游，不读取敌人信息；更高难度才进入追逃决策。
    threat = None
    prey = None
    if world.rules.botDifficulty != "casual":
        # 威胁按每个分身计算，不能让大分身掩盖小分身正在被追击。
        threats = [(math.hypot(enemy["x"] - cell["x"], enemy["y"] - cell["y"])
                    - enemy["radius"] - cell["radius"], cell, enemy)
                   for cell in cells for enemy in enemies if has_eat_advantage(enemy, cell)]
        closest = min(threats, key=lambda item: item[0], default=None)
        threat = closest if closest and closest[0] < 220 else None
        prey = min((enemy for enemy in enemies if has_eat_advantage(bot, enemy)
                    and math.hypot(enemy["x"] - bot["x"], enemy["y"] - bot["y"])
                    < bot["radius"] + enemy["radius"] + profile["chase"]),
                   key=lambda enemy: math.hypot(enemy["x"] - bot["x"], enemy["y"] - bot["y"]),
                   default=None)

        remembered = world.players[owner["ownerId"]].get("botTargetId")
        remembered_until = world.players[owner["ownerId"]].get("botTargetUntil", 0)
        remembered_kind = world.players[owner["ownerId"]].get("botTargetKind")
        if remembered and remembered_until > world.elapsed:
            target = next((enemy for enemy in enemies if enemy["id"] == remembered), None)
            if remembered_kind == "threat" and target and any(has_eat_advantage(target, cell) for cell in cells):
                threatened = min((cell for cell in cells if has_eat_advantage(target, cell)),
                                 key=lambda cell: math.hypot(target["x"] - cell["x"], target["y"] - cell["y"]))
                threat = (math.hypot(target["x"] - threatened["x"], target["y"] - threatened["y"])
                          - target["radius"] - threatened["radius"], threatened, target)
            elif remembered_kind == "prey" and target and has_eat_advantage(bot, target):
                prey = target
    total = sum(cell["mass"] for cell in cells)
    center = {axis: sum(cell[axis] * cell["mass"] for cell in cells) / total for axis in ("x", "y")}
    spread = max(math.hypot(cell["x"] - center["x"], cell["y"] - center["y"]) for cell in cells)
    regroup = not threat and len(cells) > 1 and (spread > 140 or all(cell["mergeRemaining"] <= 0 for cell in cells))
    split = False
    team_plan = cooperate(owner, cells, world, enemies, threat)
    if team_plan:
        direction = (team_plan['x'], team_plan['y'])
        if direction != (0, 0):
            adjusted = avoid_spikes(bot, direction, world.spikes)
            if team_plan.get('spore') and sum(a * b for a, b in zip(direction, adjusted)) < .95:
                team_plan['spore'] = False
            direction = adjusted
        return {**team_plan, 'x': direction[0], 'y': direction[1]}
    if threat:
        _, cell, enemy = threat
        direction = unit(cell["x"] - enemy["x"], cell["y"] - enemy["y"])
        remember_target(owner, "threat", enemy["id"], world.elapsed)
    elif prey:
        dx, dy = prey["x"] - bot["x"], prey["y"] - bot["y"]
        if world.rules.botDifficulty == "challenge":
            dx += prey.get("vx", 0) * .18
            dy += prey.get("vy", 0) * .18
        direction = unit(dx, dy)
        split_radius = math.sqrt(bot["mass"] / 2) * (bot["radius"] / math.sqrt(bot["mass"]))
        split = (profile["splitChase"] and len(cells) * 2 <= profile["maxCells"]
                 and owner.get("botSkillRemaining", 0) <= 0 and bot["mass"] >= 72
                 and split_radius > prey["radius"] * profile["margin"]
                 and bot["radius"] + prey["radius"] + 10 < math.hypot(prey["x"] - bot["x"], prey["y"] - bot["y"]) < bot["radius"] + prey["radius"] + 125
                 and not any(math.sqrt(min(cell["mass"] for cell in cells) / 2)
                             * (enemy["radius"] / math.sqrt(enemy["mass"]))
                             <= enemy["radius"] * (1 / 1.18)
                             and math.hypot(enemy["x"] - bot["x"], enemy["y"] - bot["y"]) < enemy["radius"] + bot["radius"] + 230 for enemy in enemies)
                 and not any(segment_distance(spike, bot, prey) < bot["radius"] + spike["radius"] + 20 for spike in world.spikes))
        remember_target(owner, "prey", prey["id"], world.elapsed)
    else:
        food = min(world.foods, key=lambda item: math.hypot(item["x"] - bot["x"], item["y"] - bot["y"]), default=None)
        if food:
            direction = unit(food["x"] - bot["x"], food["y"] - bot["y"])
            remember_target(owner, "food", food.get("id"), world.elapsed)
        else:
            angle = (sum(ord(char) for char in bot["id"]) * .37) + world.elapsed * .17
            direction = (math.cos(angle), math.sin(angle))
            remember_target(owner, "wander", None, world.elapsed)
    if direction != (0, 0):
        # 只有挑战档主动绕刺；基础档仍遵守刺球规则，但不会高成本规划。
        dx, dy = avoid_spikes(bot, direction, world.spikes) if world.rules.botDifficulty == "challenge" else direction
        edge = bot["radius"] + 75
        dx += .9 if bot["x"] < edge else -.9 if bot["x"] > world.bounds_width - edge else 0
        dy += .9 if bot["y"] < edge else -.9 if bot["y"] > world.bounds_height - edge else 0
        direction = unit(dx, dy)
    return {"x": direction[0], "y": direction[1], "target": None, "regroup": bool(regroup), "split": bool(split)}


def remember_target(owner, kind, target_id, now):
    """Bots keep a target briefly, avoiding frame-to-frame oscillation."""
    owner["botTargetKind"] = kind
    owner["botTargetId"] = target_id
    owner["botTargetUntil"] = now + 3
