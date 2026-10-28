"""缩圈的生命边界与队伍标点的传输隔离，全部使用内存世界。"""
import json
import math
import random
import unittest

from server.game.ai import decide
from server.game.entities import BOUNDS, grow
from server.game.rules import RoomRules
from server.game.safe_zone import SafeZone
from server.game.world import MultiplayerWorld
from server.multiplayer import RoomManager


def world(mode='shrink'):
    w = MultiplayerWorld([{'id': 'p', 'name': '甲'}, {'id': 'q', 'name': '乙'}],
                         random.Random(14), RoomRules(mode=mode, duration=180))
    w.elapsed = 150
    w.foods, w.spikes = [], []
    for owner in w.players.values():
        owner['protectedUntil'] = 0
    w.cells['p'][0].update(x=120, y=120)
    w.cells['q'][0].update(x=1600, y=1100)
    return w


class SafeZoneTests(unittest.TestCase):
    def test_shrink_rules_use_custom_score_and_keep_old_modes_ranked(self):
        self.assertFalse(RoomRules.parse({'mode': 'shrink'}).ranked)
        self.assertTrue(RoomRules().ranked)
        self.assertTrue(RoomRules(mode='teams').ranked)
        with self.assertRaises(ValueError):
            RoomRules.parse({'mode': 'unknown'})

    def test_schedule_covers_map_and_warns_before_three_smooth_shrinks(self):
        zone = SafeZone(BOUNDS, 180)
        self.assertGreater(zone.at(0)['radius'], math.hypot(1600, 1100))
        self.assertEqual(zone.at(39.9)['phase'], 'waiting')
        self.assertEqual(zone.at(40)['phase'], 'warning')
        self.assertEqual(zone.at(45)['phase'], 'shrinking')
        self.assertAlmostEqual(zone.at(45)['radius'], zone.at(44.9)['radius'])
        radii = [zone.at(i / 2)['radius'] for i in range(361)]
        self.assertTrue(all(a >= b for a, b in zip(radii, radii[1:])))
        self.assertEqual(zone.at(150)['phase'], 'final')
        self.assertAlmostEqual(zone.at(180)['radius'], zone.initial_radius * .19)

    def test_outside_mass_loss_does_not_touch_inside_player_or_score(self):
        w = world()
        grow(w.cells['p'][0], 64)
        w.safe_zone.apply(w, 1)
        self.assertEqual(w.cells['p'][0]['mass'], 98)
        self.assertEqual(w.cells['q'][0]['mass'], 36)
        self.assertEqual(w.players['p']['score'], 0)
        self.assertEqual(w.players['p']['lives'], 3)

    def test_eight_seconds_cost_one_life_and_respawn_inside_without_kill_credit(self):
        w = world()
        original_other = dict(w.cells['q'][0])
        for _ in range(7):
            w.safe_zone.apply(w, 1)
        self.assertEqual(w.players['p']['lives'], 3)
        w.safe_zone.apply(w, 1)
        p, q = w.players['p'], w.players['q']
        self.assertEqual((p['lives'], p['deaths'], p['zoneExposure']), (2, 1, 0))
        self.assertEqual((q['lives'], q['kills'], q['score']), (3, 0, 0))
        self.assertEqual(w.cells['q'][0], original_other)
        self.assertEqual(w.cells['p'][0]['mass'], 36)
        self.assertFalse(w.safe_zone.outside(w.cells['p'][0], w.safe_zone.at(w.elapsed)))
        self.assertEqual(p['protectedUntil'], w.elapsed + 3)

    def test_any_inside_fragment_clears_exposure_and_mass_never_falls_below_twelve(self):
        w = world()
        child = {**w.cells['p'][0], 'id': 'inside', 'x': 1600, 'y': 1100}
        w.cells['p'].append(child)
        w.players['p']['zoneExposure'] = 7
        for _ in range(60):
            w.safe_zone.apply(w, 1)
        self.assertEqual(w.players['p']['zoneExposure'], 0)
        self.assertEqual(w.players['p']['lives'], 3)
        self.assertEqual(w.cells['p'][0]['mass'], 12)
        self.assertEqual(child['mass'], 36)

    def test_protection_blocks_zone_penalty_and_last_life_ends_match(self):
        w = world()
        w.players['p']['protectedUntil'] = 160
        w.safe_zone.apply(w, 10)
        self.assertEqual(w.players['p']['lives'], 3)
        w.players['p'].update(protectedUntil=0, lives=1)
        w.safe_zone.apply(w, 8)
        self.assertTrue(w.finished)
        self.assertEqual(w.reason, 'last-survivor')
        self.assertEqual(w.cells['p'], [])
        self.assertEqual(w.players['q']['lives'], 3)

    def test_many_respawns_and_new_food_remain_inside_final_circle(self):
        w = world()
        zone = w.safe_zone.at(w.elapsed)
        for _ in range(100):
            w.respawn(w.players['p'])
            self.assertFalse(w.safe_zone.outside(w.cells['p'][0], zone))
            self.assertFalse(w.safe_zone.outside(w.create_food(), zone))

    def test_bot_prioritizes_returning_to_zone_over_prey(self):
        w = world()
        grow(w.cells['p'][0], 264)
        w.cells['q'][0].update(x=50, y=120)
        plan = decide(w.players['p'], w.cells['p'], w)
        self.assertGreater(plan['x'], 0)
        self.assertGreater(plan['y'], 0)
        self.assertFalse(plan['split'])

    def test_authoritative_tick_applies_zone_penalty_and_publishes_respawn(self):
        w = world()
        w.food_timer = -10000
        w.players['p']['zoneExposure'] = 7.9
        w.update(.2)
        snapshot = w.snapshot()
        self.assertEqual(w.players['p']['lives'], 2)
        self.assertEqual(w.players['q']['lives'], 3)
        self.assertEqual(w.cells['p'][0]['mass'], 36)
        self.assertEqual(snapshot['safeZone']['phase'], 'final')
        self.assertTrue(any(event['type'] == 'zone-death' for event in snapshot['events']))
        self.assertTrue(any(event['type'] == 'respawn' for event in snapshot['events']))

    def test_survival_world_has_no_zone_and_timeout_freezes_simulation(self):
        w = world('survival')
        self.assertIsNone(w.snapshot()['safeZone'])
        w.elapsed = 179.99
        w.update(.02)
        frozen = w.snapshot()
        w.update(10)
        self.assertEqual(w.snapshot(), frozen)


class TeamSignalTests(unittest.TestCase):
    def setUp(self):
        self.manager = RoomManager()
        self.ids = [self.manager.connect() for _ in range(3)]
        self.manager.command(self.ids[0], {'type': 'create', 'name': '甲', 'rules': {'mode': 'teams'}})
        self.room = next(iter(self.manager.rooms.values()))
        for index, pid in enumerate(self.ids[1:]):
            self.manager.command(pid, {'type': 'join', 'name': ['乙', '丙'][index], 'code': self.room.code})
        for pid in self.ids:
            self.manager.command(pid, {'type': 'ready', 'ready': True})
        self.manager.command(self.ids[0], {'type': 'start'})
        for pid in self.ids:
            self.manager.drain(pid)

    def tearDown(self):
        self.manager.close()

    def command(self, **values):
        self.manager.command(self.ids[0], dict(type='team_ping', roundId=self.room.round_id, kind='gather', x=1000, y=600) | values)

    def state(self, pid):
        messages = [json.loads(m) if isinstance(m, str) else m for m in self.manager.drain(pid)]
        return next(m['world'] for m in reversed(messages) if m.get('type') == 'state')

    def test_teammates_receive_coordinates_but_enemy_receives_none(self):
        self.command()
        self.assertEqual(len(self.state(self.ids[0])['pings']), 1)
        self.assertEqual(self.state(self.ids[1])['pings'], [])
        ping = self.state(self.ids[2])['pings'][0]
        self.assertEqual((ping['x'], ping['y'], ping['kind']), (1000, 600, 'gather'))

    def test_cooldown_replaces_own_marker_and_expires_after_six_seconds(self):
        self.command()
        self.command(kind='danger')
        w = self.room.world
        self.assertEqual(w.signals.items[0]['kind'], 'gather')
        w.elapsed = 2
        self.command(kind='help', x=-10, y=99999)
        self.assertEqual(len(w.signals.items), 1)
        self.assertEqual((w.signals.items[0]['x'], w.signals.items[0]['y']), (0, 2200))
        w.elapsed = 8
        self.assertEqual(w.signals.snapshot(w.elapsed), [])

    def test_invalid_coordinates_stale_round_and_eliminated_player_cannot_ping(self):
        for values in ({'x': True}, {'x': float('nan')}, {'y': float('inf')}, {'kind': 'cheat'}, {'roundId': 'old'}):
            self.command(**values)
            self.assertEqual(self.room.world.signals.items, [])
        self.room.world.players[self.ids[0]]['lives'] = 0
        self.command()
        self.assertEqual(self.room.world.signals.items, [])

    def test_resume_preserves_ping_cooldown_and_private_view(self):
        self.command()
        pid = self.ids[0]
        token = self.manager.peers[pid].resume_token
        self.manager.socket_closed(pid)
        newcomer = self.manager.connect()
        self.assertEqual(self.manager.resume(newcomer, token), pid)
        self.assertEqual(len(self.state(pid)['pings']), 1)
        self.command(kind='danger')
        self.assertEqual(self.room.world.signals.items[0]['kind'], 'gather')

    def test_non_team_mode_cannot_send_team_signals(self):
        w = world('survival')
        with self.assertRaises(ValueError):
            w.signals.send(w, 'p', {'kind': 'gather', 'x': 100, 'y': 200})


if __name__ == '__main__':
    unittest.main()
