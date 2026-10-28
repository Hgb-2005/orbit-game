import test from "node:test";
import assert from "node:assert/strict";
import { RenderQuality, QUALITY_PRESETS } from "../static/js/presentation/quality.js";
import { ROOM_DEFAULTS, ROOM_PRESETS, isStandardRules, describeRules, presetName } from "../static/js/network/room-rules.js";
import { chooseBotDirection, chooseBotSplit, avoidSpikes } from "../static/js/core/ai.js";
import { createBall } from "../static/js/core/entities.js";
import { LocalSession } from "../static/js/session.js";
import { RemoteSession } from "../static/js/network/remote-session.js";

const sample = (q, cost, seconds) => { for (let i = 0; i < seconds * 60; i++) q.observe(cost, 1 / 60, true); };
test("画质手动档位持久化，存储失败和无效值不影响运行", () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const q = new RenderQuality(storage);
  assert.equal(q.mode, "auto"); assert.equal(q.effective, "balanced");
  q.setMode("smooth"); sample(q, 1, 20); assert.equal(q.effective, "smooth");
  assert.equal(new RenderQuality(storage).mode, "smooth");
  assert.equal(q.setMode("hack"), false); assert.equal(q.mode, "smooth");
  const denied = new RenderQuality({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  assert.equal(denied.setMode("detailed"), true);
});
test("自动画质连续高绘制开销才降档，稳定十五秒后升档", () => {
  const q = new RenderQuality();
  sample(q, 20, 1); assert.equal(q.effective, "balanced");
  sample(q, 20, 2); assert.equal(q.effective, "smooth");
  sample(q, 2, 10); assert.equal(q.effective, "smooth");
  sample(q, 2, 10); assert.equal(q.effective, "balanced");
  sample(q, 2, 20); assert.equal(q.effective, "detailed");
});
test("暂停、无效采样及后台长帧不会导致画质错误降级", () => {
  const q = new RenderQuality();
  for (let i = 0; i < 1000; i++) { q.observe(200, .2, true); q.observe(40, 1 / 60, false); q.observe(NaN, 1 / 60, true); }
  assert.equal(q.effective, "balanced");
  assert.ok(QUALITY_PRESETS.smooth.dpr < QUALITY_PRESETS.detailed.dpr);
  assert.ok(QUALITY_PRESETS.smooth.particles < QUALITY_PRESETS.detailed.particles);
});
test("房间预设支持手动自定义并清楚标注标准与独立纪录", () => {
  assert.equal(isStandardRules(ROOM_DEFAULTS), true);
  assert.equal(isStandardRules({ duration: 180, mode: "teams" }), true);
  for (const id of ["casual", "quick"]) {
    const rules = { ...ROOM_DEFAULTS, ...ROOM_PRESETS[id] };
    assert.equal(presetName(rules), id); assert.equal(isStandardRules(rules), false);
    assert.match(describeRules(rules), /单独记录/);
  }
  assert.equal(presetName({ ...ROOM_DEFAULTS, botCount: 1 }), "custom");
  assert.match(describeRules({ botCount: 3 }, 3), /人机 1 名/);
  assert.match(describeRules({ initialMass: 144 }), /36 m 复活/);
});
const botScene = () => {
  const bot = createBall({ id: "bot", mass: 300, x: 800, y: 550 }); bot.role = "hunter";
  const prey = createBall({ id: "p", mass: 36, x: 950, y: 550, isPlayer: true });
  const world = { playerCells: [prey], bots: [bot], spikes: [], foods: [], bounds: { width: 3200, height: 2200 }, protectionRemaining: 0 };
  return { bot, prey, world };
};
test("单机人机在安全时分裂，有刺球阻挡时取消并绕行", () => {
  const { bot, world } = botScene();
  assert.ok(chooseBotSplit(bot, world));
  world.spikes = [{ x: 940, y: 550, radius: 58 }];
  assert.equal(chooseBotSplit(bot, world), null);
  assert.ok(Math.abs(chooseBotDirection(bot, world).y) > .1);
  assert.deepEqual(avoidSpikes({ ...bot, mass: 36 }, { x: 1, y: 0 }, world.spikes), { x: 1, y: 0 });
});
test("单机人机保护小分身，并在无威胁时主动收拢散开的球群", () => {
  const { bot, prey, world } = botScene();
  world.bots.push(createBall({ id: "small", ownerId: "bot", mass: 36, x: 900, y: 550 }));
  prey.mass = 80;
  assert.ok(chooseBotDirection(bot, world).x < 0);
  prey.x = 2800; prey.y = 1800;
  world.bots[1].x = 1300;
  assert.ok(chooseBotDirection(bot, world).x > 0);
  assert.ok(chooseBotDirection(world.bots[1], world).x < 0);
});
test("休闲人机不主动分裂；挑战档仍使用原质量预算", () => {
  const { bot, world } = botScene();
  world.botDifficulty = "casual"; assert.equal(chooseBotSplit(bot, world), null);
  world.botDifficulty = "challenge"; assert.ok(chooseBotSplit(bot, world));
  assert.equal(bot.mass, 300); assert.equal(bot.alive, true);
});
test("自定义纪录只接受当前回合，不触发标准最高分刷新事件", () => {
  const remote = new RemoteSession(new LocalSession().getSnapshot()); remote.roundId = "r";
  remote.receive({ type: "record_saved", scope: "custom", roundId: "old", record: { high_score: 999 } });
  assert.equal(remote.customRecord, null);
  remote.receive({ type: "record_saved", scope: "custom", roundId: "r", record: { high_score: 321 } });
  assert.equal(remote.customRecord.high_score, 321); assert.deepEqual(remote.events, []);
  remote.receive({ type: "record_saved" }); assert.deepEqual(remote.events, [{ type: "record_saved" }]);
});
