import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundMusic } from "../static/js/audio/music.js";

/** 这里只替代浏览器音频/时钟，测试播放意图、资源释放和异步解锁竞争。 */
function setup({ stored = {}, resume } = {}) {
  const values = new Map(Object.entries(stored));
  const timers = new Map();
  const oscillators = [];
  let contextsCreated = 0;
  let timerId = 0;
  const parameter = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime(value) { this.value = value; },
    setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect() {}, disconnect() { this.disconnected = true; } });
  const context = {
    state: "suspended", currentTime: 0, destination: {},
    createGain: () => ({ ...node(), gain: parameter() }),
    createBiquadFilter: () => ({ ...node(), frequency: parameter(), Q: parameter() }),
    createDelay: () => ({ ...node(), delayTime: parameter() }),
    createOscillator() {
      const oscillator = { ...node(), frequency: parameter(), start(time) { this.startTime = time; }, stop(time) { this.stopTime = time; } };
      oscillators.push(oscillator);
      return oscillator;
    },
    resume() {
      if (resume) return resume(context);
      this.state = "running";
      return Promise.resolve();
    },
    close() { this.state = "closed"; return Promise.resolve(); },
  };
  const options = {
    createContext: () => { contextsCreated++; return context; },
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    setTimer: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id),
  };
  const music = new BackgroundMusic(() => {}, options);
  const advance = seconds => {
    context.currentTime += seconds;
    for (const oscillator of oscillators) {
      if (!oscillator.ended && oscillator.stopTime <= context.currentTime) {
        oscillator.ended = true;
        oscillator.onended?.();
      }
    }
    for (const callback of timers.values()) callback();
  };
  return { music, context, values, timers, oscillators, advance, contextsCreated: () => contextsCreated };
}

test("首页保持安静，开始游戏的用户操作后才创建音频并播放", async () => {
  const { music, timers, contextsCreated } = setup();
  assert.equal(music.getSnapshot().enabled, true);
  assert.equal(await music.unlock(), false);
  assert.equal(contextsCreated(), 0);
  music.setGameState("playing");
  assert.equal(timers.size, 0);
  await music.unlock();
  assert.equal(contextsCreated(), 1);
  assert.equal(timers.size, 1);
  assert.equal(music.getSnapshot().playing, true);
});

test("重复开始、恢复和调音量不会叠加播放循环或创建多份 AudioContext", async () => {
  const { music, timers, contextsCreated } = setup();
  music.setGameState("playing");
  await Promise.all([music.unlock(), music.unlock(), music.unlock()]);
  for (let i = 0; i < 10; i++) {
    music.setGameState("playing");
    music.setVolume(i / 10 + .05);
    await music.unlock();
  }
  assert.equal(timers.size, 1);
  assert.equal(contextsCreated(), 1);
  music.dispose();
  assert.equal(timers.size, 0);
});

test("暂停或游戏结束会淡出、停止排音符，继续游戏后恢复且不重置旋律", async () => {
  const { music, timers, advance } = setup();
  music.setGameState("playing");
  await music.unlock();
  const phase = music.stepIndex;
  music.setGameState("paused");
  assert.equal(timers.size, 0);
  assert.equal(music.master.gain.value, 0);
  advance(20);
  assert.equal(music.stepIndex, phase);
  assert.equal(music.voices.size, 0);
  music.setGameState("playing");
  assert.equal(timers.size, 1);
  assert.ok(music.stepIndex > phase);
  music.setGameState("gameover");
  assert.equal(timers.size, 0);
  assert.equal(music.getSnapshot().playing, false);
});

test("音频解锁尚未返回时暂停或关闭音乐，不会被异步结果重新打开", async () => {
  for (const operation of [music => music.setEnabled(false), music => music.setGameState("paused"), music => music.setVolume(0)]) {
    let resolveResume;
    const { music, context, timers } = setup({ resume: () => new Promise(resolve => { resolveResume = resolve; }) });
    music.setGameState("playing");
    const pending = music.unlock();
    operation(music);
    context.state = "running";
    resolveResume();
    assert.equal(await pending, false);
    assert.equal(timers.size, 0);
    assert.equal(music.getSnapshot().playing, false);
  }
});

test("音乐开关和音量记忆到本地，音量为零时暂停排音符", async () => {
  const { music, values, timers } = setup();
  music.setEnabled(false);
  music.setVolume(.18);
  assert.equal(values.get("orbit.music"), "off");
  assert.equal(values.get("orbit.music-volume"), "0.18");
  const restored = setup({ stored: Object.fromEntries(values) }).music;
  assert.equal(restored.enabled, false);
  assert.equal(restored.volume, .18);
  music.setGameState("playing");
  assert.equal(await music.unlock(), false);
  music.setEnabled(true);
  await music.unlock();
  assert.equal(timers.size, 1);
  music.setVolume(0);
  assert.equal(timers.size, 0);
  assert.equal(music.enabled, true);
  music.setVolume(.2);
  assert.equal(timers.size, 1);
});

test("浏览器拒绝解锁时游戏不报错，下一次用户操作仍能恢复音乐", async () => {
  let blocked = true;
  const { music } = setup({ resume: context => {
    if (blocked) return Promise.reject(new Error("gesture required"));
    context.state = "running";
    return Promise.resolve();
  } });
  music.setGameState("playing");
  assert.equal(await music.unlock(), false);
  assert.equal(music.getSnapshot().blocked, true);
  blocked = false;
  assert.equal(await music.unlock(), true);
  assert.equal(music.getSnapshot().playing, true);
});

test("关闭或不支持音频时仍可正常游戏，本地存储失败也不影响音乐", async () => {
  const unavailable = new BackgroundMusic(() => {}, { createContext: null, storage: null });
  unavailable.setGameState("playing");
  assert.equal(await unavailable.unlock(), false);
  assert.equal(unavailable.getSnapshot().supported, false);
  const { music } = setup();
  music.storage = { setItem() { throw new Error("storage disabled"); } };
  music.setVolume(.4);
  music.setEnabled(true);
  music.setGameState("playing");
  assert.equal(await music.unlock(), true);
});

test("连续播放后音符会释放，后台节流恢复不会密集补播", async () => {
  const { music, oscillators, advance } = setup();
  music.setGameState("playing");
  await music.unlock();
  for (let i = 0; i < 2400; i++) {
    advance(.05);
    assert.ok(music.voices.size < 20);
  }
  assert.ok(oscillators.some(oscillator => oscillator.disconnected));
  const before = oscillators.length;
  advance(3600);
  assert.ok(oscillators.length - before <= 5);
  music.dispose();
});

test("重新开局从第一小节重新播放，已关闭音乐的选择不会被重开覆盖", async () => {
  const { music, advance, timers } = setup();
  music.setGameState("playing");
  await music.unlock();
  advance(.8);
  assert.ok(music.stepIndex > 1);
  music.setGameState("playing", { restart: true });
  assert.equal(music.stepIndex, 1);
  assert.equal(timers.size, 1);
  music.setEnabled(false);
  music.setGameState("playing", { restart: true });
  assert.equal(music.stepIndex, 0);
  assert.equal(music.enabled, false);
  assert.equal(timers.size, 0);
});

test("音乐关闭或音量为零时可为音效解锁共用设备，音乐保持停止", async () => {
  for (const stored of [{ "orbit.music": "off" }, { "orbit.music-volume": "0" }]) {
    const { music, context, timers, contextsCreated } = setup({ stored });
    music.setGameState("playing");
    await music.unlock({ force: true });
    assert.equal(context.state, "running");
    assert.equal(contextsCreated(), 1);
    assert.equal(timers.size, 0);
    assert.equal(music.getSnapshot().playing, false);
    assert.equal(music.voices.size, 0);
  }
});
