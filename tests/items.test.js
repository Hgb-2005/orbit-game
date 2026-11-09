import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../static/js/config.js";
import { World } from "../static/js/core/world.js";
import { LocalSession } from "../static/js/session.js";
import { createBall, growBall, speedForMass } from "../static/js/core/entities.js";

const step = CONFIG.simulation.step;

function emptyWorld(mass = CONFIG.player.initialMass) {
  const world = new World(() => 0.37);
  world.bots = [];
  world.foods = [];
  world.spikes = [];
  world.refillTimer = world.respawnTimer = world.difficultyTimer = -1e6;
  if (mass !== world.player.mass) growBall(world.player, mass - world.player.mass);
  return world;
}

function item(type, x, y) {
  const definition = CONFIG.items.types[type];
  return { id: `test-${type}`, type, x, y, radius: 12,
    color: definition.color, symbol: definition.symbol };
}

function finiteNumbers(value, path = "root") {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} 必须是有限数字`);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => finiteNumbers(entry, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) finiteNumbers(entry, `${path}.${key}`);
  }
}

test("单机拾取道具会扣掉地图物件、启动计时并发送本机事件", () => {
  const world = emptyWorld();
  world.itemSystem.reset("off");
  world.itemSystem.items = [item("shield", world.player.x, world.player.y)];
  world.update(step, { x: 0, y: 0 });

  assert.equal(world.itemSystem.items.length, 0);
  assert.equal(world.itemSystem.shieldActive("player"), true);
  const event = world.events.find(entry => entry.type === "item");
  assert.equal(event.ownerId, "player");
  assert.equal(event.isPlayer, true);
  assert.equal(event.itemType, "shield");
});

test("重复拾取同类道具只延长当前计时，不叠加倍率或层数", () => {
  const world = emptyWorld();
  world.itemSystem.reset("off");
  world.elapsed = world.itemSystem.elapsed = 0;
  world.itemSystem.apply("player", "speed");
  const firstUntil = world.itemSystem.ownerEffects("player").speed;
  world.elapsed = world.itemSystem.elapsed = 2;
  world.itemSystem.apply("player", "speed");
  const effects = world.itemSystem.ownerEffects("player");

  assert.deepEqual(Object.keys(effects), ["speed"]);
  assert.equal(firstUntil, CONFIG.items.types.speed.duration);
  assert.equal(effects.speed, firstUntil + 2);
  assert.equal(world.itemSystem.speedMultiplier("player"), CONFIG.items.speedMultiplier);
});

test("暂停冻结效果、连击窗口和道具补充，恢复后继续按模拟时间计时", () => {
  const session = new LocalSession();
  session.start(undefined, "classic", "split", { itemMode: "standard" });
  const world = session.world;
  world.bots = [];
  world.foods = [];
  world.itemSystem.items = [];
  world.itemSystem.apply("player", "shield");
  world.itemSystem.registerEat("player");

  session.pause();
  const before = session.getSnapshot().items;
  session.step(8, { x: 1, y: 0 });
  assert.deepEqual(session.getSnapshot().items, before);
  assert.equal(world.itemSystem.refillTimer, 0);

  session.resume();
  session.step(1, { x: 0, y: 0 });
  const after = session.getSnapshot().items;
  assert.equal(after.effects.player.shield, before.effects.player.shield);
  assert.equal(world.elapsed, 1);
  assert.ok(world.itemSystem.combo("player").count >= 1);
});

test("重开和生存局复活都会清空上一个生命周期的道具与连击", () => {
  const world = emptyWorld();
  world.itemSystem.apply("player", "speed");
  world.itemSystem.registerEat("player");
  world.reset(undefined, "classic", "split", { itemMode: "off" });
  assert.equal(world.itemSystem.effects.size, 0);
  assert.equal(world.itemSystem.combo("player").count, 0);
  assert.equal(world.itemSystem.items.length, 0);

  const survival = emptyWorld();
  survival.reset(undefined, "survival", "split", { itemMode: "off" });
  survival.bots = [];
  survival.foods = [];
  survival.spikes = [];
  survival.refillTimer = survival.respawnTimer = survival.difficultyTimer = -1e6;
  survival.itemSystem.apply("player", "speed");
  survival.elapsed = 4;
  const hunter = createBall({ id: "hunter", ownerId: "hunter", x: survival.player.x,
    y: survival.player.y, mass: 1200, name: "追猎者" });
  survival.bots = [hunter];
  survival.consumeBalls();

  assert.equal(survival.gameOver, false);
  assert.equal(survival.survival.roster.get("player").lives, 2);
  assert.equal(survival.player.mass, CONFIG.player.initialMass);
  assert.equal(survival.itemSystem.effects.size, 0);
  assert.equal(survival.itemSystem.combo("player").count, 0);
});

test("加速仍受质量降速约束，磁铁只移动范围内食物且不越界", () => {
  assert.ok(speedForMass(1000) < speedForMass(CONFIG.player.initialMass));
  const world = emptyWorld();
  world.itemSystem.reset("off");
  world.player.x = world.player.y = 20;
  world.foods = [
    { id: "outside", x: -10, y: 20, radius: 3.3, color: "#fff" },
    { id: "nearby", x: 120, y: 20, radius: 3.3, color: "#fff" },
    { id: "far", x: 900, y: 900, radius: 3.3, color: "#fff" },
  ];
  world.itemSystem.apply("player", "magnet");
  world.itemSystem.applyMagnet(0.05, world);

  assert.ok(world.foods[0].x >= world.foods[0].radius);
  assert.ok(world.foods[1].x < 120);
  assert.deepEqual(world.foods[2], { id: "far", x: 900, y: 900, radius: 3.3, color: "#fff" });
});

test("护盾挡吞定位到正确本体，但不阻止刺球伤害", () => {
  const world = emptyWorld();
  world.itemSystem.apply("player", "shield");
  world.elapsed = 4;
  const hunter = createBall({ id: "hunter", ownerId: "hunter", x: world.player.x,
    y: world.player.y, mass: 1000, name: "追猎者" });
  world.bots = [hunter];
  world.consumeBalls();

  assert.equal(world.playerCells.length, 1);
  const block = world.events.find(entry => entry.type === "shield-block");
  assert.equal(block.ownerId, "player");
  assert.equal(block.isPlayer, true);

  world.bots = [];
  growBall(world.player, 120);
  const before = world.player.mass;
  world.spikes = [{ id: "spike", x: world.player.x, y: world.player.y,
    radius: CONFIG.spikes.radius, color: "#72c98e" }];
  world.handleSpikes({ x: 1, y: 0 });
  assert.ok(world.playerCells.reduce((sum, cell) => sum + cell.mass, 0) < before);
  assert.ok(world.events.some(entry => entry.type === "spike"));
});

test("连续吞噬生成带 isPlayer 的连击事件，快照可以无损序列化", () => {
  const world = emptyWorld(500);
  world.elapsed = 4;
  world.bots = [0, 1].map(index => createBall({ id: `prey-${index}`, ownerId: `prey-${index}`,
    x: world.player.x, y: world.player.y, mass: 20, name: `小球${index}` }));
  world.consumeBalls();

  const combo = world.events.find(entry => entry.type === "combo");
  assert.equal(combo.count, 2);
  assert.equal(combo.ownerId, "player");
  assert.equal(combo.isPlayer, true);
  assert.equal(world.itemSystem.combo("player").count, 2);
  finiteNumbers(world.itemSystem.snapshot("player"));
  assert.doesNotThrow(() => JSON.stringify(world.itemSystem.snapshot("player")));
});
