import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../static/js/core/world.js";
import { SurvivalRound, findRespawnPosition } from "../static/js/core/survival.js";
import { LocalSession } from "../static/js/session.js";
import { createBall, growBall } from "../static/js/core/entities.js";
import { splitCells } from "../static/js/core/cells.js";
import { CONFIG } from "../static/js/config.js";

const idle = { x: 0, y: 0 };
const owner = (world, id = "player") => world.survival.roster.get(id);
function seededRandom() { let s = 17; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function match() {
  const world = new World(seededRandom());
  world.reset(undefined, "survival");
  world.elapsed = 4;
  world.foods = [];
  world.refillTimer = -1e6;
  return world;
}
function collide(world, eater, prey) { prey.x = eater.x; prey.y = eater.y; world.consumeBalls(); }
function arrange(world) {
  // 测试保留真实名单，仅挪开其余参赛者，避免无关碰撞影响断言。
  world.player.x = 1600; world.player.y = 1100;
  world.bots.forEach((bot, index) => { bot.x = 100 + index * 230; bot.y = 250; });
  return world;
}

test("生存模式固定 14 位参赛者，全部 3 命、36 m 开局，经典局仍可选", () => {
  const world = match();
  assert.equal(world.survival.roster.size, CONFIG.bots.count + 1);
  for (const entry of world.survival.roster.values()) {
    assert.equal(entry.lives, 3); assert.equal(entry.initialMass, 36);
  }
  assert.equal(new Set(world.bots.map(bot => bot.ownerId)).size, 13);
  world.reset();
  assert.equal(world.mode, "classic"); assert.equal(world.survival, null);
});

test("玩家被吃扣一命并立即单球复活，吞噬者增重加命，其余实体不变", () => {
  const world = arrange(match());
  const enemy = world.bots[0], bystander = world.bots[1];
  const originalId = world.player.id;
  growBall(enemy, 100);
  growBall(world.player, 20);
  const before = { mass: bystander.mass, x: bystander.x, y: bystander.y };
  world.score = 91; world.sprint.remaining = .7; world.split.cooldown = .5;
  collide(world, enemy, world.player);
  assert.equal(world.gameOver, false); assert.equal(owner(world).lives, 2);
  assert.equal(world.playerCells.length, 1); assert.equal(world.player.mass, 36);
  assert.notEqual(world.player.id, originalId); assert.equal(world.player.ownerId, "player");
  assert.equal(enemy.mass, 192); assert.equal(owner(world, enemy.ownerId).lives, 4);
  assert.equal(owner(world, enemy.ownerId).kills, 1);
  assert.deepEqual({ mass: bystander.mass, x: bystander.x, y: bystander.y }, before);
  assert.equal(world.score, 91); assert.equal(world.elapsed, 4);
  assert.equal(world.sprint.remaining, 0); assert.equal(world.split.cooldown, 0);
  assert.equal(world.player.vx, 0); assert.equal(world.player.impulseX, 0);
  assert.equal(world.protectionRemaining, 3);
  assert.equal(world.events.filter(e => e.type === "respawn" && e.isPlayer).length, 1);
});

test("AI 被吃沿用身份和 36 m 初始质量，玩家正常加分、增重和加命且无命数上限", () => {
  const world = arrange(match());
  const prey = world.bots[0], id = prey.ownerId;
  growBall(world.player, 200);
  owner(world).lives = 20;
  collide(world, world.player, prey);
  const respawn = world.bots.find(bot => bot.ownerId === id);
  assert.ok(respawn); assert.notEqual(respawn.id, prey.id); assert.equal(respawn.mass, 36);
  assert.equal(owner(world, id).lives, 2); assert.equal(owner(world, id).deaths, 1);
  assert.equal(owner(world).lives, 21); assert.equal(owner(world).kills, 1);
  assert.equal(world.player.mass, 272); assert.equal(world.score, 36);
  assert.equal(world.bots.length, 13);
});

test("只丢一个分身不扣命，最后一个被吃才扣一次并给最终吞噬者加命", () => {
  const world = arrange(match());
  growBall(world.player, 108);
  splitCells(world.playerCells, { x: 1, y: 0 }, world.bounds, () => "child");
  const [a, b] = world.playerCells;
  a.x = 1200; a.y = 1000; b.x = 2000; b.y = 1000;
  const enemy1 = world.bots[0], enemy2 = world.bots[1];
  growBall(enemy1, 200); growBall(enemy2, 200);
  collide(world, enemy1, a);
  assert.equal(owner(world).lives, 3); assert.equal(owner(world, enemy1.ownerId).kills, 0);
  assert.equal(world.playerCells.length, 1);
  collide(world, enemy2, b);
  assert.equal(owner(world).lives, 2); assert.equal(owner(world).deaths, 1);
  assert.equal(owner(world, enemy1.ownerId).lives, 3);
  assert.equal(owner(world, enemy2.ownerId).lives, 4);
  assert.equal(world.playerCells.length, 1); assert.equal(world.player.mass, 36);
});

test("同帧吃掉两个 AI 分身只加一命，复活不参与本帧吞噬", () => {
  const world = arrange(match());
  growBall(world.player, 400);
  const prey = world.bots[0]; growBall(prey, 108);
  const cells = [prey];
  const children = splitCells(cells, { x: 1, y: 0 }, world.bounds, () => "bot-child");
  world.bots.push(...children);
  for (const cell of cells) { cell.x = world.player.x; cell.y = world.player.y; }
  world.consumeBalls();
  assert.equal(owner(world).lives, 4); assert.equal(owner(world).kills, 1);
  assert.equal(owner(world, prey.ownerId).lives, 2);
  assert.equal(world.bots.filter(bot => bot.ownerId === prey.ownerId).length, 1);
  assert.equal(world.player.mass, 580);
});

test("AI 互吃采用相同生命规则，不会改动玩家质量或分数", () => {
  const world = arrange(match());
  const [eater, prey] = world.bots;
  growBall(eater, 100);
  collide(world, eater, prey);
  assert.equal(owner(world, eater.ownerId).lives, 4);
  assert.equal(owner(world, prey.ownerId).lives, 2);
  assert.equal(world.player.mass, 36); assert.equal(world.score, 0);
});

test("重生保护对玩家和 AI 双向生效，3 秒内不能吃人或被吃", () => {
  const world = arrange(match());
  growBall(world.player, 500);
  const prey = world.bots[0];
  collide(world, world.player, prey);
  const protectedBot = world.bots.find(bot => bot.ownerId === prey.ownerId);
  collide(world, world.player, protectedBot);
  assert.equal(owner(world, prey.ownerId).lives, 2);
  growBall(protectedBot, 1000);
  collide(world, protectedBot, world.player);
  assert.equal(owner(world).lives, 4);
  world.elapsed += 3;
  collide(world, protectedBot, world.player);
  assert.equal(owner(world).lives, 3);
  assert.equal(world.protectionRemaining, 3);
});

test("零命 AI 永久出局，不通过补位或动态难度重建身份", () => {
  const world = arrange(match());
  growBall(world.player, 400);
  const prey = world.bots[0];
  owner(world, prey.ownerId).lives = 1;
  collide(world, world.player, prey);
  const ids = [...world.survival.roster.keys()];
  world.refillBots(); world.refreshOutdatedBot();
  assert.equal(owner(world, prey.ownerId).lives, 0);
  assert.equal(world.bots.filter(bot => bot.ownerId === prey.ownerId).length, 0);
  assert.deepEqual([...world.survival.roster.keys()], ids);
  assert.equal(world.bots.length, 12);
});

test("玩家最后一命被吃后只结算一次，无复活；重开恢复完整名单、命数和时钟", () => {
  const session = new LocalSession(); session.start(undefined, "survival");
  session.world = arrange(match());
  const world = session.world, enemy = world.bots[0];
  owner(world).lives = 1; growBall(enemy, 500);
  world.player.x = enemy.x; world.player.y = enemy.y;
  session.step(1 / 60, idle);
  assert.equal(session.state, "gameover"); assert.equal(world.playerCells.length, 0);
  assert.equal(world.result.reason, "eliminated"); assert.equal(owner(world).lives, 0);
  assert.equal(world.events.filter(e => e.type === "gameover").length, 1);
  const kills = owner(world, enemy.ownerId).kills;
  world.consumeBalls(); assert.equal(owner(world, enemy.ownerId).kills, kills);
  session.start(undefined, "survival");
  assert.equal(session.getSnapshot().survival.remaining, 300);
  assert.equal(session.getSnapshot().survival.player.lives, 3);
  assert.equal(session.getSnapshot().survival.active, 14);
});

test("暂停冻结生存计时和保护，倒计时到 300 秒立即结算，不执行到点后的吞噬", () => {
  const session = new LocalSession(); session.start(undefined, "survival");
  session.pause(); session.step(25, idle);
  assert.equal(session.getSnapshot().survival.remaining, 300);
  assert.equal(session.getSnapshot().protectionRemaining, 3);
  session.resume();
  const world = session.world; world.elapsed = 299.99;
  const prey = world.bots[0];
  growBall(world.player, 1000); prey.x = world.player.x; prey.y = world.player.y;
  const mass = world.player.mass;
  session.step(1 / 60, idle);
  assert.equal(world.elapsed, 300); assert.equal(session.state, "gameover");
  assert.equal(world.result.reason, "timeout"); assert.equal(world.player.mass, mass);
  assert.equal(owner(world).kills, 0); assert.equal(session.getSnapshot().survival.remaining, 0);
  assert.deepEqual(session.step(5, idle), []);
});

test("结算按命数、击败数、总质量排序，相同三项并列第一", () => {
  const round = new SurvivalRound();
  const balls = ["a", "b", "c", "d"].map((id, i) => createBall({ id, mass: 36 + i, isPlayer: false }));
  balls.forEach(ball => round.register(ball));
  round.roster.get("a").lives = 4;
  round.roster.get("b").kills = 2;
  assert.deepEqual(round.standings(balls).map(e => e.ownerId), ["a", "b", "d", "c"]);
  round.roster.get("b").lives = 4;
  assert.equal(round.standings(balls)[0].ownerId, "b");
  round.roster.get("a").kills = 2; growBall(balls[0], 1);
  assert.deepEqual(round.standings(balls).slice(0, 2).map(e => e.rank), [1, 1]);
});

test("只剩玩家一人时提前获胜", () => {
  const world = arrange(match());
  for (const entry of world.survival.roster.values()) if (!entry.isPlayer) entry.lives = 0;
  world.bots = []; world.consumeBalls();
  assert.equal(world.result.reason, "last-survivor"); assert.equal(world.result.won, true);
});

test("恒定随机源也能保证全员出生、立即复活且位置在边界内", () => {
  const world = new World(() => .5); world.reset(undefined, "survival");
  assert.equal(world.bots.length, 13);
  const position = findRespawnPosition(CONFIG.world, 36, [world.player], () => .5);
  assert.ok(Math.hypot(position.x - world.player.x, position.y - world.player.y) > 400);
  assert.ok(position.x >= 18 && position.x <= CONFIG.world.width - 18);
  assert.ok(position.y >= 18 && position.y <= CONFIG.world.height - 18);
});

test("完整 5 分钟模拟能结束，名单不膨胀、球 ID 不重用、质量和生命始终有效", () => {
  const session = new LocalSession(); session.start(undefined, "survival");
  session.world = match(); session.world.elapsed = 0;
  session.world.foods = Array.from({ length: CONFIG.food.count }, () => session.world.createFood());
  session.world.refillTimer = 0;
  // 玩家躲开战斗以覆盖完整 300 秒，AI 正常觅食、互吃、分裂、复活。
  owner(session.world).protectedUntil = 301;
  let frames = 0;
  let deaths = 0;
  while (session.state === "playing" && frames++ <= 18001) {
    session.step(1 / 60, idle);
    deaths += session.world.events.filter(event => event.type === "respawn").length;
    if (frames % 300 === 0) {
      const cells = [...session.world.playerCells, ...session.world.bots];
      assert.equal(new Set(cells.map(cell => cell.id)).size, cells.length);
      assert.equal(session.world.survival.roster.size, 14);
      assert.ok(cells.every(cell => Number.isFinite(cell.mass) && cell.mass > 0));
      assert.ok([...session.world.survival.roster.values()].every(entry => entry.lives >= 0));
      assert.equal([...session.world.survival.roster.values()].reduce((sum, entry) => sum + entry.lives, 0), 42);
    }
  }
  assert.equal(session.world.elapsed, 300); assert.equal(session.world.result.reason, "timeout");
  assert.equal(session.state, "gameover");
  assert.ok(deaths > 0, "完整模拟应覆盖 AI 吞噬与复活");
});
