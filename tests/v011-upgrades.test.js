import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../static/js/core/world.js";
import { CONFIG } from "../static/js/config.js";
import { growBall } from "../static/js/core/entities.js";
import { feedSpikes, updateSpikes } from "../static/js/core/spikes.js";
import { CombatFeedback, nearestDanger } from "../static/js/presentation/combat-feedback.js";
import { RemoteSession } from "../static/js/network/remote-session.js";
import { LocalSession } from "../static/js/session.js";
import { InputController } from "../static/js/input.js";

const bounds = { width: 3200, height: 2200 };
const spike = () => ({ id: "fixed", x: 1000, y: 1000, radius: 58, charge: 0, color: "#72c98e" });
const spore = () => ({ x: 990, y: 1000, vx: 560, vy: 0, radius: 6, mass: 8, alive: true });

test("喂刺五颗才发射，方向沿孢子，每颗只消费一次", () => {
  const spikes = [spike(), { ...spike(), id: "overlap" }];
  const spores = Array.from({ length: 4 }, spore);
  assert.equal(feedSpikes(spikes, spores, bounds, () => "new").length, 4);
  assert.equal(spikes[0].charge, 4); assert.equal(spikes[1].charge, 0);
  assert.ok(spores.every(item => !item.alive));
  feedSpikes(spikes, [spore()], bounds, () => "new");
  assert.equal(spikes[0].charge, 0); assert.equal(spikes.length, 3);
  assert.equal(spikes[2].vx, 720); assert.equal(spikes[2].vy, 0);
  assert.equal(spikes[2].life, 8);
});

test("临时刺不繁殖，上限时不吞孢子，寿命结束释放名额", () => {
  const spikes = [spike()];
  feedSpikes(spikes, Array.from({ length: 100 }, spore), bounds, () => "new");
  assert.equal(spikes.length, 16);
  const extra = spore(); feedSpikes(spikes, [extra], bounds, () => "new");
  assert.equal(extra.alive, true);
  const atProjectile = { ...spore(), x: spikes[1].x + 20 };
  feedSpikes([spikes[1]], [atProjectile], bounds, () => "new");
  assert.equal(atProjectile.alive, true);
  assert.equal(updateSpikes(spikes, 8, bounds).length, 1);
});

test("临时刺运动与步长无关，撞边停止且不会越界", () => {
  const base = { ...spike(), projectile: true, life: 8, vx: 720, vy: 100 };
  const a = [{ ...base }], b = [{ ...base }];
  updateSpikes(a, 1, bounds);
  for (let i = 0; i < 60; i++) updateSpikes(b, 1 / 60, bounds);
  assert.ok(Math.abs(a[0].x - b[0].x) < 1e-8);
  const edge = [{ ...base, x: bounds.width - 59 }];
  updateSpikes(edge, 1, bounds);
  assert.equal(edge[0].x, bounds.width - 58); assert.equal(edge[0].vx, 0);
});

test("持续吐孢子遵守冷却和预算，松手立即停止，瞄准世界目标", () => {
  const world = new World(); world.bots = []; world.foods = []; world.spikes = [];
  world.refillTimer = -1e6;
  growBall(world.player, 100);
  const input = { x: -1, y: 0, target: { x: 3000, y: 1100 }, sporeHeld: true };
  world.update(1 / 60, input);
  assert.equal(world.spores.length, 1); assert.ok(world.spores[0].vx > 0);
  for (let i = 0; i < 50; i++) world.update(1 / 60, input);
  assert.equal(world.spores.length, 2);
  for (let i = 0; i < 40; i++) world.update(1 / 60, { x: 0, y: 0 });
  assert.equal(world.spores.length, 2);
  world.sporeCooldown = 0; growBall(world.player, 48 - world.player.mass);
  world.emitSpore({ x: 0, y: 1 });
  assert.equal(world.player.mass, 40);
  assert.equal(world.emitSpore({ x: 0, y: 1 }), false);
});

test("输入区分短按与长按，松开、取消和失焦清掉连续状态", () => {
  const original = globalThis.window;
  const windowEvents = {}, canvasEvents = {};
  globalThis.window = { addEventListener: (type, cb) => { windowEvents[type] = cb; } };
  try {
    const canvas = { addEventListener: (type, cb) => { canvasEvents[type] = cb; }, focus() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
    const input = new InputController(canvas);
    const event = { pointerType: "mouse", pointerId: 1, button: 0, clientX: 500, clientY: 300 };
    canvasEvents.pointerdown(event);
    assert.equal(input.getInput({ x: 400, y: 300 }).spore, true);
    const held = input.getInput({ x: 400, y: 300 });
    assert.equal(held.spore, false); assert.equal(held.sporeHeld, true);
    canvasEvents.pointerup(event);
    assert.equal(input.getInput({ x: 0, y: 0 }).sporeHeld, false);
    canvasEvents.pointerdown(event); canvasEvents.pointercancel(event);
    assert.equal(input.getInput({ x: 0, y: 0 }).sporeHeld, false);
    windowEvents.keydown({ key: "e", target: { tagName: "CANVAS" }, preventDefault() {} });
    assert.equal(input.getInput({ x: 0, y: 0 }).sporeHeld, true);
    windowEvents.blur(); assert.equal(input.getInput({ x: 0, y: 0 }).sporeHeld, false);
  } finally { globalThis.window = original; }
});

test("战斗浮字合并食物且数量有界，暂停冻结，重开清空", () => {
  const feedback = new CombatFeedback();
  feedback.add(Array.from({ length: 100 }, () => ({ type: "food", x: 10, y: 20, mass: 1 })));
  feedback.update(.18, false); assert.equal(feedback.floats.length, 0);
  feedback.update(.18, true); assert.equal(feedback.floats.length, 1);
  assert.equal(feedback.floats[0].text, "+100");
  feedback.add(Array.from({ length: 100 }, () => ({ type: "eat", x: 10, y: 20, mass: 36 })));
  assert.equal(feedback.floats.length, 24); assert.equal(feedback.rings.length, 32);
  const life = feedback.floats[0].life; feedback.update(1, false);
  assert.equal(feedback.floats[0].life, life);
  feedback.reset(); assert.equal(feedback.floats.length, 0); assert.equal(feedback.rings.length, 0);
});

test("危险提示按小分身判断，排除队友、保护期、远处及观战", () => {
  const cell = { x: 1000, y: 1000, radius: 20, mass: 36, alive: true, ownerId: "me" };
  const enemy = { ...cell, x: 1100, mass: 80, radius: 27, ownerId: "enemy" };
  const snapshot = { state: "playing", protectionRemaining: 0, playerCells: [cell, { ...cell, mass: 500 }], bots: [enemy] };
  assert.equal(nearestDanger(snapshot).cell, cell);
  for (const bots of [[{ ...enemy, isAlly: true }], [{ ...enemy, x: 2000 }]]) {
    assert.equal(nearestDanger({ ...snapshot, bots }), null);
  }
  assert.equal(nearestDanger({ ...snapshot, protectionRemaining: 1 }), null);
  assert.equal(nearestDanger({ ...snapshot, survival: { protectionByOwner: { enemy: 1 } } }), null);
  assert.equal(nearestDanger({ ...snapshot, spectating: true }), null);
});

function connected() {
  let time = 100;
  const remote = new RemoteSession(new LocalSession().getSnapshot(), () => {}, undefined, () => time);
  remote.connection = "connected"; remote.room = { state: "playing" };
  remote.state = "playing"; remote.resumeToken = "token";
  const sent = [];
  remote.socket = { readyState: 1, bufferedAmount: 0, send: data => sent.push(JSON.parse(data)), close() {} };
  return { remote, sent, at: value => { time = value; } };
}

test("无响应连接按墙钟恢复，绘制 dt 截断不影响看门狗", () => {
  const { remote, at } = connected();
  at(8200); remote.step(.001, { x: 0, y: 0 });
  assert.equal(remote.connection, "reconnecting"); assert.equal(remote.inactive, true);
  assert.ok(remote.reconnectTimer); remote.leave();
  assert.equal(remote.room, null); assert.equal(remote.reconnectTimer, null);
  assert.equal(remote.resumeToken, "");
});

test("结算只收到 pong 时保持连接，发送异常不会冲垮帧循环", () => {
  const { remote, at } = connected(); remote.state = "gameover";
  at(7000); remote.receive({ type: "pong", sent: 6980 });
  at(10000); remote.step(.001, {});
  assert.equal(remote.connection, "connected"); assert.equal(remote.rtt, 20);
  remote.socket.send = () => { throw new Error("transport failed"); };
  assert.doesNotThrow(() => remote.send({ type: "ping" }));
  assert.equal(remote.connection, "reconnecting"); remote.leave();
});

test("停止操作在发送拥堵后重试，长按释放及时同步且没有额外技能脉冲", () => {
  const { remote, sent } = connected();
  remote.step(.001, { x: 1, y: 0, sporeHeld: true, spore: true });
  assert.equal(sent[0].sporeHeld, true);
  remote.step(.001, { x: 1, y: 0, sporeHeld: false });
  assert.equal(sent[1].sporeHeld, false); assert.equal(sent[1].spore, false);
  remote.socket.bufferedAmount = 200 * 1024; remote.stop();
  assert.equal(remote.stopPending, true);
  remote.socket.bufferedAmount = 0; remote.step(.001, {});
  assert.equal(sent.at(-1).type, "stop"); assert.equal(remote.stopPending, false);
  remote.leave();
});
