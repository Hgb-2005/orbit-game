"""协作人机、复盘与最近二十局；使用临时库，不写正式最高分。"""
import json
import math
import random
import tempfile
import unittest
from pathlib import Path

from server import create_app
from server.database import get_db, save_record, read_record, save_match_history, read_match_history
from server.game.ai import decide
from server.game.entities import grow
from server.game.rules import RoomRules
from server.game.stats import RoundStats
from server.game.world import MultiplayerWorld
from server.history import network_history
from server.multiplayer import RoomManager


def team_world():
    w = MultiplayerWorld([{'id': 'b', 'name': '队友人机', 'isBot': True}, {'id': 'e', 'name': '敌人'},
                          {'id': 'p', 'name': '我'}, {'id': 'f', 'name': '敌二'}], random.Random(15), RoomRules(mode='teams'))
    w.elapsed = 4; w.foods = []; w.spikes = []
    w.food_timer = -1e6
    for owner in w.players.values():
        owner['protectedUntil'] = 0
    for pid, x, y in [('b', 800, 1000), ('p', 1300, 1000), ('e', 2800, 1800), ('f', 2800, 400)]:
        w.cells[pid][0].update(x=x, y=y)
    return w


class TeamplayTests(unittest.TestCase):
    def test_gather_help_and_danger_are_friendly_and_expire(self):
        for kind, action, sign in [('gather', 'gather', 1), ('help', 'support', 1), ('danger', 'avoid', -1)]:
            w = team_world(); w.signals.send(w, 'p', dict(kind=kind, x=1000, y=1000))
            plan = decide(w.players['b'], w.cells['b'], w)
            self.assertEqual(plan['teamAction'], action)
            self.assertGreater(plan['x'] * sign, 0); self.assertFalse(plan['split'])
            w.elapsed += 7
            self.assertNotIn('teamAction', decide(w.players['b'], w.cells['b'], w))

    def test_enemy_ping_and_dead_sender_cannot_command_bot(self):
        w = team_world(); w.signals.send(w, 'e', dict(kind='help', x=1000, y=1000))
        self.assertNotIn('teamAction', decide(w.players['b'], w.cells['b'], w))
        w.signals.send(w, 'p', dict(kind='gather', x=1000, y=1000)); w.players['p']['lives'] = 0
        self.assertNotIn('teamAction', decide(w.players['b'], w.cells['b'], w))

    def test_immediate_threat_overrides_command_and_unsafe_support_is_skipped(self):
        w = team_world(); w.cells['e'][0].update(x=900, y=1000); grow(w.cells['e'][0], 300)
        w.signals.send(w, 'p', dict(kind='help', x=1000, y=1000))
        plan = decide(w.players['b'], w.cells['b'], w)
        self.assertLess(plan['x'], 0); self.assertFalse(plan.get('spore')); self.assertFalse(plan['split'])
        w.cells['e'][0]['x'] = 1350
        self.assertNotEqual(decide(w.players['b'], w.cells['b'], w).get('teamAction'), 'support')

    def test_flee_can_approach_a_stronger_ally_in_safe_direction(self):
        w = team_world(); w.cells['e'][0].update(x=700, y=1000); grow(w.cells['e'][0], 64)
        grow(w.cells['p'][0], 264)
        plan = decide(w.players['b'], w.cells['b'], w)
        self.assertEqual(plan['teamAction'], 'retreat'); self.assertGreater(plan['x'], 0)

    def test_feeding_uses_real_spore_budget_and_has_two_second_rest(self):
        w = team_world(); grow(w.cells['b'][0], 164); w.cells['p'][0]['x'] = 1010
        owner = w.players['b']; mass = w.cells['b'][0]['mass']
        w.update_bot_input(owner, w.cells['b'], .01); w.update_controls(owner, w.cells['b'], .01)
        self.assertEqual(owner['teamAction'], 'feed'); self.assertEqual(len(w.spores), 1)
        self.assertEqual(w.cells['b'][0]['mass'], mass - 8); self.assertEqual(owner['stats'].values['sporesEmitted'], 1)
        w.elapsed += 1; owner['botThinkRemaining'] = 0; owner['sporeCooldown'] = 0
        w.update_bot_input(owner, w.cells['b'], .01)
        self.assertFalse(owner['queuedSpore'])

    def test_feeding_stops_at_low_mass_or_near_enemies_and_no_teleport(self):
        w = team_world(); w.cells['p'][0]['x'] = 1010
        before = dict(w.cells['b'][0]); plan = decide(w.players['b'], w.cells['b'], w)
        self.assertFalse(plan.get('spore')); self.assertEqual(before, w.cells['b'][0])
        grow(w.cells['b'][0], 164); w.cells['e'][0].update(x=1400, y=1000)
        self.assertFalse(decide(w.players['b'], w.cells['b'], w).get('spore'))

    def test_gather_arrival_stops_instead_of_orbiting_marker(self):
        w = team_world(); w.signals.send(w, 'p', dict(kind='gather', x=840, y=1000))
        plan = decide(w.players['b'], w.cells['b'], w)
        self.assertEqual((plan['x'], plan['y']), (0, 0))

    def test_spike_blocks_feed_even_when_beyond_movement_lookahead(self):
        w = team_world(); grow(w.cells['b'][0], 164); w.cells['p'][0]['x'] = 1100
        w.spikes = [dict(x=1020, y=1000, radius=58)]
        self.assertFalse(decide(w.players['b'], w.cells['b'], w).get('spore'))


class TelemetryTests(unittest.TestCase):
    def test_sampling_is_bounded_copies_snapshots_and_not_in_live_packets(self):
        stats = RoundStats()
        for i in range(1000):
            stats.sample(i, [{'mass': 36 + i, 'alive': True}], True)
        for i in range(50): stats.death(1000 + i, 'eaten', '敌人', 36)
        self.assertLessEqual(len(stats.timeline), 121); self.assertEqual(len(stats.death_log), 40)
        self.assertEqual(stats.timeline[0][0], 0); self.assertEqual(stats.timeline[-1][0], 1049)
        copy = stats.snapshot(True); copy['massTimeline'][0][1] = -1; copy['deathLog'][0]['killer'] = '改写'
        self.assertEqual(stats.timeline[0][1], 36); self.assertEqual(stats.death_log[0]['killer'], '敌人')
        self.assertNotIn('massTimeline', stats.snapshot())

    def test_consumed_last_cell_logs_once_and_respawn_keeps_zero_and_thirty_six(self):
        w = team_world(); victim = w.cells['p'][0]; attacker = w.cells['e'][0]
        attacker.update(x=victim['x'], y=victim['y']); grow(attacker, 264); w.consume_balls()
        stats = w.players['p']['stats']
        self.assertEqual(len(stats.death_log), 1); self.assertEqual(stats.death_log[0]['killer'], '敌人')
        self.assertEqual([p[1] for p in stats.timeline[-2:]], [0, 36])
        self.assertNotIn('massTimeline', w.snapshot()['players'][0]['stats'])
        w.finish('timeout'); self.assertIn('massTimeline', w.snapshot()['players'][0]['stats'])

    def test_zone_loss_has_distinct_reason(self):
        w = MultiplayerWorld([{'id': 'p', 'name': '我'}, {'id': 'e', 'name': '敌'}], random.Random(15), RoomRules(mode='shrink'))
        w.elapsed = 150; w.players['p']['protectedUntil'] = 0; w.cells['p'][0].update(x=100, y=100)
        w.cells['e'][0].update(x=1600, y=1100); w.safe_zone.apply(w, 8)
        self.assertEqual(w.players['p']['stats'].death_log[0]['cause'], 'zone')
        self.assertEqual(w.players['p']['lives'], 2)


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.config = dict(TESTING=True, DATABASE=str(Path(self.folder.name) / 'test.sqlite3'))
        self.app = create_app(self.config); self.client = self.app.test_client()

    def tearDown(self): self.folder.cleanup()

    def payload(self, index=0):
        return dict(id=f'local-test-round-{index:04}', mode='classic', duration=10.017, score=10,
                    stats=dict(peakMass=46, cellsEaten=1, massTimeline=[[0, 36], [10.017, 0]],
                               deathLog=[dict(time=10.017, cause='eaten', killer='对手', mass=46)]))

    def test_twenty_round_retention_dedup_migration_and_old_score_unchanged(self):
        with self.app.app_context(): save_record(1980)
        for i in range(25): self.assertEqual(self.client.post('/api/history', json=self.payload(i)).status_code, 200)
        self.client.post('/api/history', json=self.payload(24))
        records = self.client.get('/api/history')
        self.assertIn('no-store', records.headers['Cache-Control']); matches = records.json['matches']
        self.assertEqual(len(matches), 20); self.assertEqual(matches[0]['id'], 'local-test-round-0024')
        self.assertEqual(matches[-1]['id'], 'local-test-round-0005')
        again = create_app(self.config).test_client()
        self.assertEqual(len(again.get('/api/history').json['matches']), 20)
        self.assertEqual(again.get('/api/high-score').json['high_score'], 1980)

    def test_reject_network_forgery_practice_bad_shapes_and_nonfinite_values(self):
        invalid = [[], None, {}, {**self.payload(), 'mode': 'teams'}, {**self.payload(), 'mode': 'practice'},
                   {**self.payload(), 'id': 'net-stolen-round'}, {**self.payload(), 'duration': True},
                   {**self.payload(), 'rank': False}, {**self.payload(), 'won': 'yes'},
                   {**self.payload(), 'stats': {'peakMass': math.nan}},
                   {**self.payload(), 'stats': {'massTimeline': [[2, 36], [1, 50]]}},
                   {**self.payload(), 'stats': {'massTimeline': [[11, 36]]}},
                   {**self.payload(), 'stats': {'deathLog': [{'cause': 'eaten', 'time': 1, 'killer': []}]}},
                   {**self.payload(), 'stats': {'massTimeline': [[0, 36]] * 122}}]
        for payload in invalid:
            with self.subTest(payload=payload):
                self.assertEqual(self.client.post('/api/history', data=json.dumps(payload), content_type='application/json').status_code, 400)
        self.assertEqual(self.client.post('/api/history', data='x').status_code, 415)
        self.assertEqual(self.client.post('/api/history', data='{', content_type='application/json').status_code, 400)
        self.assertEqual(self.client.get('/api/history').json['matches'], [])

    def test_one_network_match_keeps_all_humans_team_ranks_and_server_only_stats(self):
        w = team_world(); w.players['p']['stats'].values['foods'] = 99; w.finish('timeout')
        class Room: pass
        room = Room(); room.world = w; room.round_id = 'round15'
        match = network_history(room)
        self.assertEqual(match['mode'], 'teams'); self.assertEqual(match['source'], 'server')
        self.assertEqual(len(match['participants']), 3)
        with self.app.app_context():
            save_match_history(match); save_match_history(match)
            saved = read_match_history(); self.assertEqual(len(saved), 1)
            p = next(p for p in saved[0]['participants'] if p['name'] == '我')
            self.assertEqual(p['stats']['foods'], 99); self.assertEqual(p['rank'], 1); self.assertTrue(p['won'])

    def test_history_write_failure_retries_independently_from_high_score(self):
        attempts, scores = [], []
        def persist(match):
            attempts.append(match)
            if len(attempts) == 1: raise OSError('temporary busy')
        manager = RoomManager(save_score=scores.append, save_history=persist)
        host = manager.connect(); manager.command(host, {'type': 'create', 'name': '我'})
        manager.command(host, {'type': 'ready', 'ready': True}); manager.command(host, {'type': 'start'})
        room = next(iter(manager.rooms.values())); room.world.finish('timeout')
        with self.assertLogs('server.multiplayer', level='ERROR'):
            manager.advance(1 / 30)
        manager.advance(1 / 30); manager.advance(1 / 30)
        self.assertEqual(len(scores), 1); self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0]['id'], attempts[1]['id']); self.assertFalse(manager.pending_history)
        self.assertTrue(any(m.get('type') == 'history_saved' for m in manager.peers[host].messages))
        manager.close()

    def test_last_human_leaving_archives_abandoned_once_with_departure_reason(self):
        saved = []; manager = RoomManager(save_history=saved.append)
        host = manager.connect(); manager.command(host, {'type': 'create', 'name': '我'})
        manager.command(host, {'type': 'ready', 'ready': True}); manager.command(host, {'type': 'start'})
        manager.leave(host); manager.advance(1 / 30)
        self.assertEqual(len(saved), 1); self.assertEqual(saved[0]['reason'], 'abandoned')
        self.assertEqual(saved[0]['participants'][0]['stats']['deathLog'][-1]['cause'], 'departed')
        self.assertFalse(saved[0]['participants'][0]['won']); manager.close()

    def test_rematch_generates_another_history_id_without_duplicate_finished_round(self):
        saved = []; manager = RoomManager(save_history=saved.append)
        host = manager.connect(); manager.command(host, {'type': 'create', 'name': '我'})
        manager.command(host, {'type': 'ready', 'ready': True}); manager.command(host, {'type': 'start'})
        room = next(iter(manager.rooms.values())); room.world.finish('timeout'); manager.advance(1 / 30)
        manager.command(host, {'type': 'rematch'}); manager.command(host, {'type': 'ready', 'ready': True})
        manager.command(host, {'type': 'start'}); room.world.finish('timeout'); manager.advance(1 / 30)
        manager.leave(host); manager.advance(1 / 30)
        self.assertEqual(len(saved), 2); self.assertNotEqual(saved[0]['id'], saved[1]['id']); manager.close()
