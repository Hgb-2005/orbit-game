import test from 'node:test';
import assert from 'node:assert/strict';
import { Spectator } from '../static/js/network/spectator.js';
import { RemoteSession } from '../static/js/network/remote-session.js';
import { LocalSession } from '../static/js/session.js';
import { InputController } from '../static/js/input.js';
import { createBall } from '../static/js/core/entities.js';
import { abilityReason, splitProjection, FrameMetrics } from '../static/js/presentation/tactics.js';
import { isStandardRules, describeRules } from '../static/js/network/room-rules.js';

const bounds = { width: 3200, height: 2200 };
const scene = () => {
  const cells = [createBall({ id: 'q1', ownerId: 'q', x: 900, y: 600, mass: 36 }),
    createBall({ id: 'r1', ownerId: 'r', x: 1800, y: 1100, mass: 100 }),
    createBall({ id: 'r2', ownerId: 'r', x: 2100, y: 1100, mass: 36 })];
  const standings = [{ ownerId: 'p', name: '我', team: 0, lives: 0, cells: 0, mass: 0, rank: 3, eliminated: true },
    { ownerId: 'q', name: '领先对手', team: 1, lives: 4, cells: 1, mass: 36, rank: 1 },
    { ownerId: 'r', name: '队友', team: 0, lives: 3, cells: 2, mass: 136, rank: 2 }];
  return { cells, standings };
};

test('观战优先同队，镜头包含目标的整个球群，切换不改变任何球体', () => {
  const { cells, standings } = scene(), before = structuredClone(cells), spectator = new Spectator();
  const target = spectator.target(cells, standings, 0, bounds);
  assert.equal(spectator.ownerId, 'r'); assert.equal(target.mass, 136);
  assert.ok(target.viewRadius > 200);
  spectator.cycle(1, cells, standings, 0, bounds); assert.equal(spectator.ownerId, 'q');
  assert.deepEqual(cells, before);
});
test('观战目标出局后自动换人，无人存活时安全回退', () => {
  const { cells, standings } = scene(), spectator = new Spectator();
  spectator.target(cells, standings, 0, bounds);
  standings[2].lives = 0;
  spectator.target(cells, standings, 0, bounds); assert.equal(spectator.ownerId, 'q');
  standings[1].lives = 0;
  const target = spectator.target([], standings, 0, bounds);
  assert.equal(target.x, 1600); assert.equal(target.y, 1100);
});
test('自由镜头保留切换位置，鼠标悬停不漂移，键盘与摇杆移动限制在地图内', () => {
  const { cells, standings } = scene(), spectator = new Spectator();
  const target = spectator.target(cells, standings, 0, bounds);
  spectator.select('free', cells, standings, 0, bounds);
  spectator.pan({ x: 1, y: 1 }, .1, bounds);
  assert.equal(spectator.free.x, target.x);
  spectator.pan({ panX: 1, panY: 0 }, .1, bounds);
  assert.equal(spectator.free.x, target.x + 75);
  spectator.pan({ panX: 1, panY: 1 }, 100, bounds);
  assert.deepEqual(spectator.free, { x: 3200, y: 2200 });
  spectator.reset(); assert.equal(spectator.mode, 'follow'); assert.equal(spectator.free, null);
});
function remoteScene() {
  const { cells, standings } = scene();
  const remote = new RemoteSession(new LocalSession().getSnapshot());
  remote.playerId = 'p'; remote.roundId = 'r1'; remote.state = 'playing';
  remote.room = { roundId: 'r1', rules: { mode: 'teams' } };
  remote.raw = { tick: 1, elapsed: 10, duration: 180, bounds, cells, standings, rules: { mode: 'teams' },
    players: standings.map(entry => ({ ...entry, score: 0, peakMass: 36, eatenBalls: 0, killer: '', split: {}, spore: {} })),
    teams: [{ id: 0, rank: 2 }, { id: 1, rank: 1 }], events: [], protectionByOwner: {},
    hotspots: { zones: [], remaining: 45 }, pings: [], finished: false };
  remote.checkConnection = () => {};
  return remote;
}
test('出局玩家只移动观战镜头，不能把分裂和移动指令发给角色', () => {
  const remote = remoteScene(), sent = [];
  remote.send = value => { sent.push(value); return true; };
  remote.getSnapshot(); remote.selectSpectator('free');
  const before = remote.getSnapshot().cameraTarget.x;
  remote.step(.1, { panX: 1, x: 1, y: 0, split: true, spore: true });
  assert.ok(remote.getSnapshot().cameraTarget.x > before);
  assert.deepEqual(sent, []); assert.equal(remote.raw.players[0].score, 0);
});
test('队友标点使用当前回合且断线时不发送，过期标点不显示', () => {
  const remote = remoteScene(), sent = [];
  remote.send = value => { sent.push(value); return true; };
  assert.equal(remote.ping('gather', { x: 1, y: 2 }), false);
  remote.connection = 'connected'; remote.ping('help', { x: 50, y: 100 });
  assert.deepEqual(sent[0], { type: 'team_ping', roundId: 'r1', kind: 'help', x: 50, y: 100 });
  remote.raw.pings = [{ id: 1, expiresAt: 10 }, { id: 2, expiresAt: 11 }];
  assert.deepEqual(remote.getSnapshot().pings.map(item => item.id), [2]);
});

function previewScene() {
  const player = createBall({ id: 'p', ownerId: 'p', x: 1000, y: 1000, mass: 144 });
  return { state: 'playing', player, playerCells: [player], bounds,
    split: { ready: true, affordable: true, count: 1, maxCells: 8, cooldown: 0 },
    spore: { ready: true, affordable: true, count: 0, maxCount: 80, cooldown: 0 } };
}
test('分裂预览读取真实半质量和瞄准方向，不修改质量、分身或冷却', () => {
  const snapshot = previewScene(), before = structuredClone(snapshot);
  const preview = splitProjection(snapshot, { x: -1, y: 0, target: { x: 2000, y: 1000 } });
  assert.equal(preview.length, 1); assert.equal(preview[0].mass, 72);
  assert.ok(preview[0].x > snapshot.player.x); assert.equal(preview[0].y, 1000);
  assert.deepEqual(snapshot, before);
});
test('预览遵守八球预算、冷却、观战与边界，不把总质量当成单球质量', () => {
  const snapshot = previewScene(); snapshot.player.x = 3190;
  assert.ok(splitProjection(snapshot, { x: 1, y: 0 })[0].x <= 3200 - Math.sqrt(72) * 3);
  snapshot.playerCells = Array.from({ length: 8 }, () => ({ ...snapshot.player }));
  assert.deepEqual(splitProjection(snapshot, { x: 1, y: 0 }), []);
  snapshot.playerCells = [{ ...snapshot.player, mass: 40 }, { ...snapshot.player, mass: 40 }];
  assert.deepEqual(splitProjection(snapshot, { x: 1, y: 0 }), []);
  snapshot.playerCells = [snapshot.player]; snapshot.spectating = true;
  assert.deepEqual(splitProjection(snapshot, { x: 1, y: 0 }), []);
  snapshot.spectating = false; snapshot.split.ready = false;
  assert.deepEqual(splitProjection(snapshot, { x: 1, y: 0 }), []);
});
test('技能原因区分单球不足、冷却、分身上限和孢子上限', () => {
  const snapshot = previewScene(); assert.equal(abilityReason(snapshot, 'split'), '');
  snapshot.split.affordable = false; assert.match(abilityReason(snapshot, 'split'), /72 m/);
  snapshot.split.count = 8; assert.match(abilityReason(snapshot, 'split'), /分身已满/);
  snapshot.spore.cooldown = .4; assert.match(abilityReason(snapshot, 'spore'), /0.4 秒/);
  snapshot.spore.count = 80; assert.match(abilityReason(snapshot, 'spore'), /孢子已满/);
  snapshot.state = 'paused'; assert.match(abilityReason(snapshot, 'spore'), /继续游戏/);
});
test('性能统计使用实际样本并限制窗口，暂停和后台长帧不污染统计', () => {
  const metrics = new FrameMetrics(); assert.equal(metrics.snapshot(), null);
  for (let i = 0; i < 130; i++) metrics.observe(20, i % 10, true);
  const summary = metrics.snapshot();
  assert.equal(summary.samples, 120); assert.equal(summary.fps, 50); assert.equal(summary.drawP95, 9);
  metrics.observe(1000, 1000, true); metrics.observe(10, 100, false); metrics.observe(NaN, 0, true);
  assert.deepEqual(metrics.snapshot(), summary);
});
test('缩圈玩法独立记录且界面准确描述预告与扣命规则', () => {
  assert.equal(isStandardRules({ mode: 'shrink' }), false);
  assert.match(describeRules({ mode: 'shrink', duration: 180 }), /缩圈乱斗 · 3 分钟/);
  assert.match(describeRules({ mode: 'shrink' }), /单独记录/);
  assert.match(describeRules({ mode: 'shrink' }), /8 秒扣一命/);
});
test('读取瞄准不会吞掉技能脉冲，标点点击不会同时吐孢子', () => {
  const original = globalThis.window, events = {};
  globalThis.window = { addEventListener() {} };
  try {
    const canvas = { addEventListener: (type, handler) => { events[type] = handler; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      focus() {}, setPointerCapture() {} };
    const input = new InputController(canvas);
    input.requestSplit(); input.getAim({ x: 0, y: 0 }, null);
    assert.equal(input.getInput({ x: 0, y: 0 }).split, true);
    input.onArenaPointer = () => true;
    events.pointerdown({ button: 0, pointerType: 'mouse', preventDefault() {} });
    const state = input.getInput({ x: 0, y: 0 });
    assert.equal(state.spore, false); assert.equal(state.sporeHeld, false);
  } finally { globalThis.window = original; }
});
