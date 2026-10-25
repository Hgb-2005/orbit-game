import test from "node:test";
import assert from "node:assert/strict";
import { describeBallLabel, layoutBallLabels, rectanglesOverlap, rectangleHitsCircle } from "../static/js/presentation/labels.js";
import { createBall } from "../static/js/core/entities.js";

const label = (id, x, y, options = {}) => ({ id, x, y, radius: 20, width: 106, height: 18, priority: 3, isPlayer: true, ...options });
function checkLayout(placed, width, height, obstacles = []) {
  for (const [index, current] of placed.entries()) {
    assert.ok(current.rect.left >= 0 && current.rect.right <= width);
    assert.ok(current.rect.top >= 0 && current.rect.bottom <= height);
    assert.ok(!obstacles.some(other => rectanglesOverlap(current.rect, other)));
    for (const other of placed.slice(index + 1)) assert.equal(rectanglesOverlap(current.rect, other.rect), false);
  }
}

test("四个挤在一起的玩家标签错开，仍能指向各自分身", () => {
  const labels = [label("p1", 390, 280), label("p2", 420, 280), label("p3", 390, 310), label("p4", 420, 310)];
  const circles = labels.map(({ x, y, radius }) => ({ x, y, radius }));
  const placed = layoutBallLabels(labels, { width: 800, height: 600, circles });
  assert.equal(placed.length, 4);
  checkLayout(placed, 800, 600);
  assert.ok(placed.every(item => !circles.some(circle => rectangleHitsCircle(item.rect, circle))));
  assert.ok(placed.some(item => item.linked));
  for (const item of placed) assert.deepEqual(item.anchor, { x: labels.find(l => l.id === item.id).x, y: labels.find(l => l.id === item.id).y });
});

test("窄屏和地图边缘的标签留在画布内，并避开排行榜、技能面板和小地图", () => {
  const obstacles = [{ left: 160, right: 292, top: 75, bottom: 255 }, { left: 6, right: 150, top: 450, bottom: 590 },
    { left: 175, right: 295, top: 500, bottom: 590 }];
  const labels = [label("p1", 18, 22), label("p2", 280, 20), label("p3", 130, 300), label("p4", 150, 320)];
  const placed = layoutBallLabels(labels, { width: 300, height: 600, circles: labels, obstacles });
  assert.equal(placed.length, 4);
  checkLayout(placed, 300, 600, obstacles);
});

test("拥挤时玩家优先，低优先级 AI 可隐藏；输入顺序改变不会打乱布局", () => {
  const labels = [label("ai", 150, 40, { priority: 1, isPlayer: false }), label("player", 150, 40)];
  const a = layoutBallLabels(labels, { width: 300, height: 80 });
  const b = layoutBallLabels([...labels].reverse(), { width: 300, height: 80 });
  assert.deepEqual(a, b);
  assert.equal(a[0].id, "player");
  checkLayout(a, 300, 80);
  const packed = layoutBallLabels(Array.from({ length: 20 }, (_, i) => label(`ai-${i}`, 150, 40, { priority: 1, isPlayer: false })), { width: 150, height: 40 });
  assert.ok(packed.length < 20);
  checkLayout(packed, 150, 40);
});

test("大球覆盖视野时优先显示玩家质量，仍不遮盖其他标签或 HUD", () => {
  const labels = [label("p1", 150, 150, { radius: 500 }), label("p2", 150, 150, { radius: 500 })];
  const placed = layoutBallLabels(labels, { width: 300, height: 300, circles: labels });
  assert.equal(placed.length, 2);
  checkLayout(placed, 300, 300);
});

test("只有拉远后的远处 AI 简化标签，玩家和附近危险对象保留信息", () => {
  const player = createBall({ id: "player", x: 100, y: 100, mass: 72, isPlayer: true });
  const near = createBall({ id: "near", x: 200, y: 100, mass: 150 });
  const far = createBall({ id: "far", x: 1000, y: 100, mass: 150 });
  const snapshot = { playerCells: [player] };
  assert.equal(describeBallLabel(far, snapshot, .4).text, "150 m");
  assert.match(describeBallLabel(near, snapshot, .4).text, /注意避开/);
  assert.match(describeBallLabel(far, snapshot, .8).text, /注意避开/);
  assert.match(describeBallLabel(player, snapshot, .4).text, /你的小球/);
  assert.equal(describeBallLabel(near, snapshot, .4).priority, 2);
});
