/** 无外部依赖：node --test tests/game.test.js */
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../static/js/config.js";
import { canEat, createBall, growBall, moveBall } from "../static/js/core/entities.js";
import { World } from "../static/js/core/world.js";
import { LocalSession } from "../static/js/session.js";
import { ScoreService } from "../static/js/services/scores.js";
import { Sprint } from "../static/js/core/sprint.js";
import { BOT_ROLES, getDifficulty, getStage, outsideView } from "../static/js/core/progression.js";

function seededRandom() {
  let seed = 42;
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

function worldWithNoBots() {
  const world = new World(seededRandom());
  world.bots = [];
  world.foods = [];
  return world;
}

test("质量增加会扩大半径并降低速度", () => {
  const ball = createBall({ id: "a", x: 100, y: 100, mass: 36 });
  const before = { radius: ball.radius, speed: ball.speed };
  growBall(ball, 108);
  assert.equal(ball.radius, before.radius * 2);
  assert.ok(ball.speed < before.speed);
});

test("食物只能消费一次，增加质量与分数，并在定时器到期后补充", () => {
  const world = worldWithNoBots();
  world.foods = [{ x: world.player.x, y: world.player.y, radius: 3, color: "#fff" }];
  world.update(1 / 60, { x: 0, y: 0 });
  assert.equal(world.score, 1);
  assert.equal(world.player.mass, 37);
  world.update(1 / 60, { x: 0, y: 0 });
  assert.equal(world.score, 1);
  world.update(0.3, { x: 0, y: 0 });
  assert.equal(world.foods.length, CONFIG.food.count);
});

test("吞噬需要足够体型差和重叠距离", () => {
  const big = createBall({ id: "big", x: 100, y: 100, mass: 100 });
  const small = createBall({ id: "small", x: 100, y: 100, mass: 30 });
  assert.equal(canEat(big, small), true);
  assert.equal(canEat(small, big), false);
  small.x = 180;
  assert.equal(canEat(big, small), false);
  small.x = 100;
  small.mass = 99;
  assert.equal(canEat(big, small), false);
});

test("出生保护结束后会被大球吞噬，死亡后世界停止更新", () => {
  const world = worldWithNoBots();
  const enemy = createBall({ id: "enemy", x: world.player.x, y: world.player.y, mass: 200, name: "测试球" });
  world.bots = [enemy];
  world.consumeBalls();
  assert.equal(world.gameOver, false);
  world.elapsed = 4;
  world.consumeBalls();
  assert.equal(world.gameOver, true);
  assert.equal(world.killer, "测试球");
  const elapsed = world.elapsed;
  world.update(1, { x: 1, y: 0 });
  assert.equal(world.elapsed, elapsed);
});

test("玩家吞噬 AI 时只加一次分，并移除被吞噬实体", () => {
  const world = worldWithNoBots();
  world.elapsed = 4;
  growBall(world.player, 100);
  world.bots = [createBall({ id: "small", x: world.player.x, y: world.player.y, mass: 20 })];
  world.consumeBalls();
  world.consumeBalls();
  assert.equal(world.score, 20);
  assert.equal(world.eatenBalls, 1);
  assert.equal(world.bots.length, 0);
});

test("边界限制有效，斜向运动不比水平方向快", () => {
  const a = createBall({ id: "a", x: 100, y: 100, mass: 36 });
  const b = createBall({ id: "b", x: 100, y: 100, mass: 36 });
  moveBall(a, { x: 1, y: 0 }, 1, CONFIG.world);
  moveBall(b, { x: 1, y: 1 }, 1, CONFIG.world);
  assert.ok(Math.abs(Math.hypot(a.vx, a.vy) - Math.hypot(b.vx, b.vy)) < 0.001);
  a.x = a.radius;
  moveBall(a, { x: -1, y: 0 }, 1, CONFIG.world);
  assert.equal(a.x, a.radius);
});

test("暂停不推进模拟；重开重置本局数据", () => {
  const session = new LocalSession();
  session.start();
  session.step(1 / 60, { x: 0, y: 0 });
  session.pause();
  const elapsed = session.world.elapsed;
  session.step(1, { x: 1, y: 0 });
  assert.equal(session.world.elapsed, elapsed);
  session.resume();
  session.step(1 / 60, { x: 0, y: 0 });
  assert.ok(session.world.elapsed > elapsed);
  session.start();
  assert.equal(session.world.score, 0);
  assert.equal(session.world.elapsed, 0);
  assert.equal(session.world.player.mass, 36);
});

test("固定步长运行两分钟后，实体仍保持有效且食物持续刷新", () => {
  const world = new World(seededRandom());
  // 给玩家足够质量以免提前死亡，确保实际覆盖完整的 7200 个模拟帧。
  growBall(world.player, 10000);
  for (let i = 0; i < 7200; i++) {
    world.update(1 / 60, { x: Math.cos(i / 180), y: Math.sin(i / 180) });
    for (const ball of [world.player, ...world.bots]) {
      assert.ok(Number.isFinite(ball.x) && Number.isFinite(ball.y));
      assert.ok(ball.x >= ball.radius && ball.x <= world.bounds.width - ball.radius);
      assert.ok(ball.y >= ball.radius && ball.y <= world.bounds.height - ball.radius);
    }
  }
  assert.ok(Math.abs(world.elapsed - 120) < 0.001);
  assert.equal(world.gameOver, false);
  assert.ok(world.foods.length <= CONFIG.food.count);
});

function mockStorage(t) {
  const original = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  t.after(() => {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  });
  return values;
}

test("记录接口断线时保留待同步分数，恢复连接后可写入数据库", async t => {
  const values = mockStorage(t);
  const request = t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const service = new ScoreService(() => {});
  service.observe(42);
  await service.flush();
  assert.equal(service.status, "offline");
  assert.equal(values.get("orbit.pending-score"), "42");
  const recovered = new ScoreService(() => {});
  request.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ high_score: 42 }) }));
  await recovered.flush();
  assert.equal(recovered.highScore, 42);
  assert.equal(recovered.status, "saved");
  assert.equal(values.has("orbit.pending-score"), false);
});

test("保存请求期间分数再次增加，不会丢失新的待同步记录", async t => {
  mockStorage(t);
  let finishRequest;
  t.mock.method(globalThis, "fetch", () => new Promise(resolve => { finishRequest = resolve; }));
  const service = new ScoreService(() => {});
  service.observe(10);
  const saving = service.flush();
  service.observe(15);
  assert.equal(service.flush(), saving);
  finishRequest({ ok: true, json: async () => ({ high_score: 10 }) });
  await saving;
  assert.equal(service.highScore, 15);
  assert.equal(service.pending, 15);
  assert.equal(service.status, "pending");
});

test("冲刺一次只扣 7% 质量、保持分数不变，并提升实际移动速度", () => {
  const world = worldWithNoBots();
  world.score = 100;
  growBall(world.player, 64);
  const beforeSpeed = world.player.speed;
  world.update(1 / 60, { x: 1, y: 0, sprint: true });
  assert.equal(world.player.mass, 93);
  assert.equal(world.score, 100);
  assert.equal(world.sprint.remaining, CONFIG.sprint.duration);
  assert.ok(world.sprint.getSnapshot(world.player).multiplier * world.player.speed > beforeSpeed);
  assert.equal(world.events.filter(event => event.type === "sprint").length, 1);
  world.update(1 / 60, { x: 1, y: 0, sprint: true });
  assert.equal(world.player.mass, 93);
  assert.equal(world.events.some(event => event.type === "sprint"), false);
});

test("冲刺结束后进入冷却；一直按住不会在冷却后自动连续扣质量", () => {
  const sprint = new Sprint();
  const player = createBall({ id: "p", x: 100, y: 100, mass: 100 });
  const input = { x: 1, y: 0, sprint: true };
  sprint.update(1 / 60, input, player);
  for (let i = 0; i < 80; i++) sprint.update(1 / 60, input, player);
  assert.equal(sprint.remaining, 0);
  assert.ok(sprint.cooldown > 0);
  for (let i = 0; i < 360; i++) sprint.update(1 / 60, input, player);
  assert.equal(sprint.cooldown, 0);
  assert.equal(player.mass, 93);
  sprint.update(1 / 60, { ...input, sprint: false }, player);
  sprint.update(1 / 60, input, player);
  assert.ok(Math.abs(player.mass - 86.49) < 0.00001);
});

test("质量不足或完全静止时不会启动冲刺或扣除质量", () => {
  const sprint = new Sprint();
  const small = createBall({ id: "small", x: 100, y: 100, mass: 25 });
  sprint.update(1 / 60, { x: 1, y: 0, sprint: true }, small);
  assert.equal(small.mass, 25);
  assert.equal(sprint.remaining, 0);
  assert.equal(sprint.cooldown, 0);
  const still = createBall({ id: "still", x: 100, y: 100, mass: 100 });
  const second = new Sprint();
  second.update(1 / 60, { x: 0, y: 0, sprint: true }, still);
  assert.equal(still.mass, 100);
  assert.equal(second.remaining, 0);
});

test("冲刺允许转向，松开移动输入后沿最后方向完成短冲刺", () => {
  const sprint = new Sprint();
  const player = createBall({ id: "p", x: 100, y: 100, mass: 100 });
  sprint.update(1 / 60, { x: 1, y: 0, sprint: true }, player);
  const turning = sprint.update(1 / 60, { x: 0, y: 1, sprint: false }, player);
  assert.deepEqual(turning, { x: 0, y: 1 });
  assert.deepEqual(sprint.update(1 / 60, { x: 0, y: 0, sprint: false }, player), turning);
});

test("暂停冻结冲刺与冷却，重开会清空技能和阶段状态", () => {
  const session = new LocalSession();
  session.start();
  session.world.foods = [];
  session.world.bots = [];
  session.step(1 / 60, { x: 1, y: 0, sprint: true });
  const active = session.world.sprint.remaining;
  session.pause();
  session.step(20, { x: 1, y: 0 });
  assert.equal(session.world.sprint.remaining, active);
  session.resume();
  session.world.sprint.remaining = 0;
  session.world.sprint.cooldown = 3;
  session.pause();
  session.step(20, { x: 1, y: 0 });
  assert.equal(session.world.sprint.cooldown, 3);
  session.start();
  assert.equal(session.getSnapshot().sprint.ready, true);
  assert.equal(session.getSnapshot().sprint.cooldown, 0);
  assert.equal(session.getSnapshot().stage.target, 300);
});

test("阶段目标按区间推进，414 分时进度为 300 到 800 之间的 22.8%", () => {
  assert.equal(getStage(299).target, 300);
  assert.equal(getStage(300).target, 800);
  const stage = getStage(414);
  assert.equal(stage.previousTarget, 300);
  assert.ok(Math.abs(stage.progress - 0.228) < 0.000001);
  assert.equal(getStage(800).target, 1500);
  assert.ok(getStage(8000).target > 8000);
  assert.ok(getStage(1_000_000).target > 1_000_000);
});

test("一次越过多个目标只提示最高阶段一次，后续更新不会重复提示", () => {
  const world = worldWithNoBots();
  world.score = 1600;
  world.updateProgression();
  const events = world.events.filter(event => event.type === "milestone");
  assert.equal(events.length, 1);
  assert.equal(events[0].reached, 1500);
  assert.equal(world.stage.target, 3000);
  world.events = [];
  world.updateProgression();
  assert.equal(world.events.some(event => event.type === "milestone"), false);
});

test("难度随阶段、存活时间与最大质量提高，规模设有上限", () => {
  const beginning = getDifficulty(0, 36, 0);
  const grown = getDifficulty(414, 450, 120);
  assert.ok(grown.level > beginning.level);
  assert.equal(grown.referenceMass, 450);
  assert.ok(getDifficulty(0, 36, 600).level > beginning.level);
  assert.equal(getDifficulty(10000, 1000000, 99999).referenceMass, CONFIG.difficulty.maxReferenceMass);
});

test("冲刺损失质量不会使已达到的难度或阶段倒退", () => {
  const world = worldWithNoBots();
  world.score = 414;
  growBall(world.player, 414);
  world.update(1 / 60, { x: 1, y: 0, sprint: true });
  assert.ok(world.player.mass < 450);
  assert.equal(world.difficulty.referenceMass, 450);
  assert.equal(world.stage.target, 800);
});

test("动态 AI 生成三种体型，并且整个球体位于视野及其缓冲区之外", () => {
  const world = new World(seededRandom());
  assert.equal(world.bots.length, CONFIG.bots.count);
  for (const [role, profile] of Object.entries(BOT_ROLES)) {
    assert.equal(world.bots.filter(bot => bot.role === role).length, profile.quota);
  }
  world.difficulty = getDifficulty(414, 450, 120);
  for (const role of Object.keys(BOT_ROLES)) {
    const bot = world.createBot(0, role);
    assert.ok(bot);
    assert.equal(outsideView(bot, world.view), true);
    if (role === "forager") assert.ok(bot.mass < 450 / CONFIG.rules.eatMassRatio);
    if (role === "hunter") assert.ok(bot.mass > 450 * CONFIG.rules.eatMassRatio);
  }
});

test("视野覆盖全图时延迟出生，不会把 AI 强行放到玩家眼前", () => {
  const world = worldWithNoBots();
  world.view = { left: 0, top: 0, right: CONFIG.world.width, bottom: CONFIG.world.height };
  assert.equal(world.createBot(12, "hunter"), null);
  world.refillBots();
  assert.equal(world.bots.length, 0);
});

test("难度调整每次最多替换一个视野外 AI，优先补充落后的追猎者", () => {
  const world = new World(seededRandom());
  const original = [...world.bots];
  world.difficulty = getDifficulty(414, 450, 120);
  world.refreshOutdatedBot();
  assert.equal(world.bots.length, original.length);
  const changed = world.bots.filter((bot, index) => bot !== original[index]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].role, "hunter");
  assert.ok(changed[0].mass > 450);
  assert.equal(outsideView(changed[0], world.view), true);
});

test("视野中的落后 AI 不会因为玩家长大而被替换或强制放大", () => {
  const world = worldWithNoBots();
  const bot = createBall({ id: "visible", x: world.player.x + 100, y: world.player.y, mass: 20 });
  bot.role = "hunter";
  world.bots = [bot];
  world.difficulty = getDifficulty(414, 450, 120);
  world.refreshOutdatedBot();
  assert.equal(world.bots[0], bot);
  assert.equal(bot.mass, 20);
});
