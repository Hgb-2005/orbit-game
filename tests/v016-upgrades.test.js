import test from 'node:test';
import assert from 'node:assert/strict';
import { MovementPrediction } from '../static/js/network/movement-prediction.js';
import { RemoteSession } from '../static/js/network/remote-session.js';
import { LocalSession } from '../static/js/session.js';
import { createBall, moveBall } from '../static/js/core/entities.js';

const controls = (x = 1, y = 0) => ({ x, y, split: false, spore: false });
function world(ack = -1) {
  const ball = createBall({ id: 'a', ownerId: 'p', x: 800, y: 550, mass: 36, color: '#abc', name: '我' });
  ball.motion = { vx: 0, vy: 0, impulseX: 0, impulseY: 0 };
  const local = new LocalSession().getSnapshot();
  return { tick: 1, elapsed: 1 / 30, duration: 300, finished: false, bounds: { width: 3200, height: 2200 }, cells: [ball],
    players: [{ ownerId: 'p', ack, score: 0, eatenBalls: 0, peakMass: 36, killer: '', split: local.split, sprint: local.sprint }],
    standings: [{ ownerId: 'p', name: '我', lives: 3, kills: 0, deaths: 0, mass: 36, rank: 1 }],
    hotspots: local.hotspots, protectionByOwner: {}, events: [] };
}
function remote() {
  let time = 1000;
  const r = new RemoteSession(new LocalSession().getSnapshot(), () => {}, undefined, () => time);
  r.playerId = 'p'; r.connection = 'connected';
  r.room = { state: 'playing', roundId: 'r', members: [] };
  r.sent = []; r.socket = { readyState: 1, bufferedAmount: 0, send: data => r.sent.push(JSON.parse(data)) };
  r.receive({ type: 'state', roundId: 'r', world: world() });
  r.advanceClock = ms => { time += ms; };
  return r;
}

test('收到新快照前，自己的移动已响应；质量、分数与生命仍来自服务器', () => {
  const r = remote(); const before = JSON.stringify(r.raw);
  r.step(1 / 60, { ...controls(), mass: 1e9, score: 99, lives: 99 });
  assert.ok(r.positions.get('a').x > 800);
  assert.equal(JSON.stringify(r.raw), before);
  assert.equal(r.getSnapshot().player.mass, 36); assert.equal(r.getSnapshot().score, 0);
  assert.equal(r.getSnapshot().survival.player.lives, 3);
  assert.equal(r.sent[0].mass, undefined); assert.equal(r.getSnapshot().network.predictionActive, true);
});

test('实际模拟确认清除旧输入，只重放未确认部分，重复确认不会累积位移', () => {
  const p = new MovementPrediction(), w = world(); p.reconcile(w, 'p');
  p.advance(1 / 60, controls(), 0); p.advance(1 / 60, controls(0, 1), 1);
  const expected = { ...w.cells[0] }; moveBall(expected, controls(), 1 / 60, w.bounds);
  const confirmed = structuredClone(w); confirmed.players[0].ack = 0;
  confirmed.cells[0] = { ...expected, motion: { vx: expected.vx, vy: expected.vy, impulseX: 0, impulseY: 0 } };
  moveBall(expected, controls(0, 1), 1 / 60, w.bounds);
  p.reconcile(confirmed, 'p');
  assert.ok(Math.abs(p.cells.get('a').x - expected.x) < 1e-9);
  assert.ok(Math.abs(p.cells.get('a').y - expected.y) < 1e-9);
  assert.equal(p.frames.length, 1); assert.equal(p.frames[0].seq, 1);
  p.reconcile(confirmed, 'p'); assert.ok(Math.abs(p.cells.get('a').y - expected.y) < 1e-9);
  confirmed.players[0].ack = 1; p.reconcile(confirmed, 'p'); assert.equal(p.frames.length, 0);
});

test('权威误差平滑校正，大距离更正直接同步，不改写快照', () => {
  const r = remote(); r.step(1 / 60, controls());
  const w = world(0); w.tick = 2; w.cells[0].x = 850;
  r.receive({ type: 'state', roundId: 'r', world: w });
  const before = r.positions.get('a').x; r.step(1 / 60, controls(0));
  assert.ok(r.positions.get('a').x > before && r.positions.get('a').x < 850);
  assert.equal(w.cells[0].x, 850);
  w.tick++; w.cells[0].x = 2200; r.receive({ type: 'state', roundId: 'r', world: w }); r.step(1 / 60, controls(0));
  assert.equal(r.positions.get('a').x, 2200);
});

test('弹射与普通速度分开积分，避免把分裂弹射计算两次', () => {
  const p = new MovementPrediction(), w = world();
  w.cells[0].vx = 700; w.cells[0].motion = { vx: 80, vy: 0, impulseX: 620, impulseY: 0 };
  const expected = { ...w.cells[0], ...w.cells[0].motion };
  p.reconcile(w, 'p'); p.advance(1 / 60, controls(), 0); moveBall(expected, controls(), 1 / 60, w.bounds);
  assert.ok(Math.abs(p.cells.get('a').x - expected.x) < 1e-9);
  assert.equal(w.cells[0].motion.impulseX, 620);
});

test('鼠标死区、摇杆强度和地图边界与普通移动一致', () => {
  const p = new MovementPrediction(), w = world(); p.reconcile(w, 'p');
  p.advance(.1, { ...controls(), target: { x: 802, y: 550 } }, 0);
  assert.equal(p.cells.get('a').x, 800);
  p.advance(.1, controls(.25), 1); const slow = p.cells.get('a').x;
  p.reset(); p.reconcile(w, 'p'); p.advance(.1, controls(1), 0); assert.ok(p.cells.get('a').x - 800 > (slow - 800) * 3.9);
  w.cells[0].x = 3182; p.reset(); p.reconcile(w, 'p'); p.advance(.1, controls(), 0);
  assert.equal(p.cells.get('a').x, 3182);
});

test('收拢与同源球避让仅改变坐标，不预先合体、删球或增重', () => {
  const p = new MovementPrediction(), w = world();
  w.cells.push({ ...structuredClone(w.cells[0]), id: 'b', x: 900 });
  p.reconcile(w, 'p'); p.advance(.1, { ...controls(), regroup: true }, 0);
  assert.ok(p.cells.get('a').x > 800 && p.cells.get('b').x < 900);
  assert.equal(p.cells.size, 2); assert.deepEqual([...p.cells.values()].map(c => c.mass), [36, 36]);
  w.cells[1].x = 801; p.reconcile(w, 'p'); p.advance(.1, controls(0), 1);
  assert.equal(p.cells.size, 2); assert.equal(w.cells[1].alive, true);
});

test('分裂、合体、被吃复活的球身份变化清理输入历史并直接对齐新球群', () => {
  const r = remote(); r.step(.05, controls());
  const w = world(0); w.tick = 2; w.cells.push({ ...structuredClone(w.cells[0]), id: 'b', x: 830 });
  r.receive({ type: 'state', roundId: 'r', world: w }); assert.equal(r.prediction.frames.length, 0);
  assert.equal(r.positions.get('a').x, 800); assert.equal(r.positions.get('b').x, 830);
  r.step(.02, controls()); w.tick++; w.cells = [w.cells[1]];
  r.receive({ type: 'state', roundId: 'r', world: w }); assert.equal(r.prediction.frames.length, 0); assert.equal(r.positions.has('a'), false);
  w.tick++; w.cells[0].id = 'new-life'; w.cells[0].x = 2500;
  r.receive({ type: 'state', roundId: 'r', world: w }); assert.equal(r.positions.get('new-life').x, 2500);
});

test('未确认队列有时间和数量上限，确认推进后才恢复预测', () => {
  const p = new MovementPrediction(), w = world(); p.reconcile(w, 'p');
  for (let i = 0; i < 1000; i++) p.advance(1 / 120, controls(), i);
  assert.equal(p.enabled, false); assert.equal(p.frames.length, 0); assert.equal(p.seconds, 0);
  p.reconcile(w, 'p'); assert.equal(p.enabled, false);
  w.players[0].ack = 10; p.reconcile(w, 'p'); assert.equal(p.enabled, true);
  p.advance(.01, controls(), 11); assert.equal(p.frames.length, 1);
});

test('快照陈旧、发送积压、停止操作与断线时清理预测，失败发送不消耗序号', () => {
  for (const action of ['stale', 'blocked', 'stop', 'disconnect']) {
    const r = remote(); r.step(.02, controls());
    if (action === 'stale') r.advanceClock(450);
    if (action === 'blocked') r.socket.bufferedAmount = 200 * 1024;
    if (action === 'stop') r.stop();
    if (action === 'disconnect') { r.scheduleReconnect = () => {}; r.recoverConnection('断开'); }
    r.step(.02, controls()); assert.equal(r.prediction.enabled, false, action); assert.equal(r.prediction.frames.length, 0, action);
    r.close();
  }
  const r = remote(); r.socket.bufferedAmount = 200 * 1024;
  r.step(.05, controls()); assert.equal(r.seq, 0);
  r.socket.bufferedAmount = 0; r.step(.05, controls()); assert.equal(r.sent[0].seq, 0);
});

test('出局、结算、返回准备室与重新开局都不保留旧预测', () => {
  const r = remote(); r.step(.02, controls());
  const w = world(0); w.tick++; w.cells = []; w.standings[0].lives = 0;
  r.receive({ type: 'state', roundId: 'r', world: w }); assert.equal(r.prediction.enabled, false);
  w.finished = true; r.receive({ type: 'state', roundId: 'r', world: w }); assert.equal(r.prediction.frames.length, 0);
  r.receive({ type: 'room', state: 'waiting', roundId: 'r', members: [] }); assert.equal(r.prediction.cells.size, 0);
  r.receive({ type: 'room', state: 'playing', roundId: 'next', members: [] });
  r.receive({ type: 'state', roundId: 'next', world: world() }); assert.equal(r.seq, 0); assert.equal(r.prediction.frames.length, 0);
});

test('旧协议兼容位置平滑，选队命令只发送目标队伍', () => {
  const r = remote(); const w = world(); delete w.cells[0].motion; w.tick++;
  r.receive({ type: 'state', roundId: 'r', world: w }); assert.equal(r.prediction.enabled, false);
  r.chooseTeam(1); assert.deepEqual(r.sent.at(-1), { type: 'choose_team', team: 1 });
});
