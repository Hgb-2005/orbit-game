import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../static/js/config.js";
import { FoodHotspots } from "../static/js/core/hotspots.js";
import { World } from "../static/js/core/world.js";
import { LocalSession } from "../static/js/session.js";
import { createBall, distanceSquared } from "../static/js/core/entities.js";

function randomSource() {
  let seed = 42;
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

function checkZones(zones) {
  assert.equal(zones.length, 2);
  assert.ok(Math.sqrt(distanceSquared(zones[0], zones[1])) >= CONFIG.hotspots.separation);
  for (const zone of zones) {
    assert.ok(zone.x - zone.radius >= 0 && zone.x + zone.radius <= CONFIG.world.width);
    assert.ok(zone.y - zone.radius >= 0 && zone.y + zone.radius <= CONFIG.world.height);
  }
}

test("富集区在地图内分散生成，换位后使用新的位置和标识", () => {
  for (const random of [randomSource(), () => 0.5]) {
    const hotspots = new FoodHotspots(CONFIG.world, random);
    for (let i = 0; i < 8; i++) {
      checkZones(hotspots.zones);
      const previous = hotspots.zones;
      assert.equal(hotspots.update(CONFIG.hotspots.duration), true);
      assert.ok(hotspots.zones.every(zone => previous.every(old => zone.id !== old.id && distanceSquared(zone, old) > (zone.radius * 2) ** 2)));
    }
  }
});

test("富集区按模拟时间每 45 秒换位，较大步长不丢失周期", () => {
  const hotspots = new FoodHotspots(CONFIG.world, randomSource());
  assert.equal(hotspots.update(44), false);
  assert.equal(hotspots.remaining, 1);
  assert.equal(hotspots.update(92), true);
  assert.equal(hotspots.cycle, 3);
  assert.equal(hotspots.remaining, 44);
});

test("初始食物明显集中在富集区，强制区域采样不会越过圆边界", () => {
  const hotspots = new FoodHotspots(CONFIG.world, randomSource());
  let rich = 0;
  const counts = new Map(hotspots.zones.map(zone => [zone.id, 0]));
  for (let i = 0; i < 10000; i++) {
    const food = hotspots.sampleFoodPosition();
    assert.ok(food.x >= 0 && food.x <= CONFIG.world.width && food.y >= 0 && food.y <= CONFIG.world.height);
    if (!food.hotspotId) continue;
    rich++;
    const zone = hotspots.zones.find(zone => zone.id === food.hotspotId);
    assert.ok(distanceSquared(food, zone) <= (zone.radius - CONFIG.food.radius) ** 2 + 1e-7);
    counts.set(zone.id, counts.get(zone.id) + 1);
  }
  assert.ok(rich > 3300 && rich < 3900, String(rich));
  assert.ok([...counts.values()].every(count => count > 1500));
});

test("连续换位保持食物总量和富集比例，普通食物尽量留在原地", () => {
  const world = new World(randomSource());
  const originalIds = world.foods.map(food => food.id);
  for (let cycle = 0; cycle < 12; cycle++) {
    const ordinary = new Map(world.foods.filter(food => !food.hotspotId).map(food => [food.id, { ...food }]));
    world.hotspots.update(CONFIG.hotspots.duration);
    world.relocateHotspotFood();
    assert.equal(world.foods.length, CONFIG.food.count);
    assert.deepEqual(world.foods.map(food => food.id), originalIds);
    assert.equal(world.foods.filter(food => food.hotspotId).length, Math.round(CONFIG.food.count * CONFIG.hotspots.foodRatio));
    for (const food of world.foods) {
      if (food.hotspotId) {
        const zone = world.hotspots.zones.find(zone => zone.id === food.hotspotId);
        assert.ok(zone, "不能留下已失效的富集区标记");
        assert.ok(distanceSquared(food, zone) <= zone.radius ** 2);
      } else if (ordinary.has(food.id)) assert.deepEqual(food, ordinary.get(food.id));
    }
  }
});

test("区域食物被吃光后，下次换位仍会从普通食物补足富集配额", () => {
  const world = new World(randomSource());
  world.foods = world.foods.filter(food => !food.hotspotId);
  const count = world.foods.length;
  world.hotspots.update(45);
  world.relocateHotspotFood();
  assert.equal(world.foods.length, count);
  assert.equal(world.foods.filter(food => food.hotspotId).length, Math.round(count * CONFIG.hotspots.foodRatio));
});

test("会话暂停冻结富集区，恢复触发换位事件，重开重置时钟", () => {
  const session = new LocalSession();
  session.start();
  session.world.bots = [];
  session.world.foods = [];
  session.world.refillTimer = session.world.respawnTimer = session.world.difficultyTimer = -1e6;
  session.world.hotspots.remaining = 0.005;
  session.pause();
  assert.deepEqual(session.step(60, { x: 0, y: 0 }), []);
  assert.equal(session.getSnapshot().hotspots.remaining, 0.005);
  session.resume();
  assert.ok(session.step(1 / 60, { x: 0, y: 0 }).some(event => event.type === "hotspots"));
  assert.equal(session.getSnapshot().hotspots.cycle, 1);
  session.start();
  assert.equal(session.getSnapshot().hotspots.remaining, 45);
  assert.equal(session.getSnapshot().hotspots.cycle, 0);
});

test("富集区食物沿用普通吞噬规则，AI 觅食不会给玩家加分", () => {
  const world = new World(randomSource());
  const food = world.foods.find(food => food.hotspotId);
  const bot = createBall({ id: "forager", x: food.x, y: food.y, mass: 36 });
  world.bots = [bot];
  world.player.x = 30;
  world.player.y = 30;
  world.foods = [food];
  world.consumeFood();
  assert.equal(bot.mass, 37);
  assert.equal(world.score, 0);
  assert.equal(world.foods.length, 0);
});
