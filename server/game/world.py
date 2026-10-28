"""最多 4 个参赛者的生存局；真人不足时由服务器补充人机。"""

import math
import random

from .entities import BOUNDS, INITIAL_MASS, MAX_CELLS, ball, clamp, grow, keep_inside, merge, move, split
from .spatial import SpatialGrid
from .rules import RoomRules, TEAMS
from .spikes import feed_spikes, update_spikes
from .stats import RoundStats
from .ai import decide, avoid_spikes, PROFILES
from .safe_zone import SafeZone
from .signals import TeamSignals

COLORS = ["#b4efcc", "#dd998d", "#b2a4dc", "#88adc9"]
BOT_NAMES = ["人机·薄荷", "人机·追猎", "人机·小橘"]
BOT_ROLES = ("forager", "rival", "hunter")
FOOD_COLORS = ["#b4d3ac", "#d7bc77", "#91accd", "#bd9abb", "#ce9185", "#82b8ac"]
SPORE_MASS = 8
SPORE_MINIMUM_MASS = 48
SPORE_COOLDOWN = .45
SPORE_SPEED = 560
SPORE_DECAY = 1.8
SPORE_LIFETIME = 5
SPORE_MAX_COUNT = 80
SPIKE_COUNT = 10
SPIKE_RADIUS = 58
SPIKE_MINIMUM_MASS = 72
SPIKE_LOSS_RATIO = .08
SPIKE_COOLDOWN = 1.25
SPIKE_PUSH_SPEED = 300


def neutral():
    return {"x": 0, "y": 0, "target": None, "sprint": False, "split": False, "spore": False, "sporeHeld": False, "regroup": False}


class MultiplayerWorld:
    duration = 300
    food_count = 560
    bounds_width, bounds_height = BOUNDS["width"], BOUNDS["height"]

    def __init__(self, members, rng=None, rules=None):
        self.rules = rules or RoomRules()
        self.duration = self.rules.duration
        self.food_count = {"sparse": 360, "normal": 560, "rich": 800}[self.rules.foodDensity]
        self.rng = rng or random.Random()
        self.elapsed = 0
        self.safe_zone = SafeZone(BOUNDS, self.duration) if self.rules.mode == 'shrink' else None
        self.zone_notice = None
        self.signals = TeamSignals()
        self.tick = 0
        self.finished = False
        self.reason = None
        self.next_id = 0
        self.event_id = 0
        self.events = []
        self.players = {}
        self.cells = {}
        self.bot_ids = set()
        self.human_ids = set()
        self.food_timer = 0
        self.food_version = 0
        self.hotspots = {"zones": [], "remaining": 45, "duration": 45, "cycle": 0}
        self.rotate_hotspots()
        # 固定的四个对称出生点，避免房主因更早连接而提前吃食物。
        starts = [(800, 550), (2400, 1650), (2400, 550), (800, 1650)]
        self.spores = []
        self.ball_grid = SpatialGrid()
        self.food_grid = SpatialGrid()
        self.spore_grid = SpatialGrid()
        self.spike_grid = SpatialGrid()
        self.spikes = self.create_spikes(starts)
        team_slots = [0, 0]
        for index, member in enumerate(members):
            owner_id = member["id"]
            is_bot = bool(member.get("isBot"))
            if is_bot:
                self.bot_ids.add(owner_id)
            else:
                self.human_ids.add(owner_id)
            team = member.get("team", index % 2) if self.rules.mode == "teams" else None
            if team is not None and (type(team) is not int or team not in (0, 1)):
                raise ValueError("队伍必须为薄荷队或星云队。")
            owner = {"ownerId": owner_id, "name": member["name"], "team": team,
                     "color": TEAMS[team][1] if team is not None else COLORS[index],
                     "lives": 3, "kills": 0, "deaths": 0, "score": 0, "eatenBalls": 0,
                     "peakMass": 36, "protectedUntil": 3, "connected": True, "isBot": is_bot, "zoneExposure": 0,
                     "input": neutral(), "lastInput": -1, "lastSeq": -1, "appliedSeq": -1,
                      "heldSprint": False, "heldSplit": False, "heldSpore": False,
                      "queuedSprint": False, "queuedSplit": False, "queuedSpore": False,
                     "sprintRemaining": 0, "sprintCooldown": 0, "sprintDirection": (0, 0), "splitCooldown": 0,
                      "sporeCooldown": 0, "stats": RoundStats(),
                     "killer": "", "botRole": member.get("role", BOT_ROLES[index % len(BOT_ROLES)]),
                     "botThinkRemaining": 0 if is_bot else None, "botDirection": (0, 0)}
            owner["botSkillRemaining"] = 0
            self.players[owner_id] = owner
            spawn = index
            if team is not None:
                if team_slots[team] >= 2:
                    raise ValueError("每队最多两个参赛者。")
                spawn = team + team_slots[team] * 2
                team_slots[team] += 1
            x, y = starts[spawn]
            self.cells[owner_id] = [ball(self.new_id("cell"), owner, {"x": x, "y": y})]
            grow(self.cells[owner_id][0], self.rules.initialMass - INITIAL_MASS)
            owner["peakMass"] = self.rules.initialMass
            owner["stats"].observe(self.cells[owner_id])
            owner['stats'].sample(0, self.cells[owner_id], True)
        self.foods = [self.create_food() for _ in range(self.food_count)]
        self.spike_grid.build(self.spikes)

    def new_id(self, prefix):
        self.next_id += 1
        return f"{prefix}-{self.next_id}"

    def emit(self, event_type, owner=None, **data):
        self.event_id += 1
        event = {"id": self.event_id, "type": event_type, **data}
        if owner:
            event["ownerId"] = owner["ownerId"]
        actor = owner or self.players.get(data.get("actorId"))
        if actor:
            actor["stats"].record(event, self.tick)
        self.events.append(event)
        # 客户端按事件 ID 去重；保留短历史，允许覆盖积压快照而不重播声音。
        self.events = self.events[-160:]

    def all_cells(self):
        return [cell for cells in self.cells.values() for cell in cells if cell["alive"]]

    def set_input(self, owner_id, message):
        owner = self.players.get(owner_id)
        if self.finished or not owner or owner["lives"] <= 0 or not owner["connected"]:
            return
        seq = message.get("seq")
        if type(seq) is not int or seq <= owner["lastSeq"] or seq > 2 ** 53 - 1:
            return
        def finite(value):
            return type(value) in (int, float) and abs(value) <= 10_000_000 and math.isfinite(value)
        x, y = message.get("x", 0), message.get("y", 0)
        if not finite(x) or not finite(y):
            return
        x, y = clamp(x, -1, 1), clamp(y, -1, 1)
        length = max(1, math.hypot(x, y))
        target = message.get("target")
        if isinstance(target, dict) and finite(target.get("x")) and finite(target.get("y")):
            target = {"x": clamp(target["x"], 0, BOUNDS["width"]), "y": clamp(target["y"], 0, BOUNDS["height"])}
        else:
            target = None
        # 冲刺已取消：即使旧客户端或手工请求携带 sprint，也不能触发服务端加速。
        sprint, splitting, sporing = False, message.get("split") is True, message.get("spore") is True
        owner["queuedSplit"] |= splitting and not owner["heldSplit"]
        owner["queuedSpore"] |= sporing and not owner["heldSpore"]
        owner["heldSprint"], owner["heldSplit"], owner["heldSpore"] = sprint, splitting, sporing
        owner["input"] = {"x": x / length, "y": y / length, "target": target, "sporeHeld": message.get("sporeHeld") is True,
                          "regroup": message.get("regroup") is True}
        owner["lastInput"], owner["lastSeq"] = self.elapsed, seq

    def stop_input(self, owner):
        owner["input"] = neutral()
        owner["heldSprint"] = owner["heldSplit"] = owner["heldSpore"] = False
        owner["queuedSprint"] = owner["queuedSplit"] = owner["queuedSpore"] = False

    def update(self, dt):
        if self.finished:
            return
        self.tick += 1
        for owner in self.players.values():
            if owner["lives"] > 0:
                owner["stats"].advance(min(dt, max(0, self.duration - self.elapsed)))
        if self.elapsed + dt >= self.duration - 1e-8:
            self.elapsed = self.duration
            self.finish("timeout")
            return
        self.elapsed += dt
        if self.safe_zone:
            state = self.safe_zone.at(self.elapsed)
            notice = (state['stage'], state['phase'])
            if notice != self.zone_notice and state['phase'] in ('warning', 'shrinking'):
                self.emit('zone-' + state['phase'], stage=state['stage'])
            self.zone_notice = notice
        for spore in self.spores:
            if not spore["alive"]:
                continue
            spore["life"] -= dt
            spore["x"] += spore["vx"] * dt
            spore["y"] += spore["vy"] * dt
            decay = math.exp(-SPORE_DECAY * dt)
            spore["vx"] *= decay
            spore["vy"] *= decay
            if spore["life"] <= 0 or spore["x"] < -spore["radius"] or spore["y"] < -spore["radius"] or spore["x"] > BOUNDS["width"] + spore["radius"] or spore["y"] > BOUNDS["height"] + spore["radius"]:
                spore["alive"] = False
        self.spores = [spore for spore in self.spores if spore["alive"]]
        for owner_id, owner in self.players.items():
            cells = self.cells[owner_id]
            if not cells:
                continue
            if owner["isBot"]:
                self.update_bot_input(owner, cells, dt)
            if self.elapsed - owner["lastInput"] > 1:
                self.stop_input(owner)
            self.update_controls(owner, cells, dt)
        self.spikes = update_spikes(self.spikes, dt, BOUNDS)
        for event in feed_spikes(self.spikes, self.spores, BOUNDS, lambda: self.new_id("launched-spike")):
            event_type = event.pop("type")
            self.emit(event_type, **event)
        self.spores = [spore for spore in self.spores if spore["alive"]]
        self.consume_food()
        self.consume_spores()
        self.handle_spikes()
        for owner_id, cells in self.cells.items():
            self.players[owner_id]["stats"].observe(cells)
        self.consume_balls()
        for owner_id, cells in self.cells.items():
            count = len(cells)
            self.cells[owner_id] = merge(cells, dt)
            if len(self.cells[owner_id]) < count:
                cell = self.cells[owner_id][0]
                self.emit("merge", self.players[owner_id], x=cell["x"], y=cell["y"], color=cell["color"])
            owner = self.players[owner_id]
            owner["peakMass"] = max(owner["peakMass"], sum(c["mass"] for c in self.cells[owner_id]))
        for cell in self.all_cells():
            keep_inside(cell)
        if self.safe_zone and not self.finished:
            self.safe_zone.apply(self, dt)
        for owner_id, owner in self.players.items():
            if owner['lives'] > 0:
                owner['stats'].sample(self.elapsed, self.cells[owner_id])
        if self.finished:
            return
        self.hotspots["remaining"] -= dt
        if self.hotspots["remaining"] <= 0:
            self.hotspots["remaining"] += 45
            self.hotspots["cycle"] += 1
            self.rotate_hotspots()
            count = round(len(self.foods) * .36)
            self.rng.shuffle(self.foods)
            for index, food in enumerate(self.foods):
                food.update(self.food_position(index < count))
            self.food_version += 1
            self.emit("hotspots", cycle=self.hotspots["cycle"])
        self.food_timer += dt
        if self.food_timer >= .3:
            self.food_timer = 0
            changed = len(self.foods) < self.food_count
            while len(self.foods) < self.food_count:
                self.foods.append(self.create_food())
            if changed:
                self.food_version += 1

    def update_bot_input(self, owner, cells, dt):
        """服务器端人机只生成输入，移动、吞噬和技能仍走同一套权威规则。"""
        owner["botThinkRemaining"] -= dt
        owner["botSkillRemaining"] = max(0, owner["botSkillRemaining"] - dt)
        if owner["botThinkRemaining"] <= 0:
            plan = decide(owner, cells, self)
            owner["input"] = {**plan, "sporeHeld": False}
            owner['teamAction'] = plan.get('teamAction', '')
            if plan.get('spore') and owner['sporeCooldown'] == 0 and len(self.spores) < SPORE_MAX_COUNT:
                owner['queuedSpore'] = True
                owner['botFeedAt'] = self.elapsed + 2
            if plan["split"]:
                owner["queuedSplit"] = True
                owner["botSkillRemaining"] = PROFILES[self.rules.botDifficulty]["splitRest"]
            owner["botThinkRemaining"] = PROFILES[self.rules.botDifficulty]["reaction"] + self.rng.random() * .08
        owner["lastInput"] = self.elapsed

    def choose_bot_direction(self, owner, cells):
        """保留方向接口供测试与后续模式复用，技能决策由 ai.decide 统一生成。"""
        plan = decide(owner, cells, self)
        return plan["x"], plan["y"]

    def update_controls(self, owner, cells, dt):
        owner["sprintRemaining"] = owner["sprintCooldown"] = 0
        owner["splitCooldown"] = max(0, owner["splitCooldown"] - dt)
        owner["sporeCooldown"] = max(0, owner["sporeCooldown"] - dt)
        for cell in cells:
            cell["spikeCooldown"] = max(0, cell.get("spikeCooldown", 0) - dt)
        controls = owner["input"]
        direction = (controls["x"], controls["y"])
        if controls.get("target"):
            mass = sum(cell["mass"] for cell in cells)
            center = tuple(sum(cell[key] * cell["mass"] for cell in cells) / mass for key in ("x", "y"))
            aim = (controls["target"]["x"] - center[0], controls["target"]["y"] - center[1])
            length = math.hypot(*aim)
            direction = tuple(value / length for value in aim) if length > .05 else (0, 0)
        if owner["queuedSplit"] and owner["splitCooldown"] == 0:
            aim = direction if math.hypot(*direction) > .05 else (
                sum(cell["vx"] * cell["mass"] for cell in cells), sum(cell["vy"] * cell["mass"] for cell in cells))
            children = split(cells, aim, lambda: self.new_id("cell"))
            if children:
                owner["splitCooldown"] = .75
                for child in children:
                    self.emit("split", owner, x=child["x"], y=child["y"], color=owner["color"])
        if (owner["queuedSpore"] or controls.get("sporeHeld")) and owner["sporeCooldown"] == 0:
            source = max((cell for cell in cells if cell["mass"] >= SPORE_MINIMUM_MASS), key=lambda cell: cell["mass"], default=None)
            if source is not None and len(self.spores) < SPORE_MAX_COUNT:
                aim = direction if math.hypot(*direction) > .05 else (source["vx"], source["vy"])
                if controls.get("target"):
                    aim = (controls["target"]["x"] - source["x"], controls["target"]["y"] - source["y"])
                if math.hypot(*aim) < .05:
                    aim = (1, 0)
                length = math.hypot(*aim) or 1
                dx, dy = aim[0] / length, aim[1] / length
                grow(source, -SPORE_MASS)
                spore = {"id": self.new_id("spore"), "ownerId": owner["ownerId"],
                         "x": clamp(source["x"] + dx * (source["radius"] + math.sqrt(SPORE_MASS) * 2.2 + 12), source["radius"], BOUNDS["width"] - source["radius"]),
                         "y": clamp(source["y"] + dy * (source["radius"] + math.sqrt(SPORE_MASS) * 2.2 + 12), source["radius"], BOUNDS["height"] - source["radius"]),
                         "mass": SPORE_MASS, "radius": math.sqrt(SPORE_MASS) * 2.2,
                         "vx": dx * SPORE_SPEED, "vy": dy * SPORE_SPEED, "color": owner["color"],
                         "life": SPORE_LIFETIME, "alive": True}
                self.spores.append(spore)
                owner["sporeCooldown"] = SPORE_COOLDOWN
                self.emit("spore", owner, x=spore["x"], y=spore["y"], color=owner["color"])
        owner["queuedSprint"] = owner["queuedSplit"] = owner["queuedSpore"] = False
        owner["stats"].observe(cells)
        mass = sum(cell["mass"] for cell in cells)
        center = {axis: sum(cell[axis] * cell["mass"] for cell in cells) / mass for axis in ("x", "y")}
        movement_target = center if controls.get("regroup") and len(cells) > 1 else controls.get("target")
        for cell in cells:
            cell_direction = direction
            if movement_target:
                dx, dy = movement_target["x"] - cell["x"], movement_target["y"] - cell["y"]
                length = math.hypot(dx, dy)
                strength = clamp((length - 5) / 75, 0, 1)
                cell_direction = (dx / length * strength, dy / length * strength) if length else (0, 0)
            if owner["isBot"]:
                cell_direction = avoid_spikes(cell, cell_direction, self.spikes)
            move(cell, cell_direction, dt)
        # 收包序号用于去重；只有真正参与物理步的输入才能确认给预测端。
        owner["appliedSeq"] = owner["lastSeq"]

    def consume_food(self):
        remaining = []
        cells = self.all_cells()
        self.ball_grid.build(cells)
        # 球体已经按完整包围盒入网格，无需再按全场最大球的半径扩大查询。
        # 每次增重后补入新覆盖的格子，保证同一帧长大的球不会漏吃边缘食物。
        order = {id(cell): index for index, cell in enumerate(cells)}
        for food in self.foods:
            candidates = sorted(self.ball_grid.query_circle(food["x"], food["y"], food["radius"]),
                                key=lambda cell: order[id(cell)])
            for cell in candidates:
                if (cell["x"] - food["x"]) ** 2 + (cell["y"] - food["y"]) ** 2 <= (cell["radius"] + food["radius"]) ** 2:
                    grow(cell, 1)
                    self.ball_grid.insert(cell)
                    self.players[cell["ownerId"]]["score"] += 1
                    self.emit("food", self.players[cell["ownerId"]], foodId=food["id"], x=food["x"], y=food["y"], color=food["color"], mass=1)
                    break
            else:
                remaining.append(food)
        if len(remaining) != len(self.foods):
            self.food_version += 1
        self.foods = remaining

    def consume_spores(self):
        cells = self.all_cells()
        self.ball_grid.build(cells)
        for spore in self.spores:
            if not spore["alive"]:
                continue
            candidates = self.ball_grid.query_circle(spore["x"], spore["y"], spore["radius"])
            eater = next((cell for cell in candidates if (cell["x"] - spore["x"]) ** 2 + (cell["y"] - spore["y"]) ** 2 <= (cell["radius"] + spore["radius"]) ** 2), None)
            if eater is None:
                continue
            grow(eater, spore["mass"])
            self.ball_grid.insert(eater)
            spore["alive"] = False
            self.emit("spore-eat", self.players[eater["ownerId"]], x=spore["x"], y=spore["y"], color=spore["color"], mass=spore["mass"])
        self.spores = [spore for spore in self.spores if spore["alive"]]

    def handle_spikes(self):
        self.spike_grid.build(self.spikes)
        for owner_id, cells in list(self.cells.items()):
            if not cells or any(cell.get("spikeCooldown", 0) > 0 for cell in cells):
                continue
            hit = next((cell for cell in cells if cell["mass"] >= SPIKE_MINIMUM_MASS and any(
                (cell["x"] - spike["x"]) ** 2 + (cell["y"] - spike["y"]) ** 2 <= (cell["radius"] + spike["radius"] * .72) ** 2
                for spike in self.spike_grid.query_circle(cell["x"], cell["y"], cell["radius"] + SPIKE_RADIUS))), None)
            if hit is None:
                continue
            if self.players[owner_id]["protectedUntil"] > self.elapsed:
                continue
            spike = next(spike for spike in self.spike_grid.query_circle(hit["x"], hit["y"], hit["radius"] + SPIKE_RADIUS)
                         if (hit["x"] - spike["x"]) ** 2 + (hit["y"] - spike["y"]) ** 2 <= (hit["radius"] + spike["radius"] * .72) ** 2)
            direction = (hit["x"] - spike["x"], hit["y"] - spike["y"])
            if math.hypot(*direction) < .05:
                direction = (hit["vx"], hit["vy"])
            if math.hypot(*direction) < .05:
                direction = (1, 0)
            length = math.hypot(*direction) or 1
            direction = (direction[0] / length, direction[1] / length)
            children = split(cells, direction, lambda: self.new_id("cell"))
            for cell in cells:
                grow(cell, -cell["mass"] * SPIKE_LOSS_RATIO)
                cell["spikeCooldown"] = SPIKE_COOLDOWN
                cell["impulseX"] += direction[0] * SPIKE_PUSH_SPEED
                cell["impulseY"] += direction[1] * SPIKE_PUSH_SPEED
            owner = self.players[owner_id]
            self.emit("spike", owner, x=hit["x"], y=hit["y"], color=owner["color"], text="扎刺 −8%")

    def consume_balls(self):
        cells = sorted(self.all_cells(), key=lambda cell: -cell["mass"])
        self.ball_grid.build(cells)
        order = {id(cell): index for index, cell in enumerate(cells)}
        counts = {owner_id: len(group) for owner_id, group in self.cells.items()}
        respawns = []
        for eater in cells:
            candidates = sorted(self.ball_grid.query_circle(eater["x"], eater["y"], eater["radius"] + 1),
                                key=lambda cell: order[id(cell)])
            for prey in candidates:
                if (not eater["alive"] or not prey["alive"] or eater["ownerId"] == prey["ownerId"]
                        or eater["mass"] < prey["mass"] * 1.28):
                    continue
                attacker, victim = self.players[eater["ownerId"]], self.players[prey["ownerId"]]
                if self.allies(attacker, victim):
                    continue
                if max(attacker["protectedUntil"], victim["protectedUntil"]) > self.elapsed:
                    continue
                threshold = eater["radius"] - prey["radius"] * .35
                if (eater["x"] - prey["x"]) ** 2 + (eater["y"] - prey["y"]) ** 2 >= threshold ** 2:
                    continue
                prey["alive"] = False
                grow(eater, prey["mass"])
                attacker["score"] += math.floor(prey["mass"] + .5)
                attacker["eatenBalls"] += 1
                victim["killer"] = attacker["name"]
                counts[prey["ownerId"]] -= 1
                self.emit("eat", attacker, x=prey["x"], y=prey["y"], color=prey["color"], mass=prey["mass"])
                attacker["stats"].observe(self.cells[eater["ownerId"]])
                if counts[prey["ownerId"]] > 0:
                    self.emit("celllost", victim, x=prey["x"], y=prey["y"], color=prey["color"], mass=prey["mass"])
                else:
                    victim["stats"].record({"type": "celllost"}, self.tick)
                    victim["lives"] -= 1
                    victim["deaths"] += 1
                    victim['stats'].death(self.elapsed, 'eaten', attacker['name'], prey['mass'])
                    attacker["lives"] += 1
                    attacker["kills"] += 1
                    self.emit("life", attacker, lives=attacker["lives"], victim=victim["name"])
                    if victim["lives"] > 0:
                        respawns.append(victim)
                    else:
                        self.emit("eliminated", victim, name=victim["name"])
        for owner_id in self.cells:
            self.cells[owner_id] = [cell for cell in self.cells[owner_id] if cell["alive"]]
        for owner in respawns:
            self.respawn(owner)
        self.check_victory()

    def allies(self, first, second):
        return self.rules.mode == "teams" and first["team"] == second["team"]

    def check_victory(self):
        active = [owner for owner in self.players.values() if owner["lives"] > 0]
        if self.rules.mode == "teams":
            if len({owner["team"] for owner in active}) <= 1:
                self.finish("last-team")
        elif len(active) <= 1:
            self.finish("last-survivor")

    def respawn(self, owner):
        candidates = [(self.rng.uniform(80, 3120), self.rng.uniform(80, 2120)) for _ in range(48)]
        candidates.extend((x, y) for y in (100, 1100, 2100) for x in (100, 1600, 3100))
        if self.safe_zone:
            state = self.safe_zone.at(self.elapsed)
            radius = max(20, min(state['radius'] - 64, 1000))
            candidates = []
            for _ in range(64):
                angle, distance = self.rng.random() * math.tau, math.sqrt(self.rng.random()) * radius
                candidates.append((clamp(state['x'] + math.cos(angle) * distance, 80, 3120),
                                   clamp(state['y'] + math.sin(angle) * distance, 80, 2120)))
        cells = self.all_cells()
        def clearance(point):
            return min((math.hypot(point[0] - c["x"], point[1] - c["y"]) - c["radius"] - 18 for c in cells), default=9999)
        x, y = max(candidates, key=clearance)
        cell = ball(self.new_id("cell"), owner, {"x": x, "y": y})
        self.cells[owner["ownerId"]] = [cell]
        self.stop_input(owner)
        owner.update(protectedUntil=self.elapsed + 3, sprintRemaining=0, sprintCooldown=0, splitCooldown=0, sporeCooldown=0, zoneExposure=0)
        self.emit("respawn", owner, lives=owner["lives"], x=x, y=y, color=owner["color"])
        owner['stats'].sample(self.elapsed, [cell], True)

    def disconnect(self, owner_id):
        owner = self.players.get(owner_id)
        if not owner:
            return
        owner["connected"] = False
        self.stop_input(owner)
        if not self.finished:
            owner['stats'].death(self.elapsed, 'departed')
            owner["lives"] = 0
            self.cells[owner_id] = []
            self.emit("departed", owner, name=owner["name"])
            self.check_victory()

    def finish(self, reason):
        if not self.finished:
            for owner_id, owner in self.players.items():
                owner['stats'].sample(self.elapsed, self.cells[owner_id], True)
            self.finished, self.reason = True, reason
            self.emit("gameover")

    def rotate_hotspots(self):
        previous = self.hotspots["zones"]
        zones = []
        for index in range(2):
            candidates = [{"x": self.rng.uniform(250, 2950), "y": self.rng.uniform(250, 1950)} for _ in range(60)]
            neighbors = previous + zones
            def clearance(point):
                return min((math.hypot(point["x"] - z["x"], point["y"] - z["y"]) for z in neighbors), default=9999)
            point = max(candidates, key=clearance)
            zones.append({**point, "id": f'hotspot-{self.hotspots["cycle"]}-{index}', "label": chr(65 + index), "radius": 190})
        self.hotspots["zones"] = zones

    def food_position(self, rich=None):
        if self.safe_zone:
            state = self.safe_zone.at(self.elapsed)
            # 新补给随当前安全区集中；已有食物不凭空消失，方便看清圈外的风险。
            if state['radius'] < 1200:
                angle = self.rng.random() * math.tau
                distance = math.sqrt(self.rng.random()) * max(20, state['radius'] - 30)
                return {"x": clamp(state['x'] + math.cos(angle) * distance, 20, 3180),
                        "y": clamp(state['y'] + math.sin(angle) * distance, 20, 2180), "hotspotId": None}
        if rich is None:
            rich = self.rng.random() < .36
        if rich:
            zone = self.rng.choice(self.hotspots["zones"])
            angle, distance = self.rng.random() * math.tau, math.sqrt(self.rng.random()) * 186.7
            return {"x": zone["x"] + math.cos(angle) * distance, "y": zone["y"] + math.sin(angle) * distance, "hotspotId": zone["id"]}
        return {"x": self.rng.uniform(20, 3180), "y": self.rng.uniform(20, 2180), "hotspotId": None}

    def create_spikes(self, starts):
        spikes = []
        for index in range(SPIKE_COUNT):
            point = None
            for _ in range(100):
                candidate = {"id": f"spike-{index}", "x": self.rng.uniform(SPIKE_RADIUS, BOUNDS["width"] - SPIKE_RADIUS),
                             "y": self.rng.uniform(SPIKE_RADIUS, BOUNDS["height"] - SPIKE_RADIUS),
                             "radius": SPIKE_RADIUS, "color": "#72c98e"}
                if any((candidate["x"] - x) ** 2 + (candidate["y"] - y) ** 2 < (SPIKE_RADIUS + 220) ** 2 for x, y in starts):
                    continue
                if (candidate["x"] - BOUNDS["width"] / 2) ** 2 + (candidate["y"] - BOUNDS["height"] / 2) ** 2 < (620 + SPIKE_RADIUS + 220) ** 2:
                    continue
                if any((candidate["x"] - other["x"]) ** 2 + (candidate["y"] - other["y"]) ** 2 < (SPIKE_RADIUS * 2 + 180) ** 2 for other in spikes):
                    continue
                point = candidate
                break
            if not point:
                fallback = [(300, 280), (1600, 220), (2900, 280), (260, 1900), (1600, 1980),
                            (2940, 1900), (520, 1100), (2680, 1100), (900, 520), (2300, 1680)][index]
                point = {"id": f"spike-{index}", "x": fallback[0], "y": fallback[1],
                         "radius": SPIKE_RADIUS, "color": "#72c98e"}
            spikes.append({**point, "charge": 0})
        return spikes

    def create_food(self):
        return {"id": self.new_id("food"), **self.food_position(), "radius": 3.3, "color": self.rng.choice(FOOD_COLORS)}

    def standings(self):
        ranked = sorted(({key: owner[key] for key in ("ownerId", "name", "color", "team", "lives", "kills", "deaths", "connected", "isBot")}
                         | {"mass": sum(c["mass"] for c in self.cells[owner_id]), "cells": len(self.cells[owner_id]), "eliminated": owner["lives"] <= 0}
                         for owner_id, owner in self.players.items()),
                        key=lambda entry: (-entry["lives"], -entry["kills"], -entry["mass"], entry["ownerId"]))
        for index, entry in enumerate(ranked):
            previous = ranked[index - 1] if index else None
            entry["rank"] = previous["rank"] if previous and all(previous[k] == entry[k] for k in ("lives", "kills", "mass")) else index + 1
        return ranked

    def team_standings(self):
        if self.rules.mode != "teams":
            return []
        teams = []
        for team_id, (name, color) in enumerate(TEAMS):
            owners = [owner for owner in self.players.values() if owner["team"] == team_id]
            teams.append({"id": team_id, "name": name, "color": color,
                          "lives": sum(owner["lives"] for owner in owners),
                          "kills": sum(owner["kills"] for owner in owners),
                          "mass": sum(cell["mass"] for owner in owners for cell in self.cells[owner["ownerId"]]),
                          "active": sum(owner["lives"] > 0 for owner in owners)})
        teams.sort(key=lambda team: (-team["lives"], -team["kills"], -team["mass"], team["id"]))
        for index, team in enumerate(teams):
            previous = teams[index - 1] if index else None
            team["rank"] = previous["rank"] if previous and all(previous[key] == team[key] for key in ("lives", "kills", "mass")) else index + 1
        return teams

    def ability_snapshot(self, owner_id):
        owner, cells = self.players[owner_id], self.cells[owner_id]
        # 兼容旧绘制层的字段，但已取消的技能不会再显示为可用。
        sprint = {"active": False, "remaining": 0, "cooldown": 0, "affordable": False,
                  "ready": False, "multiplier": 1, "progress": 0}
        affordable_split = any(c["mass"] >= 72 for c in cells)
        remaining = max((c["mergeRemaining"] for c in cells), default=0) if len(cells) > 1 else 0
        splitting = {"count": len(cells), "maxCells": MAX_CELLS, "affordable": affordable_split, "cooldown": owner["splitCooldown"],
                     "ready": affordable_split and len(cells) < MAX_CELLS and owner["splitCooldown"] == 0,
                     "mergeRemaining": remaining, "merging": len(cells) > 1 and remaining == 0}
        source = max((cell for cell in cells if cell["mass"] >= SPORE_MINIMUM_MASS), key=lambda cell: cell["mass"], default=None)
        affordable_spore = source is not None and len(self.spores) < SPORE_MAX_COUNT
        spore = {"count": len(self.spores), "maxCount": SPORE_MAX_COUNT, "affordable": affordable_spore,
                 "cooldown": owner["sporeCooldown"], "ready": affordable_spore and owner["sporeCooldown"] == 0,
                 "progress": 1 if owner["sporeCooldown"] == 0 else 1 - owner["sporeCooldown"] / SPORE_COOLDOWN}
        return sprint, splitting, spore

    def snapshot(self):
        players = []
        for owner_id, owner in self.players.items():
            sprint, splitting, spore = self.ability_snapshot(owner_id)
            players.append({**{key: owner[key] for key in ("ownerId", "name", "color", "team", "score", "eatenBalls", "peakMass", "killer", "isBot")},
                            "sprint": sprint, "split": splitting, "spore": spore, "ack": owner["appliedSeq"],
                            "regrouping": owner["input"].get("regroup", False) and len(self.cells[owner_id]) > 1,
                            "stats": owner["stats"].snapshot(self.finished), "zoneExposure": owner['zoneExposure'],
                            "teamAction": owner.get('teamAction', ''),
                            "pingCooldown": self.signals.remaining(owner_id, self.elapsed)})
        standings = self.standings()
        # 合成速度供对手插值；独立运动分量供本人重放移动。快照均为独立副本。
        cells = [{key: cell[key] for key in ("id", "ownerId", "team", "name", "color", "alive")}
                 | {key: round(cell[key], 3) for key in ("x", "y", "mass", "radius", "speed", "mergeRemaining")}
                 | {"vx": round(cell["vx"] + cell["impulseX"], 3), "vy": round(cell["vy"] + cell["impulseY"], 3),
                    "motion": {key: round(cell[key], 3) for key in ("vx", "vy", "impulseX", "impulseY")}}
                 for cell in self.all_cells()]
        return {"tick": self.tick, "elapsed": self.elapsed, "duration": self.duration, "bounds": BOUNDS,
                "rules": self.rules.snapshot(), "teams": self.team_standings(),
                "safeZone": self.safe_zone.at(self.elapsed) if self.safe_zone else None,
                "pings": self.signals.snapshot(self.elapsed),
                "cells": cells, "foods": self.foods, "spores": [dict(spore) for spore in self.spores],
                "spikes": [dict(spike) for spike in self.spikes], "hotspots": dict(self.hotspots), "players": players,
                "standings": standings, "finished": self.finished, "reason": self.reason,
                "protectionByOwner": {key: max(0, p["protectedUntil"] - self.elapsed) for key, p in self.players.items()},
                "events": list(self.events)}
