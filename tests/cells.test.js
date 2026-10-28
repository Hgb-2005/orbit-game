/** 分裂/合体的行为测试：node --test tests/*.test.js */
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../static/js/config.js";
import { canEat, createBall, growBall } from "../static/js/core/entities.js";
import { splitCells, summarizeCells, updateCellGroup } from "../static/js/core/cells.js";
import { chooseBotDirection } from "../static/js/core/ai.js";
import { World } from "../static/js/core/world.js";
import { LocalSession } from "../static/js/session.js";
import { Camera } from "../static/js/camera.js";
import { InputController } from "../static/js/input.js";

const step = CONFIG.simulation.step;
const massOf = cells => cells.reduce((sum, cell) => sum + cell.mass, 0);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} ≠ ${expected}`);

function emptyWorld(mass = 144) {
  const world = new World();
  world.bots = [];
  world.foods = [];
  world.refillTimer = world.respawnTimer = world.difficultyTimer = -1e6;
  growBall(world.player, mass - world.player.mass);
  return world;
}

function advance(world, seconds, input = { x: 0, y: 0 }) {
  for (let i = 0; i < Math.ceil(seconds / step); i++) world.update(step, input);
}

test("Q 沿输入方向弹射，分裂保持总质量、总面积和累计分数", () => {
  const world = emptyWorld();
  world.score = 108;
  const area = world.player.radius ** 2;
  world.update(step, { x: 1, y: 0, split: true });
  assert.equal(world.playerCells.length, 2);
  near(massOf(world.playerCells), 144);
  near(world.playerCells.reduce((sum, cell) => sum + cell.radius ** 2, 0), area);
  assert.equal(world.score, 108);
  const [source, child] = world.playerCells;
  assert.ok(child.x > source.x);
  assert.ok(child.impulseX > 0);
  assert.equal(child.ownerId, source.ownerId);
  assert.notEqual(child.id, source.id);
  assert.equal(world.events.filter(event => event.type === "split").length, 1);
});

test("长按不会重复分裂，松开再次按下可继续从两个分成八个", () => {
  const world = emptyWorld(576);
  advance(world, 1.2, { x: 1, y: 0, split: true });
  assert.equal(world.playerCells.length, 2);
  world.update(step, { x: 1, y: 0, split: false });
  world.update(step, { x: 1, y: 0, split: true });
  assert.equal(world.playerCells.length, 4);
  advance(world, 1, { x: 1, y: 0 });
  world.update(step, { x: 1, y: 0, split: true });
  assert.equal(world.playerCells.length, 8);
  near(massOf(world.playerCells), 576);
});

test("质量不足、没有方向或按键仍处冷却时不分裂", () => {
  const small = emptyWorld(71);
  small.update(step, { x: 1, y: 0, split: true });
  assert.equal(small.playerCells.length, 1);
  assert.equal(small.split.cooldown, 0);
  const world = emptyWorld();
  world.update(step, { x: 0, y: 0, split: true });
  assert.equal(world.playerCells.length, 1);
  world.update(step, { x: 1, y: 0 });
  world.update(step, { x: 1, y: 0, split: true });
  world.update(step, { x: 1, y: 0 });
  world.update(step, { x: 1, y: 0, split: true });
  assert.equal(world.playerCells.length, 2);
});

test("仅剩一个空位时优先分裂最大的合格分身", () => {
  const cells = [80, 200, 40].map((mass, i) => createBall({ id: `p${i}`, ownerId: "p", mass, x: 500, y: 500 }));
  // 传入 4 作为局部上限，专门验证“只剩一个空位时取最大合格分身”；
  // 默认规则上限已经提高到 8 个。
  splitCells(cells, { x: 0, y: -1 }, CONFIG.world, () => "new", 4);
  assert.equal(cells.length, 4);
  assert.deepEqual(cells.map(cell => cell.mass), [80, 100, 40, 100]);
  near(massOf(cells), 320);
});

test("同一控制者的分身不能互吃或刷分，AI 也忽略自己的分身", () => {
  const world = emptyWorld();
  world.update(step, { x: 1, y: 0, split: true });
  const [a, b] = world.playerCells;
  growBall(a, 200);
  b.x = a.x;
  b.y = a.y;
  assert.equal(canEat(a, b), false);
  world.elapsed = 4;
  world.consumeBalls();
  assert.equal(world.playerCells.length, 2);
  assert.equal(world.score, 0);
  const bot = createBall({ id: "h1", ownerId: "hunter", mass: 300, x: 100, y: 100 });
  const sibling = createBall({ id: "h2", ownerId: "hunter", mass: 30, x: 170, y: 100 });
  world.bots = [bot, sibling];
  assert.deepEqual(chooseBotDirection(bot, { ...world, protectionRemaining: 3 }), { x: 0, y: 0 });
});

test("按每个分身自己的质量判断吞噬，总质量不能用于吞噬大于分身的敌人", () => {
  const world = emptyWorld();
  world.update(step, { x: 1, y: 0, split: true });
  const [a, b] = world.playerCells;
  b.x += 400;
  world.elapsed = 4;
  const peer = createBall({ id: "peer", mass: 80, x: a.x, y: a.y });
  world.bots = [peer];
  world.consumeBalls();
  assert.equal(world.bots.length, 1);
  assert.equal(world.playerCells.length, 2);
  assert.equal(world.score, 0);
  world.foods = [a, b].map(cell => ({ x: cell.x, y: cell.y, radius: 3, color: "#fff" }));
  world.consumeFood();
  near(massOf(world.playerCells), 146);
  assert.equal(world.score, 2);
  world.bots = [a, b].map((cell, i) => createBall({ id: `prey${i}`, mass: 20, x: cell.x, y: cell.y }));
  world.consumeBalls();
  assert.equal(world.bots.length, 0);
  assert.equal(world.eatenBalls, 2);
  assert.equal(world.score, 42);
});

test("空间网格查询半径随大球增长，边缘接触的食物不会漏判", () => {
  const world = emptyWorld(10000);
  const ball = world.player;
  world.foods = [{ id: "wide-food", x: ball.x + 250, y: ball.y, radius: 3, color: "#fff" }];
  world.consumeFood();
  assert.equal(world.foods.length, 0);
  assert.equal(world.score, 1);
});

test("主分身被吃后继续控制剩余分身，仅全部分身被吃时结束一次", () => {
  const world = emptyWorld(160);
  world.update(step, { x: 1, y: 0, split: true });
  const [a, b] = world.playerCells;
  b.x += 500;
  world.elapsed = 4;
  world.score = 124;
  const enemy = createBall({ id: "hunter", mass: 250, x: a.x, y: a.y, name: "追猎者" });
  world.bots = [enemy];
  world.consumeBalls();
  assert.equal(world.gameOver, false);
  assert.equal(world.playerCells.length, 1);
  assert.equal(world.player, b);
  near(world.playerGroup.mass, 80);
  assert.equal(world.score, 124);
  b.x = enemy.x;
  b.y = enemy.y;
  world.consumeBalls();
  assert.equal(world.gameOver, true);
  assert.equal(world.playerCells.length, 0);
  assert.equal(world.killer, "追猎者");
  assert.equal(world.events.filter(event => event.type === "gameover").length, 1);
});

test("出生保护同时保护所有分身，保护结束后才可吞噬", () => {
  const world = emptyWorld();
  world.update(step, { x: 1, y: 0, split: true });
  const cell = world.playerCells[1];
  world.bots = [createBall({ id: "enemy", mass: 1000, x: cell.x, y: cell.y })];
  world.consumeBalls();
  assert.equal(world.playerCells.length, 2);
  world.elapsed = 4;
  world.consumeBalls();
  assert.equal(world.gameOver, true);
});

test("10 秒冷却期间不能合体，到期后无需额外按键即可自动靠拢合体", () => {
  const world = emptyWorld();
  world.score = 100;
  world.update(step, { x: 1, y: 0, split: true });
  advance(world, 9);
  assert.equal(world.playerCells.length, 2);
  assert.ok(world.split.getSnapshot(world.playerCells).mergeRemaining > 0);
  advance(world, 3);
  assert.equal(world.playerCells.length, 1);
  near(world.player.mass, 144);
  assert.equal(world.score, 100);
  assert.equal(world.player.speed, createBall({ id: "check", mass: 144 }).speed);
});

test("体型悬殊时持续移动也可合体，避免小分身永远跑在前面", () => {
  const world = emptyWorld();
  world.update(step, { x: 1, y: 0, split: true });
  growBall(world.playerCells[0], 5000);
  for (const cell of world.playerCells) cell.mergeRemaining = 0;
  advance(world, 6, { x: 1, y: 0 });
  assert.equal(world.playerCells.length, 1);
  near(world.player.mass, 5144);
});

test("合体质量与位置按质量加权，不同归属或尚未到期的分身不会合体", () => {
  const make = (id, mass, x) => createBall({ id, ownerId: "p", x, y: 500, mass });
  const a = make("a", 120, 500);
  const b = make("b", 40, 510);
  a.vx = 20;
  b.vx = 60;
  const merged = updateCellGroup([a, b], step, CONFIG.world);
  assert.equal(merged.length, 1);
  near(a.mass, 160);
  near(a.x, 502.5);
  near(a.vx, 30);
  const c = make("c", 50, 500);
  c.ownerId = "other";
  assert.equal(updateCellGroup([a, c], step, CONFIG.world).length, 2);
  c.ownerId = "p";
  c.mergeRemaining = 3;
  assert.equal(updateCellGroup([a, c], step, CONFIG.world).length, 2);
});

test("分身冲刺统一扣除 7% 总质量，任一分身过小时禁止冲刺", () => {
  const world = emptyWorld();
  world.score = 100;
  world.update(step, { x: 1, y: 0, split: true });
  world.update(step, { x: 1, y: 0, sprint: true });
  near(massOf(world.playerCells), 144 * 0.93);
  near(world.playerCells[0].mass, 72 * 0.93);
  near(world.playerCells[1].mass, 72 * 0.93);
  assert.equal(world.score, 100);
  const other = emptyWorld();
  other.update(step, { x: 1, y: 0, split: true });
  growBall(other.playerCells[1], 25 - other.playerCells[1].mass);
  const before = massOf(other.playerCells);
  other.update(step, { x: 1, y: 0, sprint: true });
  assert.equal(other.sprint.remaining, 0);
  near(massOf(other.playerCells), before);
});

test("暂停冻结分裂和合体计时，重开清除分身与技能状态", () => {
  const session = new LocalSession();
  session.start();
  session.world = emptyWorld();
  session.step(step, { x: 1, y: 0, split: true });
  const before = session.getSnapshot();
  session.pause();
  session.step(20, { x: 1, y: 0 });
  assert.equal(session.getSnapshot().split.mergeRemaining, before.split.mergeRemaining);
  assert.equal(session.getSnapshot().split.cooldown, before.split.cooldown);
  session.start();
  const reset = session.getSnapshot();
  assert.equal(reset.playerCells.length, 1);
  assert.equal(reset.split.cooldown, 0);
  assert.equal(reset.split.mergeRemaining, 0);
  assert.equal(reset.player.mass, CONFIG.player.initialMass);
});

test("镜头按整个球群的质心和范围缩放，球群分散后仍包含所有分身", () => {
  const cells = [
    createBall({ id: "a", x: 1200, y: 800, mass: 36 }),
    createBall({ id: "b", x: 2000, y: 1200, mass: 108 }),
  ];
  const summary = summarizeCells(cells, cells[0]);
  near(summary.x, 1800);
  near(summary.y, 1100);
  near(summary.mass, 144);
  const camera = new Camera();
  camera.update(summary, CONFIG.world, 390, 550, 0, true);
  for (const cell of cells) {
    const point = camera.worldToScreen(cell);
    assert.ok(point.x - cell.radius * camera.zoom >= 0);
    assert.ok(point.x + cell.radius * camera.zoom <= camera.width);
    assert.ok(point.y - cell.radius * camera.zoom >= 0);
    assert.ok(point.y + cell.radius * camera.zoom <= camera.height);
  }
});

test("追猎者分裂有控制者配额，分身不增加 AI 名额，冷却不会重复分裂", () => {
  const world = emptyWorld();
  world.bots = [];
  // 本项只验证分裂配额；避刺策略另有固定场景测试，不让随机刺球阻挡追击路径。
  world.spikes = [];
  for (let i = 0; i < 3; i++) {
    const hunter = createBall({ id: `hunter${i}`, mass: 400, x: 400 + i * 900, y: 300 });
    hunter.role = "hunter";
    const prey = createBall({ id: `prey${i}`, mass: 40, x: hunter.x + 140, y: 300 });
    prey.role = "forager";
    world.bots.push(hunter, prey);
  }
  world.updateBotSplits(step);
  assert.equal(world.bots.length, 8);
  assert.equal(world.botGroups.size, 6);
  assert.equal(world.botGroups.get("hunter0").length, 2);
  assert.equal(world.botGroups.get("hunter1").length, 2);
  assert.equal(world.botGroups.get("hunter2").length, 1);
  world.updateBotSplits(step);
  assert.equal(world.bots.length, 8);
  // 人为移走同伴后，控制者冷却仍然存在，不能再次弹射。
  world.bots = world.bots.filter(bot => bot.id === bot.ownerId);
  world.updateBotSplits(step);
  assert.equal(world.bots.length, 6);
});

test("新 AI 出生安全距离同时检查远离主球的其他分身", () => {
  const world = emptyWorld();
  const remote = createBall({ id: "remote", isPlayer: true, x: 300, y: 300, mass: 36 });
  world.playerCells.push(remote);
  world.random = () => 0.08;
  world.view = { left: 1300, top: 900, right: 1900, bottom: 1300 };
  assert.equal(world.createBot(0, "forager"), null);
});

test("鼠标目标转换为世界坐标，左右键和 Q/E 请求都进入统一输入", t => {
  const listeners = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener: (type, callback) => listeners.set(type, callback) };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const canvas = {
    addEventListener: (type, callback) => listeners.set(`canvas:${type}`, callback),
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    focus() {}, setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {},
  };
  const input = new InputController(canvas);
  input.pointer = { x: 300, y: 150 };
  const view = { left: 1000, right: 1800, top: 700, bottom: 1300 };
  const key = { key: "q", target: { tagName: "CANVAS" }, preventDefault() {} };
  listeners.get("keydown")(key);
  const controls = input.getInput({ x: 200, y: 150 }, view);
  assert.deepEqual(controls.target, { x: 1600, y: 1000 });
  assert.equal(controls.split, true);
  assert.equal(input.getInput({ x: 200, y: 150 }, view).split, true);
  listeners.get("keyup")(key);
  assert.equal(input.getInput({ x: 200, y: 150 }, view).split, false);
  input.requestSplit();
  assert.equal(input.getInput({ x: 200, y: 150 }, view).split, true);
  assert.equal(input.getInput({ x: 200, y: 150 }, view).split, false);
  const mouseEvent = (button, preventDefault = () => {}) => ({
    pointerType: "mouse", button, clientX: 300, clientY: 150, pointerId: 1, preventDefault,
  });
  listeners.get("canvas:pointerdown")(mouseEvent(0));
  assert.equal(input.getInput({ x: 200, y: 150 }, view).spore, true);
  assert.equal(input.getInput({ x: 200, y: 150 }, view).spore, false);
  let contextPrevented = false;
  listeners.get("canvas:pointerdown")(mouseEvent(2, () => { contextPrevented = true; }));
  assert.equal(contextPrevented, true);
  assert.equal(input.getInput({ x: 200, y: 150 }, view).split, true);
  let menuPrevented = false;
  listeners.get("canvas:contextmenu")({ preventDefault: () => { menuPrevented = true; } });
  assert.equal(menuPrevented, true);
  // 按下和松开都发生在两个绘制帧之间时，技能仍只消费一次。
  for (const [name, field] of [["q", "split"]]) {
    const tap = { ...key, key: name };
    listeners.get("keydown")(tap);
    listeners.get("keyup")(tap);
    assert.equal(input.getInput({ x: 200, y: 150 }, view)[field], true);
    assert.equal(input.getInput({ x: 200, y: 150 }, view)[field], false);
  }
  // Shift 已取消，不再生成冲刺输入。
  const shift = { ...key, key: "Shift" };
  listeners.get("keydown")(shift);
  listeners.get("keyup")(shift);
  assert.equal(input.getInput({ x: 200, y: 150 }, view).sprint, false);
  input.reset();
  assert.equal(input.pointer, null);
});
