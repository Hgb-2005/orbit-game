import test from "node:test";
import assert from "node:assert/strict";
import { getLeaderboard } from "../static/js/core/leaderboard.js";
import { createBall, growBall } from "../static/js/core/entities.js";
import { splitCells, updateCellGroup } from "../static/js/core/cells.js";
import { LocalSession } from "../static/js/session.js";
import { CONFIG } from "../static/js/config.js";

const cell = (id, mass, ownerId = id, isPlayer = false) => createBall({ id, ownerId, mass, isPlayer, x: 1000, y: 1000, name: id });

test("排行合并同属分身，仅统计存活质量，前五名之外仍提供玩家名次", () => {
  const cells = [cell("p1", 40, "player", true), cell("p2", 20, "player", true), cell("dead", 999, "player", true),
    ...Array.from({ length: 6 }, (_, i) => cell(`bot${i}`, 100 + i)), cell("bot0-child", 50, "bot0")];
  cells[2].alive = false;
  const result = getLeaderboard(cells);
  assert.equal(result.total, 7);
  assert.equal(result.entries.length, 5);
  assert.equal(result.entries[0].ownerId, "bot0");
  assert.equal(result.entries[0].mass, 150);
  assert.equal(result.entries[0].cells, 2);
  assert.deepEqual({ rank: result.player.rank, mass: result.player.mass, cells: result.player.cells }, { rank: 7, mass: 60, cells: 2 });
});

test("精确质量决定排名，同质量稳定排序，空场和玩家出局可正常展示", () => {
  const cells = [cell("z", 100.2), cell("b", 100.1), cell("a", 100.1)];
  assert.deepEqual(getLeaderboard(cells).entries.map(entry => entry.ownerId), ["z", "a", "b"]);
  assert.deepEqual(getLeaderboard(cells.reverse()).entries.map(entry => entry.ownerId), ["z", "a", "b"]);
  assert.deepEqual(getLeaderboard([]), { entries: [], player: null, total: 0 });
  assert.equal(getLeaderboard(cells).player, null);
});

test("分裂和合体不增加排行人数、不改变总质量", () => {
  let cells = [cell("p", 144, "player", true)];
  splitCells(cells, { x: 1, y: 0 }, CONFIG.world, () => "child");
  let result = getLeaderboard(cells);
  assert.equal(result.total, 1);
  assert.equal(result.player.mass, 144);
  assert.equal(result.player.cells, 2);
  for (const part of cells) { part.mergeRemaining = 0; part.x = 1000; }
  cells = updateCellGroup(cells, 0, CONFIG.world);
  result = getLeaderboard(cells);
  assert.equal(result.total, 1);
  assert.equal(result.player.mass, 144);
  assert.equal(result.player.cells, 1);
});

test("实时排行跟随食物成长、冲刺消耗和分身损失，分数保持独立", () => {
  const session = new LocalSession();
  session.start();
  const world = session.world;
  world.bots = [cell("rival", 140)];
  world.bots[0].x = 500;
  world.foods = [];
  world.refillTimer = world.respawnTimer = world.difficultyTimer = -1e6;
  growBall(world.player, 108);
  world.score = 108;
  assert.equal(session.getSnapshot().leaderboard.player.rank, 1);
  session.step(1 / 60, { x: 1, y: 0, sprint: true });
  assert.equal(session.getSnapshot().leaderboard.player.rank, 2);
  assert.ok(Math.abs(session.getSnapshot().leaderboard.player.mass - 144 * .93) < 1e-7);
  assert.equal(world.score, 108);
  world.foods = [{ ...world.player, radius: CONFIG.food.radius }];
  world.consumeFood();
  assert.equal(session.getSnapshot().leaderboard.player.mass, world.player.mass);
  assert.equal(world.score, 109);
  world.player.alive = false;
  assert.equal(session.getSnapshot().leaderboard.player, null);
});
