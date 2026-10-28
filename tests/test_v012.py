"""聚拢权威计算与服务端复盘；不触碰正式数据库。"""
import random
import unittest

from server.game.entities import ball, grow
from server.game.stats import RoundStats
from server.game.world import MultiplayerWorld


def match():
    world = MultiplayerWorld([{"id": "p", "name": "我"}, {"id": "q", "name": "朋友"}], random.Random(42))
    world.elapsed = 4
    world.foods = []
    world.food_timer = -1e6
    world.spikes = []
    return world


class RegroupAndRecapTests(unittest.TestCase):
    def test_regroup_contracts_without_early_merge_or_mass_change(self):
        w = match()
        owner = w.players["p"]
        w.cells["p"] = [ball(str(i), owner, {"x": 650 + i * 300, "y": 550}) for i in range(2)]
        for cell in w.cells["p"]:
            grow(cell, 72 - cell["mass"])
            cell["mergeRemaining"] = 10
        for seq in range(60):
            w.set_input("p", {"seq": seq, "x": 1, "y": 0, "regroup": True, "target": {"x": 3000, "y": 550}})
            w.update(1 / 30)
        self.assertEqual(len(w.cells["p"]), 2)
        self.assertEqual(sum(c["mass"] for c in w.cells["p"]), 144)
        self.assertLess(abs(w.cells["p"][1]["x"] - w.cells["p"][0]["x"]), 160)
        self.assertTrue(all(c["mergeRemaining"] > 7.9 for c in w.cells["p"]))
        center = sum(c["x"] for c in w.cells["p"]) / 2
        for seq in range(60, 90):
            w.set_input("p", {"seq": seq, "x": 1, "y": 0, "regroup": False, "target": {"x": 3000, "y": 550}})
            w.update(1 / 30)
        self.assertGreater(sum(c["x"] for c in w.cells["p"]) / 2, center + 80)

    def test_regroup_strict_boolean_stale_input_and_stop(self):
        w = match()
        for seq, value in enumerate(["true", 1, {}, None, True]):
            w.set_input("p", {"seq": seq, "regroup": value})
            self.assertIs(w.players["p"]["input"]["regroup"], value is True)
        for _ in range(32):
            w.update(1 / 30)
        self.assertFalse(w.players["p"]["input"]["regroup"])
        w.set_input("p", {"seq": 8, "regroup": True})
        w.stop_input(w.players["p"])
        self.assertFalse(w.players["p"]["input"]["regroup"])

    def test_split_count_is_per_tick_not_per_child(self):
        w = match()
        grow(w.cells["p"][0], 540)
        for seq in range(3):
            w.set_input("p", {"seq": seq * 2, "x": 1, "y": 0, "split": True})
            w.update(1 / 30)
            w.set_input("p", {"seq": seq * 2 + 1, "split": False})
            w.players["p"]["splitCooldown"] = 0
        self.assertEqual(len(w.cells["p"]), 8)
        self.assertEqual(w.players["p"]["stats"].values["splits"], 3)
        self.assertEqual(w.players["p"]["stats"].values["maxCells"], 8)

    def test_feed_and_launch_credit_spore_owner(self):
        w = match()
        w.spikes = [{"id": "fixed", "x": 1000, "y": 1000, "radius": 58, "charge": 4, "color": "#fff"}]
        w.spores = [{"id": "s", "ownerId": "p", "x": 990, "y": 1000, "vx": 100, "vy": 0,
                     "radius": 6, "mass": 8, "life": 5, "alive": True, "color": "#fff"}]
        w.update(1 / 30)
        self.assertEqual(w.players["p"]["stats"].values["spikesFed"], 1)
        self.assertEqual(w.players["p"]["stats"].values["spikesLaunched"], 1)
        self.assertEqual(w.players["q"]["stats"].values["spikesFed"], 0)

    def test_stats_ignore_client_values_and_snapshot_is_detached(self):
        w = match()
        w.set_input("p", {"seq": 0, "stats": {"cellsEaten": 10000, "peakMass": 99999}})
        w.update(1 / 30)
        snap = w.snapshot()
        owner = next(p for p in snap["players"] if p["ownerId"] == "p")
        self.assertEqual(owner["stats"]["cellsEaten"], 0)
        owner["stats"]["peakMass"] = 999
        self.assertEqual(w.players["p"]["stats"].values["peakMass"], 36)

    def test_respawn_keeps_stats_and_last_cell_loss_is_counted_once(self):
        w = match()
        attacker, prey = w.cells["q"][0], w.cells["p"][0]
        grow(attacker, 300 - attacker["mass"])
        attacker.update(x=prey["x"], y=prey["y"])
        w.players["p"]["stats"].record({"type": "food"}, 0)
        w.update(1 / 30)
        self.assertEqual(w.players["p"]["lives"], 2)
        self.assertEqual(w.cells["p"][0]["mass"], 36)
        self.assertEqual(w.players["p"]["stats"].values["foods"], 1)
        self.assertEqual(w.players["p"]["stats"].values["cellsLost"], 1)
        self.assertEqual(w.players["q"]["stats"].values["cellsEaten"], 1)
        self.assertEqual(w.players["q"]["stats"].values["peakMass"], 336)

    def test_eliminated_spectator_clock_stops_and_timeout_clamps(self):
        w = match()
        w.players["p"]["lives"] = 0
        w.cells["p"] = []
        w.elapsed = w.duration - .01
        w.update(1 / 30)
        self.assertTrue(w.finished)
        self.assertEqual(w.players["p"]["stats"].values["activeSeconds"], 0)
        self.assertAlmostEqual(w.players["q"]["stats"].values["activeSeconds"], .01)

    def test_peak_and_count_survive_empty_cells_and_are_not_shared(self):
        a, b = RoundStats(), RoundStats()
        a.observe([{"alive": True, "mass": 72}, {"alive": True, "mass": 144}])
        a.observe([])
        self.assertEqual(a.values["peakMass"], 216)
        self.assertEqual(a.values["maxCells"], 2)
        self.assertEqual(b.values["peakMass"], 36)
