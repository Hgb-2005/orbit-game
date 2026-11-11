import test from "node:test";
import assert from "node:assert/strict";

import { stableSeedHash, createSeededRandom } from "../static/js/core/random.js";
import {
  buildDailyChallenge,
  shanghaiDate,
} from "../static/js/challenges/catalog.js";
import { ChallengeTracker } from "../static/js/challenges/daily-run.js";
import { DEFAULT_MAP, normalizeMap } from "../static/js/maps/map-schema.js";
import { LocalSession } from "../static/js/session.js";
import { World } from "../static/js/core/world.js";
import { localMatch } from "../static/js/services/history.js";
import { ChallengeService } from "../static/js/services/challenges.js";

function createContract(goalIds, date = "2026-11-11") {
  const targets = {
    "split-double": 2,
    "spike-launch": 1,
    "no-spike": 1,
    "survive-time": 150,
  };
  return {
    date,
    seed: `orbit:${date}:daily`,
    mode: "daily",
    title: `${date} 每日挑战`,
    rules: { duration: 300, initialLives: 3, botCount: 13, fixedSeed: true },
    goals: goalIds.map((id, index) => ({
      id,
      label: id,
      description: "",
      target: targets[id] ?? 3,
      unit: "次",
      progress: 0,
      state: "active",
      failureReason: "",
      order: index,
    })),
  };
}

function dailySnapshot(overrides = {}) {
  const snapshot = {
    mode: "daily",
    state: "playing",
    elapsed: 0,
    peakMass: 36,
    player: { x: 100, y: 100, mass: 36 },
    hotspots: { zones: [] },
    leaderboard: { player: { rank: 1 } },
    survival: { player: { rank: 1, kills: 0 } },
    stats: { activeSeconds: 0, cellsEaten: 0 },
    result: null,
    challenge: null,
  };
  return { ...snapshot, ...overrides };
}

test("稳定哈希和每日题面与服务端固定样例一致", () => {
  assert.equal(stableSeedHash(""), 2166136261);
  assert.equal(stableSeedHash("orbit:2026-11-11:daily"), 2158827140);

  const first = createSeededRandom("same-seed");
  const second = createSeededRandom("same-seed");
  assert.deepEqual(
    Array.from({ length: 8 }, () => first()),
    Array.from({ length: 8 }, () => second()),
  );

  const contract = buildDailyChallenge("2026-11-11");
  assert.equal(contract.seed, "orbit:2026-11-11:daily");
  assert.deepEqual(
    contract.goals.map(goal => [goal.id, goal.target]),
    [["survive-time", 150], ["eat-three", 3], ["spike-launch", 1]],
  );
});

test("北京时间跨日边界稳定，固定日期题面相同且不同日期会变化", () => {
  assert.equal(shanghaiDate(new Date("2026-01-01T15:59:59.999Z")), "2026-01-01");
  assert.equal(shanghaiDate(new Date("2026-01-01T16:00:00.000Z")), "2026-01-02");

  const first = buildDailyChallenge("2026-11-11");
  const repeated = buildDailyChallenge("2026-11-11");
  const next = buildDailyChallenge("2026-11-12");
  assert.deepEqual(first, repeated);
  assert.notEqual(first.seed, next.seed);
  assert.notDeepEqual(
    first.goals.map(goal => [goal.id, goal.target]),
    next.goals.map(goal => [goal.id, goal.target]),
  );
});

test("每日题面始终恰好三个唯一目标，并排除互斥的扎刺组合", () => {
  for (let day = 1; day <= 31; day++) {
    const contract = buildDailyChallenge(`2026-12-${String(day).padStart(2, "0")}`);
    const ids = contract.goals.map(goal => goal.id);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    assert.equal(ids.includes("spike-launch") && ids.includes("no-spike"), false);
  }
});

test("实时追踪器处理分裂连食、三连、扎刺、反击刺与富集区累计", () => {
  const contract = createContract(["split-double", "no-spike", "hotspot-time"]);
  contract.goals[1].target = 1;
  contract.goals[2].target = 2;
  const tracker = new ChallengeTracker(contract);
  const snapshot = dailySnapshot({
    elapsed: 10,
    hotspots: { zones: [{ x: 100, y: 100, radius: 20 }] },
  });

  tracker.update(snapshot, [{ type: "split" }], 0);
  tracker.update(dailySnapshot({ ...snapshot, elapsed: 11.5 }), [{ type: "eat", combo: 1 }], 0);
  tracker.update(dailySnapshot({ ...snapshot, elapsed: 12 }), [{ type: "eat", combo: 2 }], 0);
  assert.equal(tracker.goal("split-double").state, "completed");

  tracker.update(snapshot, [{ type: "combo", isPlayer: true, count: 3 }], 1.25);
  assert.equal(tracker.hotspotSeconds, 1.25);
  tracker.update(snapshot, [{ type: "spike" }], 0.75);
  assert.equal(tracker.hotspotSeconds, 2);
  assert.equal(tracker.goal("hotspot-time").state, "completed");
  assert.equal(tracker.goal("no-spike").state, "failed");
  assert.match(tracker.goal("no-spike").failureReason, /扎刺/);
  assert.equal(tracker.splitEats, 2);
});

test("反击刺只在玩家成功发射时计数，其他控制者事件不会冒充进度", () => {
  const tracker = new ChallengeTracker(createContract(["spike-launch", "eat-three", "top-three"]));
  const snapshot = dailySnapshot();
  tracker.update(snapshot, [{ type: "spike-launch", actorId: "bot-1" }]);
  assert.equal(tracker.goal("spike-launch").progress, 0);
  tracker.update(snapshot, [{ type: "spike-launch", actorId: "player" }]);
  assert.equal(tracker.goal("spike-launch").state, "completed");
});

test("每日挑战固定种子生成相同布局，并强制使用标准地图", () => {
  const contract = buildDailyChallenge("2026-11-11");
  const customMap = normalizeMap({
    ...DEFAULT_MAP,
    id: "custom-daily-attempt",
    name: "不应进入每日挑战",
    width: 2400,
    height: 1600,
    spawnPoints: [{ id: "spawn-custom", x: 300, y: 300 }],
  });
  const create = () => {
    const session = new LocalSession();
    session.start({ width: 900, height: 650 }, "daily", "split", {
      challenge: contract,
      map: customMap,
    });
    return session.getSnapshot();
  };
  const first = create();
  const repeated = create();

  assert.equal(first.map.id, DEFAULT_MAP.id);
  assert.equal(first.survival.total, 14);
  assert.equal(first.survival.player.lives, 3);
  assert.equal(first.challenge.rules.botCount, 13);
  assert.deepEqual(
    first.foods.slice(0, 40).map(food => [food.x, food.y, food.hotspotId]),
    repeated.foods.slice(0, 40).map(food => [food.x, food.y, food.hotspotId]),
  );
  assert.deepEqual(first.bots.map(bot => [bot.x, bot.y, bot.mass]), repeated.bots.map(bot => [bot.x, bot.y, bot.mass]));
  assert.deepEqual(first.hotspots.zones, repeated.hotspots.zones);
});

test("固定种子不会泄漏到下一局经典模式", () => {
  const ordinaryRandom = () => 0.25;
  const session = new LocalSession();
  session.world.randomSource = ordinaryRandom;
  session.start(undefined, "daily", "split", { challenge: buildDailyChallenge("2026-11-11") });
  assert.notEqual(session.world.random, ordinaryRandom);
  session.start(undefined, "classic");
  assert.equal(session.world.random, ordinaryRandom);
});

test("暂停冻结挑战计时，300 秒到点封盘并生成三项目标和评级", () => {
  const session = new LocalSession();
  session.start(undefined, "daily", "split", { challenge: buildDailyChallenge("2026-11-11") });
  session.pause();
  session.step(40, { x: 0, y: 0 });
  assert.equal(session.world.elapsed, 0);
  assert.equal(session.getSnapshot().challenge.result, null);

  session.resume();
  session.step(300, { x: 0, y: 0 });
  const snapshot = session.getSnapshot();
  assert.equal(session.state, "gameover");
  assert.equal(snapshot.elapsed, 300);
  assert.equal(snapshot.challenge.finalized, true);
  assert.equal(snapshot.challenge.result.elapsed, 300);
  assert.equal(snapshot.challenge.result.goals.length, 3);
  assert.ok(["C", "B", "A", "S"].includes(snapshot.challenge.result.grade));
  const survive = snapshot.challenge.result.goals.find(goal => goal.id === "survive-time");
  assert.equal(survive.state, "completed");
});

test("每日对局不会写入普通最高分历史入口", () => {
  const snapshot = dailySnapshot({ state: "gameover", score: 999 });
  assert.equal(localMatch(snapshot, "local-daily-12345678"), null);
});

test("离线队列保留成绩，过期坏记录会跳过且不会堵住当天成绩", async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  try {
    const values = new Map([[
      "orbit.pending-daily-challenge",
      JSON.stringify([
        { runId: "local-stale-12345678" },
        { runId: "local-today-12345678" },
      ]),
    ]]);
    globalThis.localStorage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    };
    const submitted = [];
    globalThis.fetch = async (_url, options = {}) => {
      const run = JSON.parse(options.body);
      submitted.push(run.runId);
      if (run.runId.startsWith("local-stale")) {
        return new Response(JSON.stringify({ error: "过期挑战" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        saved: true,
        duplicate: false,
        todayBest: 900,
        completionRate: 0,
        bestGrade: "C",
        streak: 1,
        totalRuns: 1,
        recent: [{ runId: run.runId }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const service = new ChallengeService();
    await service.flush();
    assert.deepEqual(submitted, ["local-stale-12345678", "local-today-12345678"]);
    assert.equal(service.pending.length, 0);
    assert.equal(service.status, "saved");
    assert.equal(values.has("orbit.pending-daily-challenge"), false);
    assert.equal(service.summary.todayBest, 900);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});

test("网络失败时每日成绩保留在本地，恢复后仍可补交", async () => {
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  try {
    const values = new Map();
    globalThis.localStorage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    };
    globalThis.fetch = async () => {
      throw new TypeError("offline");
    };
    const service = new ChallengeService();
    service.pending = [{ runId: "local-offline-12345678" }];
    service.remember();
    await service.flush();
    assert.equal(service.status, "offline");
    assert.equal(service.pending.length, 1);
    assert.match(values.get("orbit.pending-daily-challenge"), /local-offline/);

    globalThis.fetch = async () => new Response(JSON.stringify({
      saved: true,
      duplicate: false,
      todayBest: 0,
      completionRate: 0,
      bestGrade: null,
      streak: 1,
      totalRuns: 1,
      recent: [{ runId: "local-offline-12345678" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    await service.flush();
    assert.equal(service.status, "saved");
    assert.equal(service.pending.length, 0);
  } finally {
    globalThis.localStorage = previousStorage;
    globalThis.fetch = previousFetch;
  }
});
