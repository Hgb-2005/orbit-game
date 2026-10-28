import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../static/js/camera.js';
import { RoundStats } from '../static/js/core/round-stats.js';
import { LocalSession } from '../static/js/session.js';
import { growBall } from '../static/js/core/entities.js';
import { localMatch, HistoryService } from '../static/js/services/history.js';
import { chartGeometry } from '../static/js/presentation/match-recap.js';
import { historySummary } from '../static/js/presentation/history-ui.js';

const bounds = { width: 3200, height: 2200 };
const group = (viewRadius = 18, count = 1) => ({ x: 1600, y: 1100, radius: 18, viewRadius, cellMasses: Array(count).fill(36) });

test('分裂快速拉远，合体先保持视野再缓慢拉近', () => {
  const camera = new Camera(); camera.update(group(), bounds, 900, 650, 0, true);
  camera.update(group(500, 2), bounds, 900, 650, .1);
  const far = camera.zoom;
  assert.ok(far < .7 && far > .52);
  for (let i = 0; i < 7; i++) camera.update(group(), bounds, 900, 650, .1);
  assert.ok(camera.zoom <= far);
  for (let i = 0; i < 12; i++) camera.update(group(), bounds, 900, 650, .1);
  assert.ok(camera.zoom > far && camera.zoom < 1);
});
test('镜头稳定区间阻止微小质量变化反复缩放，重置不继承旧状态', () => {
  const camera = new Camera(); camera.update(group(300), bounds, 900, 650, 0, true);
  const zoom = camera.zoom;
  for (let i = 0; i < 60; i++) camera.update(group(i % 2 ? 303 : 298), bounds, 900, 650, 1 / 60);
  assert.equal(camera.zoom, zoom);
  camera.update(group(), bounds, 390, 400, 0, true);
  assert.equal(camera.zoom, 1); assert.equal(camera.zoomHold, 0);
});
test('边界和手机镜头转换保持有限、可逆，纯显示不修改球群', () => {
  const camera = new Camera(), player = { ...group(300, 8), x: 10, y: 2190 }, before = structuredClone(player);
  camera.update(player, bounds, 390, 500, 0, true);
  const screen = camera.worldToScreen(player), view = camera.getView();
  assert.ok(screen.x >= 0 && screen.x <= 390 && screen.y >= 0 && screen.y <= 500);
  assert.ok(Math.abs(view.left + screen.x / camera.zoom - player.x) < 1e-8);
  assert.deepEqual(player, before);
});
test('长局采样数量有界，保留首尾，复盘快照与原始日志隔离', () => {
  const stats = new RoundStats();
  for (let i = 0; i < 10000; i++) stats.sample(i, [{ alive: true, mass: 36 + i }], true);
  for (let i = 0; i < 50; i++) stats.death(10000 + i, 'eaten', '敌人', 36);
  const recap = stats.snapshot(true);
  assert.ok(recap.massTimeline.length <= 121); assert.equal(recap.massTimeline[0][0], 0);
  assert.equal(recap.massTimeline.at(-1)[0], 10049); assert.equal(recap.deathLog.length, 40);
  recap.massTimeline[0][1] = -1; recap.deathLog[0].killer = '改写';
  assert.equal(stats.timeline[0][1], 36); assert.equal(stats.deathLog[0].killer, '敌人');
  assert.equal(stats.snapshot().massTimeline, undefined);
});
test('被吃复活只记一次损失，曲线保留归零与 36 m 复活', () => {
  const session = new LocalSession(); session.start(undefined, 'survival');
  const w = session.world; w.elapsed = 5; w.foods = []; w.spikes = []; w.bots = [w.bots[0]];
  const enemy = w.bots[0]; growBall(enemy, 300 - enemy.mass);
  Object.assign(enemy, { x: w.player.x, y: w.player.y, thinkTimer: Infinity });
  session.step(1 / 60, { x: 0, y: 0 });
  assert.equal(w.stats.deathLog.length, 1); assert.equal(w.stats.deathLog[0].cause, 'eaten');
  assert.deepEqual(w.stats.timeline.slice(-2).map(p => p[1]), [0, 36]);
  const oldId = session.roundId; session.start(); assert.notEqual(session.roundId, oldId);
  assert.equal(session.world.stats.deathLog.length, 0);
});
test('只有完成的单机局可归档，时间精度与采样一致', () => {
  const session = new LocalSession(); session.start(); session.world.elapsed = 1 / 60;
  let snapshot = session.getSnapshot(); assert.equal(localMatch(snapshot, session.roundId), null);
  session.state = 'gameover'; snapshot = session.getSnapshot();
  assert.equal(localMatch(snapshot, session.roundId).duration, .017);
  assert.equal(localMatch({ ...snapshot, mode: 'practice' }, session.roundId), null);
  assert.equal(localMatch({ ...snapshot, network: {} }, session.roundId), null);
});
test('质量曲线按相对时间绘制并保留同刻归零/复活的竖线', () => {
  const chart = chartGeometry([[0, 36], [10, 72], [10, 0], [10, 36], [20, 100]]);
  assert.equal(chart.duration, 20); assert.equal(chart.peak, 100);
  assert.match(chart.path, /L160.00,98.00 L160.00,71.36/);
  assert.ok(!chartGeometry([]).path.includes('NaN'));
});
test('历史摘要按模式分别计算，包含所有真人但一场只计一局', () => {
  const p = (peakMass, cellsEaten) => ({ stats: { peakMass, cellsEaten } });
  const matches = [{ mode: 'teams', participants: [p(200, 2), p(100, 3)] }, { mode: 'classic', participants: [p(900, 1)] }];
  assert.deepEqual(historySummary(matches, 'teams'), { rounds: 1, peak: 200, eaten: 5 });
  assert.deepEqual(historySummary(matches), { rounds: 2, peak: 900, eaten: 6 });
});
test('同一单机结算只提交一次；失败保留队列，恢复后重试并读取历史', async () => {
  const originalFetch = globalThis.fetch, calls = []; let offline = true;
  globalThis.fetch = async (url, options) => {
    if (offline) throw new Error('offline');
    calls.push(options.method ?? 'GET');
    return { ok: true, json: async () => options.method === 'POST' ? { saved: true, id: JSON.parse(options.body).id } : { matches: [] } };
  };
  try {
    const service = new HistoryService(); service.pending = [];
    const snapshot = { state: 'gameover', mode: 'classic', elapsed: 10, stats: {}, score: 5 };
    service.capture(snapshot, 'local-round-123'); await service.inFlight;
    service.capture(snapshot, 'local-round-123'); await service.inFlight;
    assert.equal(service.pending.length, 1); assert.equal(service.status, 'offline');
    offline = false; await service.flush();
    assert.deepEqual(calls, ['POST', 'GET']); assert.equal(service.pending.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('较早的历史响应晚到时不会覆盖已经读取的新归档', async () => {
  const service = new HistoryService(), pending = [];
  service.request = () => new Promise(resolve => pending.push(resolve));
  const older = service.load(), newer = service.load();
  pending[1]({ matches: [{ id: 'new' }] }); await newer;
  pending[0]({ matches: [{ id: 'old' }] }); await older;
  assert.deepEqual(service.matches, [{ id: 'new' }]);
});
