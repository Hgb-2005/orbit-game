"""预测协议与手动选队；全部使用内存世界，不改正式数据库。"""
import json
import random
import unittest

from server.game.entities import grow
from server.game.rules import RoomRules
from server.game.world import MultiplayerWorld
from server.multiplayer import RoomManager


class PredictionProtocolTests(unittest.TestCase):
    def setUp(self):
        self.world = MultiplayerWorld([{'id': 'p', 'name': '我'}, {'id': 'q', 'name': '朋友'}], random.Random(16))
        self.world.foods = []; self.world.spikes = []; self.world.food_timer = -1e6

    def test_received_input_is_not_acknowledged_until_simulated(self):
        w = self.world
        w.set_input('p', dict(seq=0, x=1, y=0))
        self.assertEqual(w.players['p']['lastSeq'], 0)
        self.assertEqual(w.snapshot()['players'][0]['ack'], -1)
        w.update(1 / 30)
        self.assertEqual(w.snapshot()['players'][0]['ack'], 0)
        self.assertGreater(w.cells['p'][0]['x'], 800)
        w.set_input('p', dict(seq=5, x=0, y=1))
        self.assertEqual(w.snapshot()['players'][0]['ack'], 0)
        w.update(1 / 30)
        self.assertEqual(w.snapshot()['players'][0]['ack'], 5)

    def test_motion_components_are_independent_copies_and_add_up_to_public_velocity(self):
        w = self.world; cell = w.cells['p'][0]
        cell.update(vx=80, vy=-20, impulseX=620, impulseY=30)
        snap = w.snapshot(); motion = snap['cells'][0]['motion']
        self.assertEqual(snap['cells'][0]['vx'], motion['vx'] + motion['impulseX'])
        self.assertEqual(snap['cells'][0]['vy'], motion['vy'] + motion['impulseY'])
        motion['impulseX'] = -1
        self.assertEqual(cell['impulseX'], 620)
        json.dumps(snap, allow_nan=False)

    def test_split_is_authoritative_and_duplicate_input_is_not_repeated(self):
        w = self.world; grow(w.cells['p'][0], 108)
        w.set_input('p', dict(seq=0, x=1, y=0, split=True, mass=99999, lives=99))
        self.assertEqual(len(w.cells['p']), 1); self.assertEqual(w.snapshot()['players'][0]['ack'], -1)
        w.update(1 / 30)
        self.assertEqual(len(w.cells['p']), 2); self.assertEqual(sum(c['mass'] for c in w.cells['p']), 144)
        w.set_input('p', dict(seq=0, x=1, y=0, split=True)); w.update(1 / 30)
        self.assertEqual(len(w.cells['p']), 2); self.assertEqual(w.players['p']['lives'], 3)


class TeamSelectionTests(unittest.TestCase):
    def setUp(self):
        self.m = RoomManager(); self.addCleanup(self.m.close)
        self.ids = [self.m.connect() for _ in range(4)]
        self.m.command(self.ids[0], dict(type='create', name='甲', rules={'mode': 'teams'}))
        self.room = next(iter(self.m.rooms.values()))

    def join(self, count):
        for index in range(1, count):
            self.m.command(self.ids[index], dict(type='join', name='乙丙丁'[index - 1], code=self.room.code))

    def choose(self, index, team):
        self.m.command(self.ids[index], dict(type='choose_team', team=team))

    def ready(self):
        for pid in self.room.members:
            self.m.command(pid, dict(type='ready', ready=True))

    def test_new_members_balance_but_manual_teammates_stay_together(self):
        self.join(2); self.choose(1, 0)
        self.assertEqual([self.m.peers[p].team for p in self.room.members], [0, 0])
        self.m.command(self.ids[2], dict(type='join', name='丙', code=self.room.code))
        self.m.command(self.ids[3], dict(type='join', name='丁', code=self.room.code))
        self.assertEqual([m['team'] for m in self.m.room_snapshot(self.room)['members']], [0, 0, 1, 1])

    def test_switch_clears_all_readiness_but_same_team_does_not(self):
        self.join(2); self.ready(); self.choose(0, 0)
        self.assertTrue(all(self.m.peers[p].ready for p in self.room.members))
        self.choose(1, 0)
        self.assertFalse(any(self.m.peers[p].ready for p in self.room.members))

    def test_full_invalid_and_nonwaiting_requests_leave_teams_and_readiness_intact(self):
        self.join(4); self.ready()
        before = [self.m.peers[p].team for p in self.room.members]
        for bad in [True, False, -1, 2, '0', 0.0, None, [], {}]:
            self.choose(0, bad)
        self.choose(0, 1)
        self.assertEqual([self.m.peers[p].team for p in self.room.members], before)
        self.assertTrue(all(self.m.peers[p].ready for p in self.room.members))
        self.assertTrue(any(message.get('type') == 'error' for message in self.m.peers[self.ids[0]].messages))
        self.m.command(self.ids[0], dict(type='start')); self.choose(0, 1)
        self.assertEqual([self.m.peers[p].team for p in self.room.members], before)

    def test_one_to_four_humans_always_start_two_per_team_with_matching_bot_slots(self):
        for count in (1, 2, 3, 4):
            with self.subTest(count=count):
                m = RoomManager()
                try:
                    ids = [m.connect() for _ in range(count)]
                    m.command(ids[0], dict(type='create', name='0', rules={'mode': 'teams'})); room = next(iter(m.rooms.values()))
                    for index in range(1, count):
                        m.command(ids[index], dict(type='join', name=str(index), code=room.code))
                    if count >= 2 and count < 4:
                        m.command(ids[1], dict(type='choose_team', team=0))
                    chosen = {pid: m.peers[pid].team for pid in ids}
                    for pid in ids: m.command(pid, dict(type='ready', ready=True))
                    m.command(ids[0], dict(type='start'))
                    self.assertEqual(room.state, 'playing')
                    self.assertEqual([sum(p['team'] == team for p in room.world.players.values()) for team in (0, 1)], [2, 2])
                    self.assertEqual(len(room.world.bot_ids), 4 - count)
                    for pid, team in chosen.items():
                        self.assertEqual(room.world.players[pid]['team'], team)
                    self.assertEqual(len({(c['x'], c['y']) for c in room.world.all_cells()}), 4)
                finally: m.close()

    def test_rematch_resume_and_host_transfer_keep_choices(self):
        self.join(3); self.choose(2, 1); self.choose(1, 0)
        self.ready(); self.m.command(self.ids[0], dict(type='start'))
        self.room.world.finish('timeout'); self.m.advance(1 / 30)
        self.m.command(self.ids[0], dict(type='rematch'))
        self.assertEqual(self.room.state, 'waiting')
        self.assertEqual([self.m.peers[p].team for p in self.room.members], [0, 0, 1])
        old = self.m.peers[self.ids[1]]; self.m.socket_closed(old.id)
        temporary = self.m.connect(); restored = self.m.command(temporary, dict(type='resume', token=old.resume_token))
        self.assertEqual(restored, old.id); self.assertEqual(self.m.peers[restored].team, 0)
        self.m.leave(self.ids[0]); self.assertEqual(self.room.host, self.ids[1])
        self.assertEqual([self.m.peers[p].team for p in self.room.members], [0, 1])

    def test_mode_switch_assigns_and_clears_teams_and_survival_rejects_selection(self):
        self.join(3); self.choose(1, 0)
        self.m.command(self.ids[0], dict(type='configure', rules={'mode': 'survival'}))
        self.assertTrue(all(self.m.peers[p].team is None for p in self.room.members))
        self.choose(1, 0); self.assertIsNone(self.m.peers[self.ids[1]].team)
        self.m.command(self.ids[0], dict(type='configure', rules={'mode': 'teams'}))
        self.assertEqual([self.m.peers[p].team for p in self.room.members], [0, 1, 0])

    def test_selected_team_drives_collision_and_ping_visibility_even_for_adjacent_members(self):
        self.join(3); self.choose(2, 1); self.choose(1, 0); self.ready()
        self.m.command(self.ids[0], dict(type='start')); w = self.room.world
        a, b, enemy = self.ids[:3]
        w.elapsed = 4
        for owner in w.players.values(): owner['protectedUntil'] = 0
        eater, ally = w.cells[a][0], w.cells[b][0]; grow(eater, 300)
        ally.update(x=eater['x'], y=eater['y']); w.consume_balls()
        self.assertEqual(w.players[b]['lives'], 3); self.assertEqual(w.players[a]['kills'], 0)
        w.signals.send(w, a, dict(kind='help', x=1000, y=900)); self.m.broadcast_state(self.room)
        def pings(pid):
            states = [json.loads(message) for message in self.m.drain(pid) if isinstance(message, str)]
            return next(m['world']['pings'] for m in states if m['type'] == 'state')
        self.assertEqual(len(pings(b)), 1); self.assertEqual(pings(enemy), [])

    def test_explicit_teams_override_index_but_legacy_worlds_keep_alternating_teams(self):
        members = [dict(id=str(i), name=str(i)) for i in range(4)]
        legacy = MultiplayerWorld(members, random.Random(16), RoomRules(mode='teams'))
        self.assertEqual([p['team'] for p in legacy.players.values()], [0, 1, 0, 1])
        selected = MultiplayerWorld([{**m, 'team': 0 if i < 2 else 1} for i, m in enumerate(members)], random.Random(16), RoomRules(mode='teams'))
        self.assertEqual([p['team'] for p in selected.players.values()], [0, 0, 1, 1])

    def test_only_local_player_receives_independent_motion_components(self):
        self.join(2); self.ready(); self.m.command(self.ids[0], dict(type='start'))
        for pid in self.ids[:2]:
            states = [json.loads(message) for message in self.m.drain(pid) if isinstance(message, str)]
            state = next(message['world'] for message in states if message['type'] == 'state')
            for cell in state['cells']:
                self.assertEqual('motion' in cell, cell['ownerId'] == pid)


if __name__ == '__main__':
    unittest.main()
