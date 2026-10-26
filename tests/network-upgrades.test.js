import test from "node:test";
import assert from "node:assert/strict";
import { PositionBuffer } from "../static/js/network/position-buffer.js";
import { RemoteSession } from "../static/js/network/remote-session.js";
import { LocalSession } from "../static/js/session.js";
import { joystickVector, TouchJoystick } from "../static/js/touch-joystick.js";

function remoteSession() {
  const local = new LocalSession().getSnapshot();
  const remote = new RemoteSession(local);
  remote.playerId = "p";
  remote.room = { roundId: "r", state: "playing", members: [] };
  remote.receive({ type: "state", roundId: "r", world: {
    tick: 1, elapsed: 0, duration: 180, bounds: local.bounds, cells: [{ ...local.player, id: "cell-p", ownerId: "p" }],
    players: [{ ownerId: "p", score: 0, eatenBalls: 0, peakMass: 36, killer: "", split: local.split, sprint: local.sprint }],
    standings: [{ ownerId: "p", name: "我", lives: 3, rank: 1, kills: 0, deaths: 0, mass: 36 }],
    events: [], protectionByOwner: {}, hotspots: local.hotspots,
  } });
  remote.step(0, { x: 0, y: 0 });
  remote.sent = [];
  remote.connection = "connected";
  remote.socket = { readyState: 1, bufferedAmount: 0, send: message => remote.sent.push(JSON.parse(message)) };
  return remote;
}

test("食物补丁合并增加、移除和换位，重复版本和旧局数据不会回滚", () => {
  const remote = remoteSession();
  remote.receive({ type: "foods", roundId: "r", version: 2, foods: [{ id: "a", x: 1 }, { id: "b", x: 2 }] });
  const patch = { type: "food_patch", roundId: "r", baseVersion: 2, version: 5,
    removed: ["a"], upsert: [{ id: "b", x: 50 }, { id: "c", x: 3 }] };
  remote.receive(patch); remote.receive(patch);
  remote.receive({ type: "foods", roundId: "old", version: 100, foods: [] });
  remote.receive({ type: "foods", roundId: "r", version: 1, foods: [] });
  assert.deepEqual(remote.foods, [{ id: "b", x: 50 }, { id: "c", x: 3 }]);
  assert.equal(remote.foodVersion, 5);
});

test("缺少食物基线时只请求一次全量恢复，随后继续接收补丁", () => {
  const remote = remoteSession();
  const missing = { type: "food_patch", roundId: "r", baseVersion: 1, version: 2, upsert: [], removed: [] };
  remote.receive(missing); remote.receive(missing);
  assert.deepEqual(remote.sent, [{ type: "resync_foods", roundId: "r" }]);
  remote.receive({ type: "foods", roundId: "r", version: 2, foods: [{ id: "a" }] });
  remote.receive({ ...missing, baseVersion: 2, version: 3, removed: ["a"] });
  assert.deepEqual(remote.foods, []);
  assert.equal(remote.foodVersion, 3);
  assert.equal(remote.foodResyncPending, false);
});

test("技能按下立即发送，长按不产生每帧突发输入，卡顿后只发最新输入", () => {
  const remote = remoteSession();
  remote.sendTimer = 0;
  remote.step(.001, { x: 1, y: 0, split: true });
  assert.equal(remote.sent.length, 1);
  assert.equal(remote.sent[0].split, true);
  remote.step(.001, { x: 1, y: 0, split: true });
  assert.equal(remote.sent.length, 1);
  remote.step(.2, { x: 0, y: 1, split: false });
  assert.equal(remote.sent.length, 2);
  remote.step(.001, { x: 0, y: 1, split: false });
  assert.equal(remote.sent.length, 2);
});

test("团队结算按队伍排名，个人出局仍可随队友获胜，队友球正确标记", () => {
  const remote = remoteSession();
  const world = { ...remote.raw, tick: 2, finished: true, reason: "last-team", rules: { mode: "teams", duration: 180 },
    players: remote.raw.players.map(owner => ({ ...owner, team: 0 })),
    cells: [{ ...remote.raw.cells[0], ownerId: "ally", team: 0 }],
    standings: [{ ...remote.raw.standings[0], lives: 0, eliminated: true, rank: 4 }],
    teams: [{ id: 0, rank: 1, name: "薄荷队", active: 1 }, { id: 1, rank: 2, name: "星云队", active: 0 }] };
  remote.receive({ type: "state", roundId: "r", world });
  const snapshot = remote.getSnapshot();
  assert.equal(snapshot.result.won, true);
  assert.equal(snapshot.result.rank, 1);
  assert.equal(snapshot.result.reason, "last-team");
  assert.equal(snapshot.spectating, true);
  assert.equal(snapshot.bots[0].isAlly, true);
  remote.receive({ type: "state", roundId: "r", world: { ...world, tick: 1, finished: false } });
  assert.equal(remote.state, "gameover");
});

test("恢复窗口失效后回到准备页，停止无效重连", () => {
  const remote = remoteSession();
  remote.resumePending = true;
  let closed = false;
  remote.socket.close = () => { closed = true; };
  remote.receive({ type: "error", code: "resume_expired", message: "恢复窗口已结束" });
  assert.equal(closed, true);
  assert.equal(remote.room, null);
  assert.equal(remote.raw, null);
  assert.equal(remote.state, "ready");
});

test("结算停止推送世界状态后，不会把正常连接误报为延迟较高", () => {
  const remote = remoteSession();
  remote.rtt = 25;
  remote.stateReceivedAt = performance.now() - 5000;
  remote.seq = 100;
  remote.raw.players[0].ack = 2;
  assert.equal(remote.getSnapshot().network.quality, "poor");
  remote.state = "gameover";
  assert.equal(remote.getSnapshot().network.pendingInputs, 0);
  assert.equal(remote.getSnapshot().network.quality, "good");
});

test("对手在两份权威坐标间插值，网络抖动会增加有上限的缓冲", () => {
  const buffer = new PositionBuffer();
  const cell = (x, id = "a") => ({ id, x, y: 30, vx: 200, vy: 0 });
  buffer.push({ elapsed: 0, cells: [cell(0)] }, 0);
  buffer.push({ elapsed: .05, cells: [cell(10)] }, 50);
  buffer.push({ elapsed: .1, cells: [cell(20)] }, 100);
  assert.ok(Math.abs(buffer.sample(cell(20), 125).x - 15) < .00001);
  assert.equal(buffer.delay, .05);
  buffer.push({ elapsed: .15, cells: [cell(30)] }, 250);
  assert.ok(buffer.delay > .05 && buffer.delay <= .13);
  const farFuture = buffer.sample(cell(30), 100000);
  assert.ok(farFuture.x <= 50);
  buffer.push({ elapsed: .05, cells: [cell(-100)] }, 260);
  assert.equal(buffer.frames.at(-1).time, .15);
  assert.deepEqual(buffer.sample(cell(500, "respawn"), 250), { x: 500, y: 30 });
});

test("摇杆保留死区、限制对角速度并在松手或取消时停止，多指不会抢占", () => {
  assert.deepEqual(joystickVector(2, 2), { x: 0, y: 0 });
  assert.equal(Math.hypot(...Object.values(joystickVector(100, 100))), 1);
  assert.ok(joystickVector(20, 0).x > 0 && joystickVector(20, 0).x < 1);
  const element = new EventTarget();
  const thumb = { style: {} };
  const captured = new Set();
  Object.assign(element, { dataset: {}, querySelector: () => thumb,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id) });
  const joystick = new TouchJoystick(element);
  const event = (type, id, x = 90) => element.dispatchEvent(Object.assign(new Event(type, { cancelable: true }),
    { pointerId: id, clientX: x, clientY: 50 }));
  event("pointerdown", 1);
  event("pointerdown", 2, 0);
  assert.equal(joystick.pointerId, 1);
  assert.equal(joystick.vector.x, 1);
  event("pointerup", 2);
  assert.equal(joystick.active, true);
  event("pointercancel", 1);
  assert.equal(joystick.active, false);
  assert.deepEqual(joystick.vector, { x: 0, y: 0 });
  assert.equal(captured.size, 0);
});
