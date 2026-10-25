"""多人规则与房间协议测试；不启动真实端口，不触碰玩家数据库。"""

import json
import math
import random
import unittest

from server.game.entities import MAX_CELLS, ball, grow, merge, move, split
from server.game.world import MultiplayerWorld
from server.multiplayer import RECONNECT_GRACE, RoomManager


def match(count=3):
    world = MultiplayerWorld([{"id": str(i), "name": f"玩家{i}"} for i in range(count)], random.Random(7))
    world.foods = []
    world.food_timer = -1e6
    world.elapsed = 4
    return world


class MultiplayerRulesTests(unittest.TestCase):
    def test_equal_start_and_fixed_roster(self):
        world = match(4)
        self.assertEqual(len(world.players), 4)
        for pid, owner in world.players.items():
            self.assertEqual(owner["lives"], 3)
            self.assertEqual(world.cells[pid][0]["mass"], 36)
        self.assertEqual(world.duration, 300)

    def test_server_growth_food_and_speed(self):
        world = match()
        cell = world.cells["0"][0]
        world.foods = [{"id": "f", "x": cell["x"], "y": cell["y"], "radius": 3.3, "color": "#fff"}]
        world.consume_food()
        self.assertEqual(cell["mass"], 37)
        self.assertEqual(world.players["0"]["score"], 1)
        self.assertLess(cell["speed"], 220)
        world.consume_food()
        self.assertEqual(world.players["0"]["score"], 1)

    def test_spatial_food_query_scales_with_large_cell_radius(self):
        world = match()
        cell = world.cells["0"][0]
        grow(cell, 10000 - cell["mass"])
        world.foods = [{"id": "wide-food", "x": cell["x"] + 250, "y": cell["y"],
                        "radius": 3.3, "color": "#fff"}]
        world.consume_food()
        self.assertEqual(world.foods, [])
        self.assertEqual(world.players["0"]["score"], 1)

    def test_death_transfers_one_life_respawns_only_victim(self):
        world = match()
        eater, victim, other = (world.cells[str(i)][0] for i in range(3))
        grow(eater, 200)
        victim.update(x=eater["x"], y=eater["y"])
        before = dict(other)
        world.consume_balls()
        self.assertEqual(world.players["0"]["lives"], 4)
        self.assertEqual(world.players["1"]["lives"], 2)
        self.assertEqual(world.players["0"]["kills"], 1)
        self.assertEqual(eater["mass"], 272)
        newborn = world.cells["1"][0]
        self.assertNotEqual(newborn["id"], victim["id"])
        self.assertEqual(newborn["ownerId"], "1")
        self.assertEqual(newborn["mass"], 36)
        self.assertEqual(world.players["1"]["protectedUntil"], 7)
        self.assertEqual(other, before)
        self.assertFalse(world.finished)

    def test_fragments_only_final_cell_counts_as_death(self):
        world = match()
        eater, source = world.cells["0"][0], world.cells["1"][0]
        grow(eater, 500)
        grow(source, 108)
        split(world.cells["1"], (1, 0), lambda: world.new_id("cell"))
        first, last = world.cells["1"]
        first.update(x=eater["x"], y=eater["y"])
        last.update(x=2000, y=1000)
        world.consume_balls()
        self.assertEqual(world.players["1"]["lives"], 3)
        self.assertEqual(world.players["0"]["kills"], 0)
        last.update(x=eater["x"], y=eater["y"])
        world.consume_balls()
        self.assertEqual(world.players["1"]["lives"], 2)
        self.assertEqual(world.players["0"]["kills"], 1)
        self.assertEqual(len(world.cells["1"]), 1)

    def test_same_frame_fragment_death_and_protection_no_farming(self):
        world = match()
        eater, source = world.cells["0"][0], world.cells["1"][0]
        grow(eater, 500); grow(source, 108)
        split(world.cells["1"], (1, 0), lambda: world.new_id("cell"))
        for cell in world.cells["1"]:
            cell.update(x=eater["x"], y=eater["y"])
        world.consume_balls()
        self.assertEqual(world.players["0"]["kills"], 1)
        newborn = world.cells["1"][0]
        newborn.update(x=eater["x"], y=eater["y"])
        world.consume_balls()
        self.assertEqual(world.players["1"]["lives"], 2)
        grow(newborn, 2000)
        world.consume_balls()
        self.assertEqual(world.players["0"]["lives"], 4)
        world.elapsed += 3
        world.consume_balls()
        self.assertEqual(world.players["0"]["lives"], 3)

    def test_zero_lives_eliminates_without_resetting_room(self):
        world = match()
        eater, prey = world.cells["0"][0], world.cells["1"][0]
        world.players["1"]["lives"] = 1
        grow(eater, 500); prey.update(x=eater["x"], y=eater["y"])
        world.consume_balls()
        self.assertEqual(world.players["1"]["lives"], 0)
        self.assertEqual(world.cells["1"], [])
        self.assertFalse(world.finished)
        world.disconnect("2")
        self.assertTrue(world.finished)
        self.assertEqual(world.standings()[0]["ownerId"], "0")

    def test_split_sprint_cost_and_automatic_merge(self):
        world = match()
        grow(world.cells["0"][0], 108)
        world.set_input("0", {"seq": 1, "x": 1, "y": 0, "split": True})
        world.update(1 / 30)
        self.assertEqual(len(world.cells["0"]), 2)
        self.assertAlmostEqual(sum(c["mass"] for c in world.cells["0"]), 144)
        world.set_input("0", {"seq": 2, "x": 1, "y": 0, "sprint": True})
        world.update(1 / 30)
        self.assertAlmostEqual(sum(c["mass"] for c in world.cells["0"]), 144 * .93)
        self.assertEqual(world.players["0"]["score"], 0)
        self.assertEqual(len(world.cells["0"]), 2)
        for _ in range(400):
            world.update(1 / 30)
        self.assertEqual(len(world.cells["0"]), 1)
        self.assertAlmostEqual(world.cells["0"][0]["mass"], 144 * .93)

    def test_short_key_tap_is_queued_across_network_packets(self):
        world = match()
        grow(world.cells["0"][0], 108)
        world.set_input("0", {"seq": 1, "x": 1, "y": 0, "split": True})
        world.set_input("0", {"seq": 2, "x": 1, "y": 0, "split": False})
        world.update(1 / 30)
        self.assertEqual(len(world.cells["0"]), 2)
        for _ in range(30):
            world.set_input("0", {"seq": 3 + _, "x": 1, "y": 0, "split": False})
            world.update(1 / 30)
        self.assertEqual(len(world.cells["0"]), 2)

    def test_client_cannot_submit_mass_lives_position_or_score(self):
        world = match()
        original_x = world.cells["0"][0]["x"]
        world.set_input("0", {"seq": 1, "x": 999, "y": 999, "mass": 1e9, "lives": 99, "score": 999, "position": {"x": 0, "y": 0}})
        world.update(1 / 30)
        self.assertEqual(world.cells["0"][0]["mass"], 36)
        self.assertEqual(world.players["0"]["score"], 0)
        self.assertEqual(world.players["0"]["lives"], 3)
        self.assertLess(world.cells["0"][0]["x"] - original_x, 220 / 30)

    def test_invalid_and_reordered_inputs_do_not_mutate_controls(self):
        world = match()
        for bad in [float("nan"), float("inf"), True, "1", 10 ** 1000]:
            world.set_input("0", {"seq": 1, "x": bad, "y": 0})
        self.assertEqual(world.players["0"]["lastSeq"], -1)
        world.set_input("0", {"seq": 4, "x": 1, "y": 0})
        world.set_input("0", {"seq": 3, "x": -1, "y": 0})
        self.assertEqual(world.players["0"]["input"]["x"], 1)
        self.assertEqual(world.players["0"]["lastSeq"], 4)

    def test_stale_input_and_blur_stop_only_sender_clock_continues(self):
        world = match()
        for pid in world.players:
            world.set_input(pid, {"seq": 1, "x": 1, "y": 0})
        world.stop_input(world.players["0"])
        world.update(.1)
        self.assertEqual(world.players["0"]["input"]["x"], 0)
        self.assertEqual(world.players["1"]["input"]["x"], 1)
        world.update(1)
        self.assertEqual(world.players["1"]["input"]["x"], 0)
        self.assertAlmostEqual(world.elapsed, 5.1)

    def test_timeout_exact_and_shared_ties(self):
        world = match(2)
        world.elapsed = 299.99
        before = world.cells["0"][0]["x"]
        world.update(1 / 30)
        self.assertTrue(world.finished)
        self.assertEqual(world.elapsed, 300)
        self.assertEqual(world.reason, "timeout")
        self.assertEqual(world.cells["0"][0]["x"], before)
        self.assertEqual([entry["rank"] for entry in world.standings()], [1, 1])
        self.assertEqual(len([e for e in world.events if e["type"] == "gameover"]), 1)
        world.update(10)
        self.assertEqual(world.elapsed, 300)
        json.dumps(world.snapshot(), allow_nan=False)

    def test_full_five_minute_server_simulation_remains_valid(self):
        world = MultiplayerWorld([{"id": str(i), "name": str(i)} for i in range(4)], random.Random(42))
        # 正常食物与富集区刷新，周期性输入；完整覆盖 9000 个服务器步长。
        for frame in range(9000):
            if frame % 10 == 0:
                for index, pid in enumerate(world.players):
                    world.set_input(pid, {"seq": frame, "x": math.sin(frame / 90 + index), "y": math.cos(frame / 90 + index), "split": frame % 300 == 0})
            world.update(1 / 30)
            if world.finished:
                break
            if frame % 300 == 0:
                self.assertEqual(sum(p["lives"] for p in world.players.values()), 12)
                self.assertTrue(all(c["mass"] > 0 and math.isfinite(c["x"]) for c in world.all_cells()))
            self.assertLessEqual(len(world.all_cells()), 4 * MAX_CELLS)
            self.assertLessEqual(len(world.foods), 560)
        self.assertTrue(world.finished)
        self.assertIn(world.reason, ("timeout", "last-survivor"))


class RoomProtocolTests(unittest.TestCase):
    def setUp(self):
        self.saved = []
        self.manager = RoomManager(self.saved.append)
        self.ids = [self.manager.connect() for _ in range(5)]
        for pid in self.ids:
            self.manager.drain(pid)

    def tearDown(self):
        self.manager.close()

    def command(self, index, **payload):
        self.manager.command(self.ids[index], payload)

    def create(self, count=2):
        self.command(0, type="create", name="甲")
        room = next(iter(self.manager.rooms.values()))
        for index in range(1, count):
            self.command(index, type="join", name=str(index), code=room.code)
        return room

    def start(self, room):
        for index in range(len(room.members)):
            self.command(index, type="ready", ready=True)
        self.command(0, type="start")

    def test_capacity_room_code_and_nickname_validation(self):
        self.command(0, type="create", name="")
        self.assertFalse(self.manager.rooms)
        room = self.create(4)
        self.assertRegex(room.code, r"^[0-9]{6}$")
        self.command(4, type="join", name="extra", code=room.code)
        self.assertEqual(len(room.members), 4)
        self.assertTrue(any(m.get("type") == "error" for m in self.manager.drain(self.ids[4])))
        self.command(4, type="join", name="extra", code="abcdef")
        self.assertFalse(self.manager.peers[self.ids[4]].room)

    def test_only_host_can_start_after_everyone_ready(self):
        room = self.create()
        self.command(0, type="start")
        self.assertEqual(room.state, "waiting")
        self.command(0, type="ready", ready=True)
        self.command(1, type="ready", ready=True)
        self.command(1, type="start")
        self.assertEqual(room.state, "waiting")
        self.command(0, type="start")
        self.assertEqual(room.state, "playing")
        self.assertEqual(len(room.world.players), 4)
        self.assertEqual(len(room.world.bot_ids), 2)
        self.command(2, type="join", name="late", code=room.code)
        self.assertEqual(len(room.members), 2)

    def test_single_human_room_is_filled_with_server_bots(self):
        room = self.create(1)
        self.command(0, type="ready", ready=True)
        self.command(0, type="start")
        self.assertEqual(room.state, "playing")
        self.assertEqual(len(room.world.human_ids), 1)
        self.assertEqual(len(room.world.bot_ids), 3)
        self.assertEqual(len(room.world.players), 4)
        latest_room = [message for message in self.manager.drain(self.ids[0])
                       if isinstance(message, dict) and message.get("type") == "room"][-1]
        self.assertEqual(latest_room["aiCount"], 3)
        self.assertEqual(latest_room["participantCount"], 4)
        before = {owner_id: (cells[0]["x"], cells[0]["y"])
                  for owner_id, cells in room.world.cells.items() if owner_id in room.world.bot_ids}
        for _ in range(12):
            self.manager.advance(1 / 30)
        self.assertTrue(any((room.world.cells[owner_id][0]["x"], room.world.cells[owner_id][0]["y"]) != before[owner_id]
                            for owner_id in room.world.bot_ids))
        self.assertTrue(all(room.world.players[owner_id]["isBot"] for owner_id in room.world.bot_ids))

    def test_host_transfer_and_empty_room_cleanup(self):
        room = self.create(3)
        self.manager.disconnect(self.ids[0])
        self.assertEqual(room.host, self.ids[1])
        self.assertEqual(len(room.members), 2)
        self.manager.disconnect(self.ids[1]); self.manager.disconnect(self.ids[2])
        self.assertFalse(self.manager.rooms)

    def test_socket_close_can_resume_same_player_before_grace_expires(self):
        now = [0.0]
        saved = []
        manager = RoomManager(saved.append, clock=lambda: now[0])
        try:
            first, second = manager.connect(), manager.connect()
            manager.drain(first); manager.drain(second)
            manager.command(first, {"type": "create", "name": "甲"})
            room = next(iter(manager.rooms.values()))
            manager.command(second, {"type": "join", "name": "乙", "code": room.code})
            for peer_id in (first, second):
                manager.command(peer_id, {"type": "ready", "ready": True})
            manager.command(first, {"type": "start"})
            original_world = room.world
            token = manager.peers[first].resume_token

            manager.socket_closed(first)
            self.assertIn(first, room.members)
            self.assertFalse(manager.peers[first].connected)
            room_messages = [message for message in manager.drain(second)
                             if isinstance(message, dict) and message.get("type") == "room"]
            self.assertTrue(room_messages)
            self.assertFalse(next(member for member in room_messages[-1]["members"] if member["id"] == first)["connected"])

            newcomer = manager.connect()
            resumed_id = manager.command(newcomer, {"type": "resume", "token": token})
            self.assertEqual(resumed_id, first)
            self.assertNotIn(newcomer, manager.peers)
            self.assertTrue(manager.peers[first].connected)
            self.assertIs(room.world, original_world)
            self.assertTrue(room.world.players[first]["connected"])
            self.assertTrue(any(message.get("type") == "resumed" for message in manager.drain(first)
                                if isinstance(message, dict)))

            manager.socket_closed(first)
            now[0] = RECONNECT_GRACE + 0.01
            manager.reap_disconnected()
            self.assertNotIn(first, manager.peers)
            self.assertNotIn(first, room.members)
            self.assertFalse(room.world.players[first]["connected"])
        finally:
            manager.close()

    def test_server_owns_identity_round_and_world_values(self):
        room = self.create()
        self.start(room)
        self.command(0, type="input", roundId="old", seq=1, x=1, y=0)
        self.assertEqual(room.world.players[self.ids[0]]["lastSeq"], -1)
        self.command(0, type="input", roundId=room.round_id, seq=1, x=1, y=0, ownerId=self.ids[1], lives=99)
        self.assertEqual(room.world.players[self.ids[0]]["lastSeq"], 1)
        self.assertEqual(room.world.players[self.ids[1]]["lastSeq"], -1)
        self.assertEqual(room.world.players[self.ids[0]]["lives"], 3)

    def test_disconnect_finishes_match_and_persists_once(self):
        room = self.create()
        self.start(room)
        for bot_id in room.world.bot_ids:
            room.world.players[bot_id]["lives"] = 0
            room.world.cells[bot_id] = []
        room.world.players[self.ids[0]]["score"] = 77
        self.manager.disconnect(self.ids[1])
        self.manager.advance(1 / 30)
        self.assertEqual(room.state, "finished")
        self.assertEqual(self.saved, [77])
        self.manager.advance(1)
        self.assertEqual(self.saved, [77])

    def test_finished_score_ignores_bot_score(self):
        room = self.create(1)
        self.command(0, type="ready", ready=True)
        self.command(0, type="start")
        human_id = self.ids[0]
        bot_id = next(iter(room.world.bot_ids))
        room.world.players[human_id]["score"] = 17
        room.world.players[bot_id]["score"] = 9999
        room.world.finish("timeout")
        self.manager.advance(1 / 30)
        self.assertEqual(self.saved, [17])

    def test_rematch_requires_new_readiness_nonce_and_clears_old_snapshots(self):
        room = self.create()
        self.start(room)
        old_round = room.round_id
        room.world.finish("timeout")
        self.manager.advance(1 / 30)
        self.command(1, type="rematch")
        self.assertEqual(room.state, "finished")
        self.command(0, type="rematch")
        self.assertEqual(room.state, "waiting")
        self.assertTrue(all(not self.manager.peers[pid].ready for pid in room.members))
        self.assertIsNone(self.manager.peers[self.ids[0]].pending_state)
        self.start(room)
        self.assertNotEqual(room.round_id, old_round)
        self.assertEqual(room.world.elapsed, 0)
        self.assertEqual(room.world.players[self.ids[0]]["lives"], 3)

    def test_everyone_leaving_before_next_tick_still_saves_computed_score(self):
        room = self.create()
        self.start(room)
        room.world.players[self.ids[0]]["score"] = 123
        self.manager.disconnect(self.ids[0])
        self.manager.disconnect(self.ids[1])
        self.assertFalse(self.manager.rooms)
        self.manager.advance(1 / 30)
        self.assertEqual(self.saved, [123])
        self.manager.advance(1 / 30)
        self.assertEqual(self.saved, [123])

    def test_database_retry_notifies_clients_only_after_success(self):
        room = self.create()
        self.start(room)
        room.world.players[self.ids[0]]["score"] = 45
        room.world.finish("timeout")
        def unavailable(_score):
            raise OSError("temporarily unavailable")
        self.manager.save_score = unavailable
        with self.assertLogs("server.multiplayer", level="ERROR"):
            self.manager.advance(1 / 30)
        self.assertFalse(any(isinstance(m, dict) and m.get("type") == "record_saved"
                             for m in self.manager.drain(self.ids[0])))
        self.manager.save_score = self.saved.append
        self.manager.advance(1 / 30)
        self.assertEqual(self.saved, [45])
        self.assertTrue(any(isinstance(m, dict) and m.get("type") == "record_saved"
                            for m in self.manager.drain(self.ids[0])))

    def test_latest_state_and_foods_are_retained_without_growing_queue(self):
        room = self.create()
        self.start(room)
        for _ in range(10):
            self.manager.advance(1 / 30)
        messages = self.manager.drain(self.ids[0])
        wire = [json.loads(m) for m in messages if isinstance(m, str)]
        self.assertEqual(len([m for m in wire if m["type"] == "state"]), 1)
        self.assertEqual(len([m for m in wire if m["type"] == "foods"]), 1)
        self.assertGreater(wire[-1]["world"]["tick"], 0)
        self.assertNotIn("input", wire[-1]["world"]["players"][0])

    def test_invalid_protocol_messages_and_duplicate_names(self):
        room = self.create()
        for payload in (None, [], "input", {"type": "unknown"}):
            self.manager.command(self.ids[0], payload)
        self.command(2, type="join", name="甲", code=room.code)
        self.assertEqual(len(room.members), 2)
        self.assertEqual(self.manager.peers[self.ids[2]].room, "")


if __name__ == "__main__":
    unittest.main()
