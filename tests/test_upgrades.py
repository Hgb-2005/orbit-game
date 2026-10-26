"""团队玩法和增量传输的回归测试，全部使用内存世界，不读取用户排行榜。"""

import json
import random
import unittest

from server.game.entities import grow
from server.game.rules import RoomRules
from server.game.world import MultiplayerWorld
from server.multiplayer import RoomManager
from server.replication import FoodFrame


def team_match():
    world = MultiplayerWorld([{"id": str(i), "name": str(i)} for i in range(4)],
                             random.Random(15), RoomRules("teams", 180))
    world.elapsed = 4
    world.foods = []
    world.food_timer = -1e6
    world.spikes = []
    return world


class TeamRulesTests(unittest.TestCase):
    def test_rule_validation_rejects_unbounded_and_private_parameters(self):
        self.assertEqual(RoomRules.parse().duration, 300)
        self.assertEqual(RoomRules.parse({"mode": "teams", "duration": 480}).mode, "teams")
        for value in ([], {"mode": "hack"}, {"duration": True}, {"duration": 1e9},
                      {"duration": 180.0}, {"mass": 999}, {"mode": []}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                RoomRules.parse(value)

    def test_balanced_teams_cannot_eat_allies_but_can_eat_enemies(self):
        world = team_match()
        self.assertEqual([p["team"] for p in world.players.values()], [0, 1, 0, 1])
        self.assertEqual(world.players["0"]["color"], world.players["2"]["color"])
        eater, ally, enemy = [world.cells[pid][0] for pid in ("0", "2", "1")]
        grow(eater, 400)
        ally.update(x=eater["x"], y=eater["y"])
        world.consume_balls()
        self.assertEqual(world.players["2"]["lives"], 3)
        self.assertEqual(world.players["0"]["kills"], 0)
        enemy.update(x=eater["x"], y=eater["y"])
        world.consume_balls()
        self.assertEqual(world.players["1"]["lives"], 2)
        self.assertEqual(world.players["0"]["lives"], 4)
        self.assertEqual(world.players["0"]["kills"], 1)
        self.assertEqual(world.cells["1"][0]["mass"], 36)

    def test_team_finishes_only_when_no_opposing_team_survives(self):
        world = team_match()
        world.disconnect("1")
        self.assertFalse(world.finished)
        world.disconnect("3")
        self.assertTrue(world.finished)
        self.assertEqual(world.reason, "last-team")
        self.assertEqual(sum(p["lives"] > 0 for p in world.players.values()), 2)
        self.assertEqual(world.team_standings()[0]["id"], 0)

    def test_team_timeout_uses_sums_and_preserves_shared_ranks(self):
        world = team_match()
        self.assertEqual([team["rank"] for team in world.team_standings()], [1, 1])
        world.players["3"]["lives"] += 1
        world.elapsed = 179.99
        world.update(1 / 30)
        self.assertEqual(world.elapsed, 180)
        self.assertEqual(world.reason, "timeout")
        self.assertEqual(world.team_standings()[0]["id"], 1)
        self.assertEqual(world.team_standings()[0]["lives"], 7)

    def test_bot_ignores_allied_prey(self):
        world = team_match()
        bot, ally = world.cells["0"][0], world.cells["2"][0]
        grow(bot, 100)
        ally.update(x=bot["x"] + 100, y=bot["y"])
        world.foods = [{"x": bot["x"] - 50, "y": bot["y"]}]
        dx, _ = world.choose_bot_direction(world.players["0"], world.cells["0"])
        self.assertLess(dx, 0)

    def test_mouse_target_defines_skill_aim_and_snapshots_are_detached(self):
        world = team_match()
        source = world.cells["0"][0]
        grow(source, 100)
        world.set_input("0", {"seq": 0, "x": -1, "y": 0, "split": True,
                              "target": {"x": source["x"] + 500, "y": source["y"]}})
        world.update(1 / 30)
        child = world.cells["0"][1]
        self.assertGreater(child["impulseX"], 0)
        snap = world.snapshot()
        original_x = snap["cells"][0]["x"]
        source["x"] += 100
        world.hotspots["remaining"] = 1
        self.assertEqual(snap["cells"][0]["x"], original_x)
        self.assertNotEqual(snap["hotspots"]["remaining"], 1)
        self.assertNotIn("impulseX", snap["cells"][0])
        self.assertNotIn("input", snap["players"][0])


class FoodReplicationTests(unittest.TestCase):
    def test_thirty_simulation_steps_deliver_twenty_updates_without_cadence_drift(self):
        manager = RoomManager()
        try:
            pid = manager.connect()
            manager.command(pid, {"type": "create", "name": "频率测试"})
            manager.command(pid, {"type": "ready", "ready": True})
            manager.command(pid, {"type": "start"})
            manager.drain(pid)
            for _ in range(3):
                updates = 0
                for _ in range(30):
                    manager.advance(1 / 30)
                    updates += sum(json.loads(message)["type"] == "state"
                                   for message in manager.drain(pid) if isinstance(message, str))
                self.assertEqual(updates, 20)
        finally:
            manager.close()

    def test_team_membership_change_requires_new_ready_confirmation(self):
        manager = RoomManager()
        try:
            host, guest, newcomer = [manager.connect() for _ in range(3)]
            manager.command(host, {"type": "create", "name": "甲", "rules": {"mode": "teams"}})
            room = next(iter(manager.rooms.values()))
            manager.command(guest, {"type": "join", "name": "乙", "code": room.code})
            for pid in room.members:
                manager.command(pid, {"type": "ready", "ready": True})
            manager.command(newcomer, {"type": "join", "name": "丙", "code": room.code})
            self.assertTrue(all(not manager.peers[pid].ready for pid in room.members))
            for pid in room.members:
                manager.command(pid, {"type": "ready", "ready": True})
            manager.command(guest, {"type": "leave"})
            snapshot = manager.room_snapshot(room)
            self.assertEqual([member["team"] for member in snapshot["members"]], [0, 1])
            self.assertTrue(all(not member["ready"] for member in snapshot["members"]))
            manager.command(host, {"type": "start"})
            self.assertEqual(room.state, "waiting")
        finally:
            manager.close()

    def test_patch_tracks_removal_reposition_and_addition(self):
        foods = [{"id": str(i), "x": i * 10.123456, "y": 30, "radius": 3.3, "color": "#fff"} for i in range(30)]
        first = FoodFrame.capture("r", 0, foods)
        foods[1]["x"] = 100
        foods.pop(0)
        foods.append({"id": "new", "x": 4, "y": 5, "radius": 3.3, "color": "#fff"})
        second = FoodFrame.capture("r", 8, foods)
        patch = json.loads(second.message(first.foods, 0))
        self.assertEqual(patch["type"], "food_patch")
        self.assertEqual(patch["baseVersion"], 0)
        self.assertEqual(patch["version"], 8)
        self.assertEqual(patch["removed"], ["0"])
        self.assertEqual({food["id"] for food in patch["upsert"]}, {"1", "new"})
        self.assertNotEqual(first.foods["1"]["x"], 100)
        self.assertLess(len(second.message(first.foods, 0)), len(second.message()) * .25)

    def test_slow_connection_gets_patch_from_last_drained_baseline_and_can_resync(self):
        manager = RoomManager()
        try:
            pid = manager.connect()
            manager.command(pid, {"type": "create", "name": "测试"})
            room = next(iter(manager.rooms.values()))
            manager.command(pid, {"type": "ready", "ready": True})
            manager.command(pid, {"type": "start"})
            first = [json.loads(m) for m in manager.drain(pid) if isinstance(m, str)]
            full = next(m for m in first if m["type"] == "foods")
            local = {food["id"]: food for food in full["foods"]}
            removed = room.world.foods[0]["id"]
            room.world.foods.pop(0)
            room.world.food_version += 1
            manager.broadcast_state(room)
            room.world.foods[0]["x"] += 40
            room.world.foods.append(room.world.create_food())
            room.world.food_version += 1
            room.world.emit("split", room.world.players[pid], x=4, y=5, color="#fff")
            manager.broadcast_state(room)
            delivered = [json.loads(m) for m in manager.drain(pid) if isinstance(m, str)]
            patch = next(m for m in delivered if m["type"] == "food_patch")
            self.assertEqual(patch["baseVersion"], full["version"])
            for key in patch["removed"]:
                local.pop(key, None)
            for food in patch["upsert"]:
                local[food["id"]] = food
            self.assertNotIn(removed, local)
            self.assertEqual(local, room.food_frame.foods)
            self.assertEqual(len(delivered[-1]["world"]["events"]), 1)
            manager.broadcast_state(room)
            again = [json.loads(m) for m in manager.drain(pid) if isinstance(m, str)]
            self.assertEqual([m["type"] for m in again], ["state"])
            self.assertEqual(again[0]["world"]["events"], [])
            manager.command(pid, {"type": "resync_foods", "roundId": room.round_id})
            resync = [json.loads(m) for m in manager.drain(pid) if isinstance(m, str)]
            self.assertEqual(resync[0]["type"], "foods")
        finally:
            manager.close()

    def test_only_host_can_change_rules_and_everyone_must_prepare_again(self):
        manager = RoomManager()
        try:
            host, guest = manager.connect(), manager.connect()
            manager.command(host, {"type": "create", "name": "甲"})
            room = next(iter(manager.rooms.values()))
            manager.command(guest, {"type": "join", "name": "乙", "code": room.code})
            for pid in (host, guest):
                manager.command(pid, {"type": "ready", "ready": True})
            rules = {"mode": "teams", "duration": 180}
            manager.command(guest, {"type": "configure", "rules": rules})
            self.assertEqual(room.rules.mode, "survival")
            manager.command(host, {"type": "configure", "rules": rules})
            self.assertTrue(all(not manager.peers[pid].ready for pid in room.members))
            for pid in (host, guest):
                manager.command(pid, {"type": "ready", "ready": True})
            manager.socket_closed(guest)
            manager.command(host, {"type": "start"})
            self.assertEqual(room.state, "waiting")
            manager.peers[guest].connected = True
            manager.command(host, {"type": "start"})
            self.assertEqual(room.world.rules.mode, "teams")
            self.assertEqual(room.world.duration, 180)
            manager.disconnect(host)
            snapshot = manager.room_snapshot(room)
            self.assertEqual(snapshot["members"][0]["team"], 1)
        finally:
            manager.close()
