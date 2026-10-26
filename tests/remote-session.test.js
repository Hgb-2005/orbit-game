import test from "node:test";
import assert from "node:assert/strict";
import { RemoteSession } from "../static/js/network/remote-session.js";
import { LocalSession } from "../static/js/session.js";
import { createBall } from "../static/js/core/entities.js";
import { Sprint } from "../static/js/core/sprint.js";
import { SplitAbility } from "../static/js/core/cells.js";

function state(events = []) {
  const cells = ["p", "q"].map((id, index) => createBall({ id: `cell-${id}`, ownerId: id,
    name: id, color: "#b4efcc", x: 800 + index * 1600, y: 1100, mass: 36 }));
  const entries = cells.map(cell => ({ ownerId: cell.ownerId, name: cell.name, color: cell.color,
    lives: 3, kills: 0, deaths: 0, mass: 36, cells: 1, rank: 1, eliminated: false }));
  const players = cells.map(cell => ({ ownerId: cell.ownerId, score: 0, eatenBalls: 0, peakMass: 36, killer: "",
    sprint: new Sprint().getSnapshot([cell]), split: new SplitAbility().getSnapshot([cell]) }));
  return { type: "state", roundId: "r1", world: {
    tick: 0, elapsed: 0, duration: 300, bounds: { width: 3200, height: 2200 },
    cells, players, standings: entries, events, finished: false, reason: null,
    hotspots: { zones: [], remaining: 45, duration: 45, cycle: 0 }, protectionByOwner: { p: 3, q: 3 },
  } };
}

function session() {
  const remote = new RemoteSession(new LocalSession().getSnapshot());
  remote.playerId = "p";
  remote.room = { roundId: "r1", state: "playing", members: [] };
  remote.receive(state());
  remote.step(0, { x: 0, y: 0 });
  return remote;
}

test("快照按本连接身份区分自己和对手，客户端输入不能改变质量、生命或分数", () => {
  const remote = session();
  const sent = [];
  remote.connection = "connected";
  remote.socket = { readyState: 1, bufferedAmount: 0, send: data => sent.push(JSON.parse(data)) };
  remote.step(.05, { x: 1, y: 0, sprint: true, score: 999, lives: 99, mass: 1e9 });
  const snapshot = remote.getSnapshot();
  assert.equal(snapshot.playerCells[0].ownerId, "p");
  assert.equal(snapshot.bots[0].ownerId, "q");
  assert.equal(snapshot.player.mass, 36); assert.equal(snapshot.score, 0); assert.equal(snapshot.survival.player.lives, 3);
  assert.equal(sent[0].type, "input"); assert.equal(sent[0].roundId, "r1");
  assert.equal(sent[0].score, undefined); assert.equal(sent[0].mass, undefined);
});

test("发送周期内的短技能输入会保留到下一次发包", () => {
  const remote = session();
  const sent = [];
  remote.connection = "connected";
  remote.socket = { readyState: 1, bufferedAmount: 200 * 1024, send: data => sent.push(JSON.parse(data)) };
  remote.sendTimer = 0;
  remote.step(.01, { x: 1, y: 0, split: true });
  assert.equal(sent.length, 0);
  remote.socket.bufferedAmount = 0;
  remote.step(.04, { x: 1, y: 0, split: false });
  assert.equal(sent[0].split, true);
  remote.step(.05, { x: 1, y: 0, split: false });
  assert.equal(sent[1].split, false);
});

test("事件按 ID 只消费一次，只显示自己的技能与死亡提示；所有人的食物消费同步移除", () => {
  const remote = session();
  remote.receive({ type: "foods", roundId: "r1", foods: [{ id: "f1" }, { id: "f2" }] });
  const message = state([
    { id: 1, type: "food", ownerId: "q", foodId: "f1" },
    { id: 2, type: "split", ownerId: "q" },
    { id: 3, type: "respawn", ownerId: "p", lives: 2 },
    { id: 4, type: "hotspots" },
  ]);
  remote.receive(message);
  assert.deepEqual(remote.getSnapshot().foods.map(food => food.id), ["f2"]);
  const events = remote.step(0, { x: 0, y: 0 });
  assert.deepEqual(events.map(event => event.type), ["respawn", "hotspots"]);
  assert.equal(events[0].isPlayer, true);
  remote.receive(message);
  assert.deepEqual(remote.step(0, { x: 0, y: 0 }), []);
});

test("位置平滑不改原始快照；复活新球立即定位，过期对局数据被忽略", () => {
  const remote = session();
  const message = state();
  message.world.cells[0].x = 900;
  remote.receive(message);
  remote.step(.016, { x: 0, y: 0 });
  assert.ok(remote.getSnapshot().player.x > 800 && remote.getSnapshot().player.x < 900);
  assert.equal(message.world.cells[0].x, 900);
  const old = state(); old.roundId = "old"; old.world.cells[0].mass = 1000;
  remote.receive(old); assert.equal(remote.getSnapshot().player.mass, 36);
  const respawn = state(); respawn.world.cells[0].id = "new-life"; respawn.world.cells[0].x = 2500;
  remote.receive(respawn); assert.equal(remote.getSnapshot().player.x, 2500);
});

test("出局后仍收到房间状态并观战，统一结束时才结算", () => {
  const remote = session();
  const message = state();
  message.world.cells = message.world.cells.filter(cell => cell.ownerId !== "p");
  message.world.standings[0].lives = 0; message.world.standings[0].eliminated = true;
  remote.receive(message);
  assert.equal(remote.getSnapshot().spectating, true); assert.equal(remote.state, "playing");
  assert.equal(remote.getSnapshot().playerCells.length, 0);
  message.world.finished = true; message.world.reason = "timeout"; message.world.elapsed = 300;
  remote.receive(message);
  assert.equal(remote.state, "gameover"); assert.equal(remote.getSnapshot().result.reason, "eliminated");
  assert.equal(remote.getSnapshot().result.won, false);
});

test("返回准备室清除旧局状态、插值和事件，不把下一局当作续局", () => {
  const remote = session();
  remote.receive({ type: "room", roundId: "r1", state: "waiting", members: [] });
  assert.equal(remote.state, "ready"); assert.equal(remote.raw, null); assert.equal(remote.positions.size, 0);
  remote.receive({ type: "room", roundId: "r2", state: "playing", members: [] });
  const next = state(); next.roundId = "r2";
  remote.receive(next);
  assert.equal(remote.getSnapshot().survival.player.lives, 3);
  assert.equal(remote.step(0, { x: 0, y: 0 })[0].type, "networkstart");
});

test("真实连接建立以 welcome 为准，断线回到可重建房间的状态", async t => {
  const previousLocation = globalThis.location;
  globalThis.location = { protocol: "http:", host: "localhost:5000" };
  t.after(() => { if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation; });
  const handlers = new Map();
  const socket = { readyState: 1, bufferedAmount: 0, addEventListener: (type, callback) => handlers.set(type, callback), close: () => handlers.get("close")() };
  const remote = new RemoteSession(new LocalSession().getSnapshot(), () => {}, () => socket);
  const connected = remote.connect();
  handlers.get("message")({ data: JSON.stringify({ type: "welcome", playerId: "p", protocol: 1 }) });
  await connected;
  assert.equal(remote.connection, "connected");
  socket.close();
  assert.equal(remote.connection, "disconnected"); assert.equal(remote.state, "ready"); assert.equal(remote.room, null);
});

test("断线后保留房间并使用旧 token 恢复原玩家身份", async t => {
  const previousLocation = globalThis.location;
  globalThis.location = { protocol: "http:", host: "localhost:5000" };
  t.after(() => { if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation; });
  const sockets = [];
  const createSocket = () => {
    const handlers = new Map();
    const socket = {
      readyState: 1, bufferedAmount: 0, sent: [],
      addEventListener: (type, callback) => handlers.set(type, callback),
      send: data => socket.sent.push(JSON.parse(data)),
      close: () => { socket.readyState = 3; handlers.get("close")?.(); },
      emit: (type, value) => handlers.get(type)?.(value),
    };
    sockets.push(socket);
    return socket;
  };
  const remote = new RemoteSession(new LocalSession().getSnapshot(), () => {}, createSocket);
  const firstConnection = remote.connect();
  sockets[0].emit("message", { data: JSON.stringify({ type: "welcome", playerId: "old-player", resumeToken: "resume-1", protocol: 1 }) });
  await firstConnection;
  remote.receive({ type: "room", code: "123456", hostId: "old-player", state: "playing", roundId: "round-1", members: [] });
  // 缩短测试等待，并保留真实 scheduleReconnect 的异步路径。
  remote.scheduleReconnect = () => { remote.reconnectPromise = remote.connect({ resume: true }); };
  sockets[0].close();
  assert.equal(remote.connection, "reconnecting");
  assert.equal(remote.room.code, "123456");
  await Promise.resolve();
  assert.equal(sockets.length, 2);
  sockets[1].emit("message", { data: JSON.stringify({ type: "welcome", playerId: "new-connection", resumeToken: "wrong-new-token", protocol: 1 }) });
  assert.deepEqual(sockets[1].sent, [{ type: "resume", token: "resume-1" }]);
  sockets[1].emit("message", { data: JSON.stringify({ type: "resumed", playerId: "old-player", roundId: "round-1" }) });
  await remote.reconnectPromise;
  assert.equal(remote.connection, "connected");
  assert.equal(remote.playerId, "old-player");
  assert.equal(remote.resumeToken, "resume-1");
  assert.deepEqual(remote.step(0, { x: 0, y: 0 }).map(event => event.type), ["networkresume"]);
  remote.close();
});

test("排行变化保留升降方向，并暴露快照同步年龄与待确认输入", () => {
  const remote = session();
  remote.connection = "connected";
  remote.socket = { readyState: 1, bufferedAmount: 0, send() {} };
  const initial = state();
  initial.world.standings[0].rank = 2;
  initial.world.standings[1].rank = 1;
  remote.receive(initial);
  const changed = state();
  changed.world.players[0].ack = 0;
  changed.world.standings[0].rank = 1;
  changed.world.standings[1].rank = 2;
  remote.receive(changed);
  const snapshot = remote.getSnapshot();
  assert.equal(snapshot.leaderboard.entries[0].movement, 1);
  assert.equal(snapshot.leaderboard.entries[1].movement, -1);
  assert.equal(snapshot.network.pendingInputs, 0);
  assert.ok(snapshot.network.stateAge >= 0);
});

test("收到服务器保存完成通知后才触发记录刷新事件", () => {
  const remote = session();
  remote.receive({ type: "record_saved" });
  assert.deepEqual(remote.step(0, { x: 0, y: 0 }), [{ type: "record_saved" }]);
  assert.deepEqual(remote.step(0, { x: 0, y: 0 }), []);
});
