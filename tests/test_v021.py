"""v0.21 阶段 2：道具、连击、隐身可见性和服务端权威边界。"""

import json
import random
import unittest

from server.game.entities import ball, grow
from server.game.rules import RoomRules
from server.game.world import MultiplayerWorld
from server.multiplayer import RoomManager


def make_world(count=3, item_mode="standard"):
    world = MultiplayerWorld(
        [{"id": str(index), "name": f"玩家{index}"} for index in range(count)],
        random.Random(42),
        RoomRules(itemMode=item_mode),
    )
    world.elapsed = 4
    world.foods = []
    world.spikes = []
    world.food_timer = -1e6
    for owner in world.players.values():
        owner["protectedUntil"] = 0
    return world


class ItemRulesTests(unittest.TestCase):
    def test_item_mode_validation_and_refill_intervals(self):
        self.assertEqual(RoomRules.parse({"itemMode": "off"}).itemMode, "off")
        with self.assertRaises(ValueError):
            RoomRules.parse({"itemMode": "unlimited"})

        for mode, count, interval in (
            ("off", 0, 0),
            ("standard", 18, 4.5),
            ("rich", 36, 2.4),
        ):
            world = make_world(item_mode=mode)
            system = world.item_system
            system.items = []
            system.refill = 0
            if interval:
                system.update(interval * .99)
                self.assertEqual(len(system.items), 0)
                system.update(interval * .02)
                self.assertEqual(len(system.items), 1)
            else:
                system.update(1000)
                self.assertEqual(len(system.items), count)

    def test_pickup_refreshes_duration_without_stacking(self):
        world = make_world(count=2, item_mode="off")
        cell = world.cells["0"][0]
        definition = {"id": "item", "type": "shield", "x": cell["x"], "y": cell["y"],
                      "radius": 12, "color": "#82b8d8", "symbol": "盾"}
        world.item_system.items = [dict(definition)]
        world.item_system.pickup()
        first_until = world.item_system.effects["0"]["shield"]
        self.assertEqual(world.item_system.items, [])
        self.assertEqual(world.events[-1]["type"], "item")
        self.assertEqual(world.events[-1]["ownerId"], "0")

        world.elapsed += 2
        world.item_system.items = [dict(definition, id="item-2")]
        world.item_system.pickup()
        effects = world.item_system.effects["0"]
        self.assertEqual(list(effects), ["shield"])
        self.assertEqual(effects["shield"], first_until + 2)

    def test_shield_blocks_eat_at_low_frequency_but_not_spike_damage(self):
        world = make_world(count=2, item_mode="off")
        attacker, victim = world.cells["0"][0], world.cells["1"][0]
        grow(attacker, 600)
        victim.update(x=attacker["x"], y=attacker["y"])
        world.item_system.apply("1", "shield")
        world.consume_balls()

        self.assertEqual(world.players["1"]["lives"], 3)
        self.assertEqual(world.cells["1"][0]["mass"], 36)
        blocks = [event for event in world.events if event["type"] == "shield-block"]
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0]["ownerId"], "1")
        self.assertFalse(world.item_system.record_shield_block("1"))

        world.events = []
        grow(victim, 120)
        before = sum(cell["mass"] for cell in world.cells["1"])
        world.spikes = [{"id": "spike", "x": victim["x"], "y": victim["y"], "radius": 58,
                         "color": "#72c98e", "charge": 0}]
        world.handle_spikes()
        self.assertLess(sum(cell["mass"] for cell in world.cells["1"]), before)
        self.assertTrue(any(event["type"] == "spike" and event["ownerId"] == "1"
                            for event in world.events))

    def test_magnet_moves_food_inside_bounds_and_advances_food_version(self):
        world = make_world(count=2, item_mode="off")
        source = world.cells["0"][0]
        source.update(x=20, y=20)
        world.foods = [
            {"id": "outside", "x": -10, "y": 20, "radius": 3.3, "color": "#fff"},
            {"id": "nearby", "x": 120, "y": 20, "radius": 3.3, "color": "#fff"},
            {"id": "far", "x": 900, "y": 900, "radius": 3.3, "color": "#fff"},
        ]
        world.item_system.apply("0", "magnet")
        before_version = world.food_version
        world.item_system.magnet(.05)

        self.assertGreaterEqual(world.foods[0]["x"], world.foods[0]["radius"])
        self.assertLess(world.foods[1]["x"], 120)
        self.assertEqual(world.foods[2]["x"], 900)
        self.assertGreater(world.food_version, before_version)

    def test_snapshot_and_finished_state_serialize_without_non_finite_numbers(self):
        world = make_world(count=4)
        world.item_system.apply("0", "shield")
        world.item_system.apply("1", "magnet")
        world.emit("shield-block", world.players["0"], attackerId="1", x=100, y=100)
        encoded = json.dumps(world.snapshot(), allow_nan=False, ensure_ascii=False)
        self.assertIn('"itemCombo"', encoded)
        self.assertIn('"items"', encoded)

    def test_client_cannot_forge_items_effects_lives_mass_or_score(self):
        world = make_world(count=2, item_mode="standard")
        original_mass = world.cells["0"][0]["mass"]
        world.set_input("0", {
            "seq": 1, "x": 1, "y": 0,
            "mass": 999999, "lives": 99, "score": 999999,
            "items": {"effects": {"0": {"shield": 999999}}},
            "effects": {"0": {"cloak": 999999}},
            "inventory": ["shield"],
        })
        world.update(1 / 30)
        self.assertEqual(world.cells["0"][0]["mass"], original_mass)
        self.assertEqual(world.players["0"]["lives"], 3)
        self.assertEqual(world.players["0"]["score"], 0)
        self.assertEqual(world.item_system.effects, {})


class ItemPrivacyProtocolTests(unittest.TestCase):
    def setUp(self):
        self.manager = RoomManager(lambda _score: None)
        self.peers = [self.manager.connect() for _ in range(3)]
        for peer_id in self.peers:
            self.manager.drain(peer_id)
        self.manager.command(self.peers[0], {
            "type": "create", "name": "甲", "rules": {"itemMode": "standard"},
        })
        self.room = next(iter(self.manager.rooms.values()))
        self.manager.command(self.peers[1], {
            "type": "join", "name": "乙", "code": self.room.code,
        })
        for peer_id in self.peers[:2]:
            self.manager.command(peer_id, {"type": "ready", "ready": True})
        self.manager.command(self.peers[0], {"type": "start"})
        for peer_id in self.peers[:2]:
            self.manager.drain(peer_id)

    def tearDown(self):
        self.manager.close()

    @staticmethod
    def latest_state(messages):
        states = [json.loads(message) for message in messages if isinstance(message, str)]
        return next(message["world"] for message in states if message["type"] == "state")

    def test_cloaked_enemy_is_removed_from_cells_players_events_rankings_and_effects(self):
        world = self.room.world
        owner_id, observer_id = self.peers[1], self.peers[0]
        world.elapsed = 4
        world.item_system.apply(owner_id, "cloak")
        world.emit("split", world.players[owner_id], x=100, y=100, color=world.players[owner_id]["color"])
        self.manager.broadcast_state(self.room)

        enemy = self.latest_state(self.manager.drain(observer_id))
        self.assertNotIn(owner_id, {cell["ownerId"] for cell in enemy["cells"]})
        self.assertNotIn(owner_id, {player["ownerId"] for player in enemy["players"]})
        self.assertNotIn(owner_id, {entry["ownerId"] for entry in enemy["standings"]})
        self.assertNotIn(owner_id, enemy["items"]["effects"])
        self.assertNotIn(owner_id, enemy["protectionByOwner"])
        self.assertFalse(any(owner_id in (event.get("ownerId"), event.get("actorId"),
                                         event.get("attackerId"), event.get("victimId"))
                             for event in enemy["events"]))

        self.manager.broadcast_state(self.room)
        own = self.latest_state(self.manager.drain(owner_id))
        self.assertIn(owner_id, {cell["ownerId"] for cell in own["cells"]})
        self.assertIn(owner_id, own["items"]["effects"])


if __name__ == "__main__":
    unittest.main()
