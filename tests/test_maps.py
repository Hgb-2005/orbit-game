"""阶段 3：地图协议、障碍物理和房间权威地图校验。"""

import json
import unittest

from server.game.maps import DEFAULT_MAP, MapValidationError, map_summary, normalize_map
from server.game.obstacles import map_is_clear, resolve_obstacles
from server.multiplayer import RoomManager


def custom_map():
    return {
        "version": 1,
        "id": "duel-yard",
        "name": "决斗庭院",
        "width": 2400,
        "height": 1800,
        "spawnPoints": [
            {"id": "spawn-a", "x": 320, "y": 300},
            {"id": "spawn-b", "x": 2080, "y": 1500},
        ],
        "spikes": [
            {"id": "spike-a", "x": 1200, "y": 500, "radius": 48, "color": "#72c98e"},
        ],
        "obstacles": [
            {"id": "block-a", "x": 1200, "y": 900, "radius": 120, "color": "#60716b"},
        ],
    }


class MapProtocolTests(unittest.TestCase):
    def test_default_and_custom_maps_are_normalized_into_independent_copies(self):
        game_map = custom_map()
        normalized = normalize_map(game_map)
        self.assertEqual(normalized["spawnPoints"][0]["x"], 320.0)
        normalized["obstacles"][0]["x"] = 0
        self.assertEqual(game_map["obstacles"][0]["x"], 1200)
        self.assertEqual(map_summary(game_map), {
            "version": 1,
            "id": "duel-yard",
            "name": "决斗庭院",
            "width": 2400.0,
            "height": 1800.0,
            "spawnPoints": 2,
            "spikes": 1,
            "obstacles": 1,
        })
        self.assertEqual(normalize_map(DEFAULT_MAP)["id"], "default")

    def test_strict_validation_rejects_inconsistent_and_unsafe_maps(self):
        cases = []
        invalid_size = custom_map()
        invalid_size["width"] = 2400.5
        cases.append((invalid_size, "整数"))
        invalid_color = custom_map()
        invalid_color["spikes"][0]["color"] = "green"
        cases.append((invalid_color, "#RRGGBB"))
        duplicate_id = custom_map()
        duplicate_id["spikes"][0]["id"] = "block-a"
        cases.append((duplicate_id, "不能重复"))
        spawn_block = custom_map()
        spawn_block["obstacles"][0].update(x=320, y=300)
        cases.append((spawn_block, "出生点"))
        overlap = custom_map()
        overlap["obstacles"].append({
            "id": "block-b", "x": 1300, "y": 900, "radius": 120, "color": "#60716b",
        })
        cases.append((overlap, "互相覆盖"))
        for value, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(MapValidationError, message):
                    normalize_map(value)

    def test_non_strict_protocol_falls_back_to_default(self):
        self.assertEqual(normalize_map({"width": "bad"}, strict=False), DEFAULT_MAP)

    def test_obstacles_push_entities_out_and_reflect_inward_velocity(self):
        obstacle = custom_map()["obstacles"][0]
        entity = {
            "x": 1150,
            "y": 900,
            "radius": 30,
            "vx": 100,
            "vy": 0,
            "impulseX": 20,
            "impulseY": 0,
        }
        resolve_obstacles(entity, [obstacle], passes=3)
        self.assertAlmostEqual(entity["x"], 1050)
        self.assertLessEqual(entity["vx"], 0)
        self.assertLessEqual(entity["impulseX"], 0)
        self.assertTrue(map_is_clear({"x": 1200, "y": 500}, custom_map(), radius=0))
        self.assertFalse(map_is_clear({"x": 1240, "y": 900}, custom_map(), radius=50))


class RoomMapAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.manager = RoomManager(lambda _score: None)
        self.host = self.manager.connect()
        self.guest = self.manager.connect()
        self.manager.drain(self.host)
        self.manager.drain(self.guest)

    def tearDown(self):
        self.manager.close()

    def messages(self, peer):
        return [message for message in self.manager.drain(peer) if isinstance(message, dict)]

    def test_room_uses_validated_host_map_and_rejects_guest_changes(self):
        self.manager.command(self.host, {
            "type": "create", "name": "房主", "map": custom_map(),
        })
        room = next(iter(self.manager.rooms.values()))
        summary = self.manager.room_snapshot(room)["map"]
        self.assertEqual(summary["id"], "duel-yard")
        self.assertEqual(summary["obstacles"], 1)

        self.manager.command(self.guest, {
            "type": "join", "name": "客人", "code": room.code,
        })
        self.manager.command(self.guest, {"type": "configure_map", "map": DEFAULT_MAP})
        errors = [message for message in self.messages(self.guest) if message.get("type") == "error"]
        self.assertTrue(errors)
        self.assertEqual(room.game_map["id"], "duel-yard")

        changed = custom_map()
        changed["name"] = "房主新地图"
        self.manager.command(self.host, {"type": "configure_map", "map": changed})
        self.assertEqual(room.game_map["name"], "房主新地图")
        json.dumps(self.manager.room_snapshot(room), allow_nan=False, ensure_ascii=False)

    def test_invalid_map_is_rejected_before_room_creation(self):
        invalid = custom_map()
        invalid["obstacles"][0].update(x=320, y=300)
        self.manager.command(self.host, {
            "type": "create", "name": "房主", "map": invalid,
        })
        self.assertFalse(self.manager.rooms)
        self.assertTrue(any(message.get("type") == "error" for message in self.messages(self.host)))


if __name__ == "__main__":
    unittest.main()
