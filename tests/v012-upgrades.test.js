import test from "node:test";
import assert from "node:assert/strict";
import { LocalSession, isRankedRound } from "../static/js/session.js";
import { World } from "../static/js/core/world.js";
import { createBall, growBall } from "../static/js/core/entities.js";
import { RoundStats } from "../static/js/core/round-stats.js";
import { recapItems } from "../static/js/presentation/recap.js";
import { bindHoldButton } from "../static/js/hold-button.js";
import { InputController } from "../static/js/input.js";
import { RemoteSession } from "../static/js/network/remote-session.js";

const practice = drill => { const w = new World(); w.reset(undefined, "practice", drill); return w; };
const step = (world, frames, input) => { for (let i = 0; i < frames; i++) world.update(1 / 60, input); };
const span = world => Math.max(...world.playerCells.map(c => c.x)) - Math.min(...world.playerCells.map(c => c.x));

test("聚拢收缩球群，保留质量与合体冷却，松开恢复鼠标目标", () => {
  const world = practice("regroup"), initial = span(world);
  step(world, 120, { x: 1, y: 0, regroup: true, target: { x: 3000, y: 1100 } });
  assert.ok(span(world) < initial * .6);
  assert.equal(world.playerCells.length, 4);
  assert.equal(world.playerGroup.mass, 288);
  assert.ok(world.playerCells.every(c => c.mergeRemaining > 7.9));
  const x = world.playerGroup.x;
  step(world, 60, { x: 1, y: 0, regroup: false, target: { x: 3000, y: 1100 } });
  assert.ok(world.playerGroup.x > x + 80); assert.equal(world.regrouping, false);
});

test("单球聚拢不拦移动；八分身在边缘聚拢不越界、不超量", () => {
  const w = practice("split"); w.bots = [];
  const x = w.player.x; step(w, 60, { x: 1, y: 0, regroup: true });
  assert.ok(w.player.x > x); assert.equal(w.regrouping, false);
  w.playerCells = Array.from({ length: 8 }, (_, i) => {
    const c = createBall({ id: `p${i}`, mass: 72, x: 20 + i * 35, y: 40 + i * 10, isPlayer: true });
    c.mergeRemaining = 10; return c;
  });
  step(w, 60, { x: -1, y: -1, regroup: true });
  assert.equal(w.playerCells.length, 8); assert.equal(w.playerGroup.mass, 576);
  assert.ok(w.playerCells.every(c => c.x >= c.radius && c.y >= c.radius));
});

for (const drill of ["split", "feed", "regroup"]) {
  test(`练习 ${drill} 使用真实技能完成，完成事件只发一次`, () => {
    const w = practice(drill);
    assert.equal(w.foods.length, 0); assert.equal(w.hotspots.zones.length, 0); assert.equal(w.protectionRemaining, 0);
    let completed = 0;
    for (let i = 0; i < 760; i++) {
      const input = drill === "split" ? { x: 1, y: 0, split: i === 0, target: { x: 1720, y: 1100 } } :
        drill === "feed" ? { x: 0, y: 0, sporeHeld: true } : { x: 0, y: 0, regroup: true };
      w.update(1 / 60, input);
      completed += w.events.filter(e => e.type === "practice-complete").length;
    }
    assert.equal(w.practice.complete, true); assert.equal(completed, 1); assert.equal(w.gameOver, false);
    if (drill === "split") { assert.equal(w.stats.values.splits, 1); assert.equal(w.stats.values.cellsEaten, 1); }
    if (drill === "feed") { assert.ok(w.stats.values.spikesFed >= 5); assert.ok(w.stats.values.spikesLaunched >= 1); }
    if (drill === "regroup") { assert.ok(w.practice.completedAt >= 10); assert.equal(w.playerCells.length, 1); assert.equal(w.regrouping, false); }
  });
}

test("练习靶不追击，玩家不会被靶吞掉；失误可补靶和质量", () => {
  const w = practice("feed"), target = w.bots[0], x = target.x;
  step(w, 30, { x: 0, y: 0 }); assert.equal(target.x, x);
  w.spikes = []; growBall(w.player, 36 - w.player.mass);
  Object.assign(w.player, { x: target.x, y: target.y });
  w.update(1 / 60, { x: 0, y: 0 });
  assert.ok(w.player.alive); assert.equal(w.gameOver, false); assert.equal(w.player.mass, 240);
  const split = practice("split"); split.bots[0].x = split.player.x; split.bots[0].y = split.player.y;
  split.update(1 / 60, { x: 0, y: 0 });
  assert.equal(split.practice.complete, false); assert.equal(split.bots.length, 1);
});

test("练习暂停冻结时钟和合体冷却，重练清空目标与统计", () => {
  const session = new LocalSession(); session.start(undefined, "practice", "regroup");
  session.step(1, { x: 0, y: 0, regroup: true }); session.pause();
  const before = session.getSnapshot(); session.step(30, { x: 1, y: 0, regroup: true });
  assert.equal(session.getSnapshot().elapsed, before.elapsed);
  assert.equal(session.getSnapshot().split.mergeRemaining, before.split.mergeRemaining);
  session.start(undefined, "practice", "regroup");
  assert.equal(session.getSnapshot().elapsed, 0); assert.equal(session.getSnapshot().practice.complete, false);
  assert.equal(session.getSnapshot().stats.activeSeconds, 0);
});

test("练习和联机不走单机最高分保存，经典和生存保留", () => {
  for (const mode of ["classic", "survival", "practice"]) {
    const s = new LocalSession(); s.start(undefined, mode);
    assert.equal(isRankedRound(s.getSnapshot()), mode !== "practice");
  }
  assert.equal(isRankedRound({ mode: "survival", network: {} }), false);
});

test("复盘按主动操作去重、按孢子归属记喂刺，快照独立", () => {
  const stats = new RoundStats();
  stats.record([{ type: "split" }, { type: "split" }, { type: "split", ownerId: "bot" },
    { type: "eat" }, { type: "spike-feed", actorId: "bot" }, { type: "spike-feed", actorId: "player" },
    { type: "spike-launch", actorId: "player" }, { type: "spike-feed" }]);
  assert.equal(stats.values.splits, 1); assert.equal(stats.values.cellsEaten, 1);
  assert.equal(stats.values.spikesFed, 1); assert.equal(stats.values.spikesLaunched, 1);
  stats.observe([{ alive: true, mass: 144 }, { alive: true, mass: 72 }, { alive: false, mass: 999 }]);
  const snapshot = stats.snapshot(); snapshot.peakMass = 0;
  stats.observe([{ alive: true, mass: 36 }]);
  assert.equal(stats.values.peakMass, 216); assert.equal(stats.values.maxCells, 2);
});

test("生存复活保留复盘，重开才清零；末球损失只算一次", () => {
  const w = new World(); w.reset(undefined, "survival"); w.elapsed = 5;
  w.foods = []; w.spikes = []; w.bots = [w.bots[0]];
  const enemy = w.bots[0]; growBall(enemy, 300 - enemy.mass);
  Object.assign(enemy, { x: w.player.x, y: w.player.y, thinkTimer: Infinity });
  w.stats.record([{ type: "food" }]); w.update(1 / 60, { x: 0, y: 0 });
  assert.equal(w.player.mass, 36); assert.equal(w.stats.values.foods, 1); assert.equal(w.stats.values.cellsLost, 1);
  w.reset(undefined, "survival"); assert.equal(w.stats.values.foods, 0); assert.equal(w.stats.values.cellsLost, 0);
});

test("复盘兼容旧服务端缺计数和质量回退", () => {
  const rows = recapItems({ peakMass: 250 });
  assert.equal(rows.length, 8); assert.equal(rows[0].value, "250 m"); assert.equal(rows[2].value, "—");
});

test("C 键、手机聚拢与失焦能正确持有和释放", () => {
  const original = globalThis.window, events = {};
  globalThis.window = { addEventListener: (type, cb) => { events[type] = cb; } };
  try {
    const input = new InputController({ addEventListener() {} });
    events.keydown({ key: "c", target: { tagName: "CANVAS" }, preventDefault() {} });
    assert.equal(input.getInput({ x: 0, y: 0 }).regroup, true);
    events.keyup({ key: "c" }); assert.equal(input.getInput({ x: 0, y: 0 }).regroup, false);
    input.setRegroupHeld(true); assert.equal(input.getInput({ x: 0, y: 0 }).regroup, true);
    events.blur(); assert.equal(input.getInput({ x: 0, y: 0 }).regroup, false);
  } finally { globalThis.window = original; }
});

test("触屏聚拢只接受首指，松开、取消、窗口失焦和重置均释放", () => {
  const events = {}, host = {}, values = []; let captured = null;
  const button = { addEventListener: (type, cb) => { events[type] = cb; }, setPointerCapture: id => { captured = id; },
    hasPointerCapture: id => captured === id, releasePointerCapture: () => { captured = null; } };
  const reset = bindHoldButton(button, held => values.push(held), { addEventListener: (type, cb) => { host[type] = cb; } });
  const pointer = id => ({ button: 0, pointerId: id, preventDefault() {} });
  events.pointerdown(pointer(1)); events.pointerdown(pointer(2)); events.pointerup(pointer(2)); assert.equal(values.at(-1), true);
  events.pointercancel(pointer(1)); assert.equal(values.at(-1), false);
  events.pointerdown(pointer(3)); host.blur(); assert.equal(values.at(-1), false);
  events.keydown({ key: " ", preventDefault() {} }); assert.equal(values.at(-1), true);
  reset(); assert.equal(values.at(-1), false);
  events.keydown({ key: "Enter", preventDefault() {} }); events.keyup({ key: "Enter", preventDefault() {} });
  assert.equal(values.at(-1), false);
});

test("联机聚拢按下与松开立即发送，停止后不重发输入", () => {
  const remote = new RemoteSession(new LocalSession().getSnapshot(), () => {}), sent = [];
  remote.socket = { readyState: 1, bufferedAmount: 0, send: data => sent.push(JSON.parse(data)), close() {} };
  remote.connection = "connected"; remote.state = "playing"; remote.inactive = false;
  remote.sendTimer = 0; remote.step(.001, { x: 0, y: 0, regroup: true });
  remote.step(.001, { x: 0, y: 0, regroup: false });
  assert.equal(sent[0].regroup, true); assert.equal(sent[1].regroup, false);
  remote.stop(); remote.step(1, { regroup: true }); assert.equal(sent.at(-1).type, "stop"); remote.leave();
});
