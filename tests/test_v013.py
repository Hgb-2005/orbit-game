"""自定义规则、AI 决策和独立成绩，使用临时数据库和确定性内存场景。"""
import random
import tempfile
import unittest
from pathlib import Path

from server import create_app
from server.database import save_record, read_record, save_custom_record, get_db
from server.game.ai import decide, avoid_spikes, PROFILES
from server.game.entities import ball, grow
from server.game.rules import RoomRules
from server.game.world import MultiplayerWorld
from server.multiplayer import RoomManager


def match(difficulty="standard"):
    world = MultiplayerWorld([{"id": "bot", "name": "人机", "isBot": True}, {"id": "p", "name": "玩家"}],
                             random.Random(42), RoomRules(botDifficulty=difficulty))
    world.elapsed = 4
    world.foods, world.spikes = [], []
    world.food_timer = -10000
    bot, prey = world.cells["bot"][0], world.cells["p"][0]
    bot.update(x=800, y=550)
    prey.update(x=950, y=550)
    grow(bot, 300 - bot["mass"])
    return world


class CustomRulesTests(unittest.TestCase):
    def test_defaults_keep_standard_scoring_and_invalid_fields_are_rejected(self):
        self.assertTrue(RoomRules.parse().ranked)
        self.assertTrue(RoomRules.parse({"mode": "teams", "duration": 180}).ranked)
        for bad in ({"botCount": True}, {"botCount": 4}, {"botCount": 1.0}, {"initialMass": True},
                    {"initialMass": 9999}, {"foodDensity": []}, {"botDifficulty": {}},
                    {"mode": "teams", "botCount": 0}, {"speed": 99}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                RoomRules.parse(bad)

    def test_custom_start_mass_food_count_and_respawn_contract(self):
        rules = RoomRules.parse({"initialMass": 144, "foodDensity": "rich", "botDifficulty": "challenge"})
        w = MultiplayerWorld([{"id": "p", "name": "我"}, {"id": "q", "name": "朋友"}], random.Random(7), rules)
        self.assertEqual(len(w.foods), 800)
        self.assertTrue(all(c["mass"] == 144 for c in w.all_cells()))
        self.assertEqual(w.players["p"]["stats"].values["peakMass"], 144)
        w.respawn(w.players["p"])
        self.assertEqual(w.cells["p"][0]["mass"], 36)
        w.foods = []
        w.update(.4)
        self.assertEqual(len(w.foods), 800)

    def test_bot_count_caps_four_seats_and_zero_bot_solo_cannot_start(self):
        m = RoomManager()
        try:
            host = m.connect()
            m.command(host, {"type": "create", "name": "房主", "rules": {"botCount": 0}})
            room = next(iter(m.rooms.values()))
            m.command(host, {"type": "ready", "ready": True})
            m.command(host, {"type": "start"})
            self.assertEqual(room.state, "waiting")
            self.assertTrue(any(message.get("type") == "error" for message in m.peers[host].messages))
            m.command(host, {"type": "configure", "rules": {"botCount": 1}})
            m.command(host, {"type": "ready", "ready": True})
            m.command(host, {"type": "start"})
            self.assertEqual(len(room.world.bot_ids), 1)
            self.assertEqual(len(room.world.players), 2)
            self.assertEqual(RoomRules(botCount=3).ai_count(3), 1)
            self.assertEqual(RoomRules(botCount=0).ai_count(2), 0)
        finally:
            m.close()

    def test_guest_cannot_change_rules_and_changes_reset_readiness(self):
        m = RoomManager()
        try:
            host, guest = m.connect(), m.connect()
            m.command(host, {"type": "create", "name": "甲"})
            room = next(iter(m.rooms.values()))
            m.command(guest, {"type": "join", "name": "乙", "code": room.code})
            for p in (host, guest):
                m.command(p, {"type": "ready", "ready": True})
            m.command(guest, {"type": "configure", "rules": {"initialMass": 144}})
            self.assertEqual(room.rules.initialMass, 36)
            m.command(host, {"type": "configure", "rules": {"initialMass": 144}})
            self.assertFalse(any(m.peers[p].ready for p in (host, guest)))
        finally:
            m.close()

    def test_database_migration_preserves_standard_record_and_custom_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            app = create_app({"TESTING": True, "DATABASE": str(Path(folder) / "test.sqlite3")})
            with app.app_context():
                save_record(1980)
                a, b = RoomRules(initialMass=72), RoomRules(initialMass=144)
                save_custom_record(3000, a.record_key)
                save_custom_record(1, a.record_key)
                save_custom_record(500, b.record_key)
                self.assertEqual(read_record()["high_score"], 1980)
                self.assertEqual(get_db().execute("SELECT high_score FROM custom_records WHERE rules_key=?", (a.record_key,)).fetchone()[0], 3000)
                self.assertEqual(get_db().execute("SELECT COUNT(*) FROM custom_records").fetchone()[0], 2)
            again = create_app({"TESTING": True, "DATABASE": str(Path(folder) / "test.sqlite3")})
            with again.app_context():
                self.assertEqual(read_record()["high_score"], 1980)

    def test_custom_finish_uses_separate_callback_and_retries_with_round_identity(self):
        standard, custom = [], []
        m = RoomManager(standard.append, save_custom_score=lambda score, key: custom.append((score, key)) or {"high_score": score})
        try:
            host = m.connect()
            m.command(host, {"type": "create", "name": "房主", "rules": {"initialMass": 144}})
            room = next(iter(m.rooms.values()))
            m.command(host, {"type": "ready", "ready": True})
            m.command(host, {"type": "start"})
            room.world.players[host]["score"] = 321
            room.world.finish("timeout")
            original = m.save_custom_score
            def fail(score, key):
                raise OSError("retry")
            m.save_custom_score = fail
            with self.assertLogs("server.multiplayer", level="ERROR"):
                m.advance(1 / 30)
            self.assertFalse(custom)
            m.save_custom_score = original
            m.advance(1 / 30)
            self.assertEqual(standard, [])
            self.assertEqual(custom, [(321, room.rules.record_key)])
            self.assertEqual(m.room_snapshot(room)["customRecord"]["high_score"], 321)
            events = [item for item in m.drain(host) if isinstance(item, dict) and item.get("scope") == "custom"]
            self.assertEqual(events[0]["roundId"], room.round_id)
        finally:
            m.close()

    def test_custom_score_survives_everyone_leaving_before_next_tick(self):
        saved = []
        m = RoomManager(save_custom_score=lambda score, key: saved.append(score))
        try:
            host = m.connect()
            m.command(host, {"type": "create", "name": "房主", "rules": {"foodDensity": "rich"}})
            room = next(iter(m.rooms.values()))
            m.command(host, {"type": "ready", "ready": True})
            m.command(host, {"type": "start"})
            room.world.players[host]["score"] = 78
            m.leave(host)
            m.advance(1 / 30)
            self.assertEqual(saved, [78])
        finally:
            m.close()


class TacticalBotTests(unittest.TestCase):
    def test_standard_attacks_safely_and_casual_does_not_split(self):
        for level in PROFILES:
            w = match(level)
            plan = decide(w.players["bot"], w.cells["bot"], w)
            self.assertGreater(plan["x"], 0)
            self.assertEqual(plan["split"], level != "casual")
            w.update(1 / 30)
            self.assertEqual(len(w.cells["bot"]), 1 if level == "casual" else 2)

    def test_path_spikes_cancel_split_and_cause_side_steering(self):
        w = match()
        w.spikes = [{"x": 940, "y": 550, "radius": 58}]
        bot = w.cells["bot"][0]
        plan = decide(w.players["bot"], [bot], w)
        self.assertFalse(plan["split"])
        self.assertGreater(abs(plan["y"]), .1)
        self.assertEqual(avoid_spikes({**bot, "mass": 36}, (1, 0), w.spikes), (1, 0))

    def test_small_fragment_threat_overrides_largest_fragment_chase(self):
        w = match()
        sibling = ball("small", w.players["bot"], {"x": 900, "y": 550})
        w.cells["bot"].append(sibling)
        enemy = w.cells["p"][0]
        grow(enemy, 80 - enemy["mass"])
        plan = decide(w.players["bot"], w.cells["bot"], w)
        self.assertLess(plan["x"], 0)
        self.assertFalse(plan["regroup"])
        self.assertFalse(plan["split"])

    def test_scattered_fragments_regroup_without_shortening_merge_delay(self):
        w = match()
        w.cells["p"][0].update(x=2800, y=1800)
        owner = w.players["bot"]
        sibling = ball("second", owner, {"x": 1300, "y": 550})
        grow(sibling, 300 - sibling["mass"])
        w.cells["bot"].append(sibling)
        for cell in w.cells["bot"]:
            cell["mergeRemaining"] = 10
        self.assertTrue(decide(owner, w.cells["bot"], w)["regroup"])
        w.update(1 / 30)
        self.assertEqual(len(w.cells["bot"]), 2)
        self.assertTrue(all(c["mergeRemaining"] > 9.9 for c in w.cells["bot"]))

    def test_profile_changes_strategy_not_speed_mass_or_lives(self):
        worlds = [match(level) for level in PROFILES]
        self.assertEqual(len({w.cells["bot"][0]["speed"] for w in worlds}), 1)
        self.assertEqual(len({w.cells["bot"][0]["mass"] for w in worlds}), 1)
        self.assertTrue(all(w.players["bot"]["lives"] == 3 for w in worlds))
