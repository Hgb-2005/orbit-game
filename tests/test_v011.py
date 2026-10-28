"""v0.11 连吐、喂刺和缓存策略；使用内存世界及临时排行榜。"""

import math
import json
import random
import tempfile
import unittest
from pathlib import Path

from server import create_app
from server.game.entities import BOUNDS, grow
from server.game.spikes import feed_spikes, update_spikes
from server.game.world import MultiplayerWorld


def fixed():
    return {"id": "fixed", "x": 1000, "y": 1000, "radius": 58, "charge": 0, "color": "#72c98e"}


def spore():
    return {"id": "spore", "x": 990, "y": 1000, "vx": 560, "vy": 0,
            "mass": 8, "radius": 6, "alive": True, "life": 5, "color": "#fff"}


def match():
    world = MultiplayerWorld([{"id": "p", "name": "我"}, {"id": "q", "name": "朋友"}], random.Random(42))
    world.elapsed = 4
    world.foods = []
    world.food_timer = -1e6
    world.spikes = []
    return world


class NewGameplayTests(unittest.TestCase):
    def test_fifth_spore_launches_and_overlapping_spikes_consume_only_once(self):
        spikes = [fixed(), {**fixed(), "id": "other"}]
        spores = [spore() for _ in range(4)]
        feed_spikes(spikes, spores, BOUNDS, lambda: "new")
        self.assertEqual(spikes[0]["charge"], 4)
        self.assertEqual(spikes[1]["charge"], 0)
        self.assertTrue(all(not item["alive"] for item in spores))
        events = feed_spikes(spikes, [spore()], BOUNDS, lambda: "new")
        self.assertEqual(events[-1]["type"], "spike-launch")
        self.assertEqual(spikes[0]["charge"], 0)
        self.assertEqual(spikes[-1]["vx"], 720)
        self.assertEqual(spikes[-1]["vy"], 0)
        self.assertEqual(spikes[-1]["life"], 8)

    def test_projectile_limit_lifetime_and_no_recursive_feeding(self):
        spikes = [fixed()]
        feed_spikes(spikes, [spore() for _ in range(100)], BOUNDS, lambda: "new")
        self.assertEqual(len(spikes), 16)
        extra = spore()
        feed_spikes(spikes, [extra], BOUNDS, lambda: "new")
        self.assertTrue(extra["alive"])
        extra["x"] = spikes[1]["x"]
        feed_spikes([spikes[1]], [extra], BOUNDS, lambda: "new")
        self.assertTrue(extra["alive"])
        self.assertEqual(len(update_spikes(spikes, 8, BOUNDS)), 1)

    def test_movement_is_step_independent_and_clamped(self):
        base = {**fixed(), "projectile": True, "life": 8, "vx": 720, "vy": 100}
        a, b = [dict(base)], [dict(base)]
        update_spikes(a, 1, BOUNDS)
        for _ in range(60):
            update_spikes(b, 1 / 60, BOUNDS)
        self.assertAlmostEqual(a[0]["x"], b[0]["x"])
        self.assertAlmostEqual(a[0]["y"], b[0]["y"])
        a[0]["x"] = BOUNDS["width"] - 59
        update_spikes(a, 1, BOUNDS)
        self.assertEqual(a[0]["x"], BOUNDS["width"] - 58)
        self.assertEqual(a[0]["vx"], 0)

    def test_continuous_spore_respects_cooldown_release_and_mass(self):
        world = match()
        cell = world.cells["p"][0]
        grow(cell, 100)
        for seq in range(29):
            world.set_input("p", {"seq": seq, "x": -1, "y": 0, "sporeHeld": True,
                                  "target": {"x": 3000, "y": cell["y"]}})
            world.update(1 / 30)
        self.assertEqual(len(world.spores), 3)
        self.assertTrue(all(item["vx"] > 0 for item in world.spores))
        self.assertEqual(cell["mass"], 112)
        world.set_input("p", {"seq": 29, "x": 0, "y": 0, "sporeHeld": False})
        for _ in range(25):
            world.update(1 / 30)
        self.assertEqual(len(world.spores), 3)
        grow(cell, 48 - cell["mass"])
        for seq in range(30, 65):
            world.set_input("p", {"seq": seq, "x": 0, "y": 1, "sporeHeld": True})
            world.update(1 / 30)
        self.assertEqual(cell["mass"], 40)
        self.assertEqual(len(world.spores), 4)

    def test_stale_input_and_explicit_stop_end_continuous_emission(self):
        world = match()
        grow(world.cells["p"][0], 300)
        world.set_input("p", {"seq": 0, "x": 1, "y": 0, "sporeHeld": True})
        for _ in range(35):
            world.update(1 / 30)
        before = len(world.spores)
        for _ in range(20):
            world.update(1 / 30)
        self.assertEqual(len(world.spores), before)
        self.assertFalse(world.players["p"]["input"]["sporeHeld"])
        world.set_input("p", {"seq": 1, "sporeHeld": True})
        world.stop_input(world.players["p"])
        self.assertFalse(world.players["p"]["input"]["sporeHeld"])

    def test_feeding_precedes_cell_consumption_and_snapshot_is_detached(self):
        world = match()
        world.spikes = [fixed()]
        world.spikes[0]["charge"] = 4
        world.spores = [spore()]
        cell = world.cells["p"][0]
        cell.update(x=1000, y=1000)
        world.update(1 / 30)
        self.assertEqual(cell["mass"], 36)
        self.assertEqual(len(world.spores), 0)
        self.assertEqual(len(world.spikes), 2)
        snapshot = world.snapshot()
        x = snapshot["spikes"][1]["x"]
        world.update(1 / 30)
        self.assertEqual(snapshot["spikes"][1]["x"], x)
        self.assertGreater(world.spikes[1]["x"], x)

    def test_launched_spike_uses_normal_damage_and_protection(self):
        world = match()
        cell = world.cells["p"][0]
        grow(cell, 108)
        world.spikes = [{**fixed(), "x": cell["x"], "y": cell["y"], "projectile": True,
                         "vx": 0, "vy": 0, "life": 8}]
        world.players["p"]["protectedUntil"] = 6
        world.handle_spikes()
        self.assertEqual(len(world.cells["p"]), 1)
        world.players["p"]["protectedUntil"] = 0
        world.handle_spikes()
        self.assertEqual(len(world.cells["p"]), 2)
        self.assertAlmostEqual(sum(item["mass"] for item in world.cells["p"]), 144 * .92)

    def test_cache_revalidation_includes_nested_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            client = create_app({"TESTING": True, "DATABASE": str(Path(directory) / "test.sqlite3")}).test_client()
            for path in ("/", "/static/js/core/spikes.js", "/static/css/style.css"):
                with client.get(path) as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.headers["Cache-Control"], "no-cache")
            version = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text(encoding="utf-8"))["version"]
            self.assertIn(f"V{version}", client.get("/").text)
