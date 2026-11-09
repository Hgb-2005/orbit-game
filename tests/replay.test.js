import test from "node:test";
import assert from "node:assert/strict";
import { ReplayRecorder } from "../static/js/replay/recorder.js";
import { ReplayStorage, MemoryReplayRepository } from "../static/js/replay/storage.js";
import {
  frameIndexAt,
  interpolateReplaySnapshots,
  ReplayPlayer,
  validateRecording,
} from "../static/js/replay/player.js";

const playerCell = (x = 100) => ({
  id: "player-cell", ownerId: "player", name: "我", color: "#9ee7c2",
  isPlayer: true, isAlly: false, team: null, x, y: 120, vx: 0, vy: 0,
  mass: 36, radius: 6, speed: 8, mergeRemaining: 0, alive: true,
});

const snapshot = (elapsed, {
  state = "playing", foods = [{ id: "food-a", x: 10, y: 20, radius: 2, color: "#fff", mass: 1 }],
} = {}) => ({
  state, mode: "classic", elapsed, score: Math.round(elapsed * 10), eatenBalls: 0,
  bounds: { width: 1200, height: 800 }, map: { name: "测试球场" }, obstacles: [],
  player: playerCell(100 + elapsed * 10), playerCells: [playerCell(100 + elapsed * 10)],
  cameraTarget: playerCell(100 + elapsed * 10), bots: [], foods, spores: [], spikes: [],
  sprint: {}, split: {}, spore: {}, hotspots: { zones: [], remaining: 0 },
  leaderboard: { entries: [] }, survival: null, result: null,
});

const recorder = () => new ReplayRecorder({
  sampleSeconds: 0.1, keyframeSeconds: 5, now: () => 1_700_000_000_000,
  idFactory: () => "test",
});

test("回放按 10 Hz 采样，短间隔事件进入下一帧且结算帧不会丢失", () => {
  const replay = recorder();
  replay.start(snapshot(0));
  assert.equal(replay.capture(snapshot(0.05), [{ type: "eat_food", amount: 1 }]), false);
  assert.equal(replay.capture(snapshot(0.1)), true);
  const result = replay.finish(snapshot(0.12, { state: "gameover" }));
  assert.equal(result.frames.length, 3);
  assert.equal(result.frames[1].events[0].type, "eat_food");
  assert.equal(result.frames.at(-1).snapshot.state, "gameover");
  assert.equal(result.completed, true);
  assert.equal(result.duration, 0.12);
});

test("同一时间的最终帧会刷新状态并合并事件", () => {
  const replay = recorder();
  replay.start(snapshot(0));
  replay.capture(snapshot(0.1), [{ type: "split" }]);
  const result = replay.finish(snapshot(0.1, { state: "gameover" }), [{ type: "gameover" }]);
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames.at(-1).snapshot.state, "gameover");
  assert.deepEqual(result.frames.at(-1).events.map(event => event.type), ["split", "gameover"]);
});

test("食物关键帧加增量可以恢复增加、移除和换位", () => {
  const replay = recorder();
  replay.start(snapshot(0, { foods: [
    { id: "a", x: 10, y: 20, radius: 2, color: "#fff", mass: 1 },
    { id: "b", x: 30, y: 40, radius: 2, color: "#aff", mass: 1 },
  ] }));
  replay.capture(snapshot(0.1, { foods: [
    { id: "a", x: 11, y: 20, radius: 2, color: "#fff", mass: 1 },
    { id: "b", x: 30, y: 40, radius: 2, color: "#aff", mass: 1 },
  ] }));
  replay.capture(snapshot(0.2, { foods: [
    { id: "b", x: 30, y: 40, radius: 2, color: "#aff", mass: 1 },
    { id: "c", x: 50, y: 60, radius: 2, color: "#ffc", mass: 1 },
  ] }));
  const result = replay.finish(snapshot(0.3, { state: "gameover", foods: [
    { id: "b", x: 31, y: 40, radius: 2, color: "#aff", mass: 1 },
    { id: "c", x: 50, y: 60, radius: 2, color: "#ffc", mass: 1 },
  ] }));
  const player = new ReplayPlayer(result);
  assert.deepEqual(player.reconstruct(1).foods.map(food => food.id).sort(), ["a", "b"]);
  assert.equal(player.reconstruct(1).foods.find(food => food.id === "a").x, 11);
  assert.deepEqual(player.reconstruct(2).foods.map(food => food.id).sort(), ["b", "c"]);
  assert.equal(player.reconstruct(3).state, "gameover");
});

test("时间轴二分查找、拖动和倍速在同一录像上工作", () => {
  const frames = [{ at: 0 }, { at: 0.1 }, { at: 0.2 }, { at: 0.3 }];
  assert.equal(frameIndexAt(frames, -1), 0);
  assert.equal(frameIndexAt(frames, 0.19), 1);
  assert.equal(frameIndexAt(frames, 0.2), 2);
  assert.equal(frameIndexAt(frames, 99), 3);

  const replay = recorder();
  replay.start(snapshot(0));
  replay.capture(snapshot(0.1));
  replay.capture(snapshot(0.2));
  const recording = replay.finish(snapshot(0.3, { state: "gameover" }));
  const player = new ReplayPlayer(recording);
  player.setSpeed(2);
  player.play();
  player.advance(0.1);
  assert.equal(player.currentTime, 0.2);
  player.seek(99);
  assert.equal(player.currentTime, recording.duration);
  assert.equal(player.playing, true);
  player.advance(0.1);
  assert.equal(player.playing, false);
});

test("位置插值只平滑坐标，权威质量来自最近采样", () => {
  const first = snapshot(0);
  first.playerCells[0].mass = 36;
  first.playerCells[0].x = 0;
  const second = snapshot(0.1);
  second.playerCells[0].mass = 64;
  second.playerCells[0].x = 100;
  const middle = interpolateReplaySnapshots(first, second, 0.5);
  assert.equal(middle.playerCells[0].x, 50);
  assert.equal(middle.playerCells[0].mass, 36);
});

test("录像格式校验拒绝空时间轴和倒序帧", () => {
  assert.throws(() => validateRecording({ kind: "orbit-replay", schemaVersion: 1, frames: [] }), /没有可播放帧/);
  assert.throws(() => validateRecording({
    kind: "orbit-replay", schemaVersion: 1,
    frames: [{ at: 0.2, snapshot: {} }, { at: 0.1, snapshot: {} }],
  }), /时间轴损坏/);
});

test("无 IndexedDB 时降级到内存仓库，损坏记录不会出现在列表中", async () => {
  const fallback = new MemoryReplayRepository();
  const storage = new ReplayStorage({ indexedDBFactory: null, fallback, limit: 2 });
  const replay = recorder();
  replay.start(snapshot(0));
  const recording = replay.finish(snapshot(0.1, { state: "gameover" }));
  await storage.save(recording);
  await fallback.put({ kind: "broken", createdAt: new Date().toISOString() });
  assert.equal(storage.mode, "memory");
  assert.deepEqual((await storage.list()).map(item => item.id), [recording.id]);
  assert.equal(await storage.get(recording.id), recording);
  await storage.delete(recording.id);
  assert.deepEqual(await storage.list(), []);
});
