import test from "node:test";
import assert from "node:assert/strict";
import { VisualFeedback } from "../static/js/presentation/feedback.js";

const snapshot = (elapsed, options = {}) => ({ elapsed, state: "playing", sprint: { ready: true }, split: { ready: false },
  hotspots: { cycle: 0, remaining: 45 - elapsed }, ...options });

test("开局不闪亮；技能从不可用变为可用时只提示一次", () => {
  const feedback = new VisualFeedback();
  assert.deepEqual(feedback.update(snapshot(0)).skills, { sprint: false, split: false });
  feedback.update(snapshot(1, { sprint: { ready: false } }));
  let result = feedback.update(snapshot(2, { split: { ready: true } }));
  assert.deepEqual(result.skills, { sprint: true, split: true });
  result = feedback.update(snapshot(2.5, { split: { ready: true } }));
  assert.deepEqual(result.skills, { sprint: true, split: true });
  result = feedback.update(snapshot(3, { split: { ready: true } }));
  assert.deepEqual(result.skills, { sprint: false, split: false });
});

test("暂停冻结提示寿命，继续不会再次提示同一个就绪状态", () => {
  const feedback = new VisualFeedback();
  feedback.update(snapshot(0, { sprint: { ready: false } }));
  feedback.update(snapshot(1));
  const paused = snapshot(1.2, { state: "paused" });
  for (let i = 0; i < 20; i++) assert.equal(feedback.update(paused).skills.sprint, true);
  assert.equal(feedback.update(snapshot(1.3)).skills.sprint, true);
  assert.equal(feedback.update(snapshot(2)).skills.sprint, false);
  feedback.update(snapshot(2, { state: "paused" }));
  assert.equal(feedback.update(snapshot(2.1)).skills.sprint, false);
});

test("再次施放、质量不足、分身上限或结束时及时取消旧就绪提示", () => {
  const feedback = new VisualFeedback();
  feedback.update(snapshot(0));
  assert.equal(feedback.update(snapshot(1, { split: { ready: true } })).skills.split, true);
  assert.equal(feedback.update(snapshot(1.1)).skills.split, false);
  feedback.update(snapshot(2, { sprint: { ready: false } }));
  assert.equal(feedback.update(snapshot(3)).skills.sprint, true);
  assert.equal(feedback.update(snapshot(3, { state: "gameover" })).skills.sprint, false);
});

test("最后五秒出现换位预告，换位后高亮三秒，暂停仍保留高亮", () => {
  const feedback = new VisualFeedback();
  assert.equal(feedback.update(snapshot(39.99)).hotspots.phase, "normal");
  assert.equal(feedback.update(snapshot(40)).hotspots.phase, "warning");
  const relocated = snapshot(45, { hotspots: { cycle: 1, remaining: 45 } });
  assert.equal(feedback.update(relocated).hotspots.phase, "relocated");
  assert.equal(feedback.update({ ...relocated, state: "paused" }).hotspots.highlightRemaining, 3);
  assert.equal(feedback.update(snapshot(47, { hotspots: { cycle: 1, remaining: 43 } })).hotspots.highlightRemaining, 1);
  assert.equal(feedback.update(snapshot(48, { hotspots: { cycle: 1, remaining: 42 } })).hotspots.phase, "normal");
});

test("重新开局清除技能提示和地图高亮，不把新区域当作刚换位", () => {
  const feedback = new VisualFeedback();
  feedback.update(snapshot(0));
  feedback.update(snapshot(45, { hotspots: { cycle: 1, remaining: 45 }, split: { ready: true } }));
  // 时钟回到零也能安全清理，避免未来会话实现遗漏手动 reset。
  const restarted = feedback.update(snapshot(0));
  assert.deepEqual(restarted.skills, { sprint: false, split: false });
  assert.equal(restarted.hotspots.phase, "normal");
  feedback.reset();
  assert.equal(feedback.update(snapshot(1)).hotspots.phase, "normal");
});
