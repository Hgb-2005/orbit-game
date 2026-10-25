import test from "node:test";
import assert from "node:assert/strict";
import { SoundEffects } from "../static/js/audio/effects.js";
import { CONFIG } from "../static/js/config.js";

/** 用可推进的音频时钟检查触发/回收；实际合成波形另用浏览器离线音频验证。 */
function setup(stored = {}) {
  const values = new Map(Object.entries(stored));
  const oscillators = [];
  const parameter = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime() {}, setValueAtTime() {},
    linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect(target) { this.target = target; }, disconnect() { this.disconnected = true; } });
  const context = {
    currentTime: 0, state: "running", destination: {},
    createGain: () => ({ ...node(), gain: parameter() }),
    createOscillator() {
      const oscillator = { ...node(), frequency: parameter(), start(time) { this.startTime = time; }, stop(time) { this.stopTime = time; } };
      oscillators.push(oscillator);
      return oscillator;
    },
  };
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const effects = new SoundEffects(() => context, () => {}, { storage });
  const advance = seconds => {
    context.currentTime += seconds;
    for (const oscillator of oscillators) {
      if (!oscillator.ended && oscillator.stopTime <= context.currentTime) {
        oscillator.ended = true;
        oscillator.onended?.();
      }
    }
  };
  return { effects, context, storage, values, oscillators, advance };
}
const event = type => [{ type }];

test("准备页、暂停、关闭或设备未运行时无音效，被跳过的事件不补播", () => {
  const { effects, context, oscillators } = setup();
  assert.equal(effects.handleEvents(event("food")), null);
  effects.setGameState("playing");
  context.state = "suspended";
  assert.equal(effects.handleEvents(event("eat")), null);
  context.state = "running";
  assert.equal(effects.handleEvents([]), null);
  effects.setEnabled(false);
  assert.equal(effects.handleEvents(event("split")), null);
  effects.setEnabled(true);
  effects.setGameState("paused");
  assert.equal(effects.handleEvents(event("sprint")), null);
  assert.equal(oscillators.length, 0);
});

test("同帧吞噬或技能优先于食物，每帧只发出一类音效", () => {
  const { effects, advance } = setup();
  effects.setGameState("playing");
  assert.equal(effects.handleEvents([{ type: "food" }, { type: "eat" }, { type: "celllost" }]), "celllost");
  assert.equal(effects.voices.size, 1);
  advance(.3);
  assert.equal(effects.handleEvents([{ type: "food" }, { type: "split" }]), "split");
  assert.equal(effects.voices.size, 1);
});

test("连续进食限制为每 140 毫秒一次，其他音效也遵循最小间隔", () => {
  const { effects, advance } = setup();
  effects.setGameState("playing");
  assert.equal(effects.handleEvents(event("food")), "food");
  advance(.01);
  assert.equal(effects.handleEvents(event("split")), null);
  advance(.04);
  assert.equal(effects.handleEvents(event("split")), "split");
  advance(.05);
  assert.equal(effects.handleEvents(event("food")), null);
  advance(.041);
  assert.equal(effects.handleEvents(event("food")), "food");
});

test("全部六类提示可以触发，音乐开关不参与音效增益路径", () => {
  const { effects, context, advance } = setup({ "orbit.music": "off" });
  effects.setGameState("playing");
  for (const type of ["food", "eat", "split", "merge", "sprint", "celllost"]) {
    assert.equal(effects.handleEvents(event(type)), type);
    assert.equal(effects.master.target, context.destination);
    advance(1);
    assert.equal(effects.voices.size, 0);
  }
});

test("高频事件不突破声部上限，自然结束后断开节点并释放资源", () => {
  const { effects, oscillators, advance } = setup();
  effects.setGameState("playing");
  for (let i = 0; i < 1200; i++) {
    effects.handleEvents(["food", "eat", "merge", "split", "sprint", "celllost"].map(type => ({ type })));
    assert.ok(effects.voices.size <= CONFIG.effects.maxVoices);
    advance(.01);
  }
  advance(1);
  assert.equal(effects.voices.size, 0);
  assert.ok(oscillators.length > 20);
  assert.ok(oscillators.every(oscillator => oscillator.disconnected && oscillator.target.disconnected));
});

test("暂停、结束、关闭和重开都会停止旧声音，重开清除触发冷却", () => {
  for (const stop of [effects => effects.setGameState("paused"), effects => effects.setGameState("gameover"),
    effects => effects.setEnabled(false), effects => effects.setGameState("playing", { restart: true })]) {
    const { effects, oscillators, advance } = setup();
    effects.setGameState("playing");
    effects.handleEvents(event("eat"));
    stop(effects);
    assert.ok(oscillators.every(oscillator => oscillator.stopTime <= .035));
    advance(.04);
    assert.equal(effects.voices.size, 0);
    if (effects.state === "playing" && effects.enabled) assert.equal(effects.handleEvents(event("eat")), "eat");
  }
});

test("音效开关独立记忆，存储或音频不可用也不会阻塞游戏", () => {
  const { effects, values, storage } = setup({ "orbit.music": "off" });
  effects.setEnabled(false);
  assert.equal(values.get("orbit.effects"), "off");
  assert.equal(values.get("orbit.music"), "off");
  assert.equal(new SoundEffects(() => null, () => {}, { storage }).enabled, false);
  effects.storage = { setItem() { throw new Error("denied"); } };
  assert.doesNotThrow(() => effects.setEnabled(true));
  const unavailable = new SoundEffects(() => null, () => {}, { supported: false, storage: null });
  unavailable.setGameState("playing");
  assert.equal(unavailable.handleEvents(event("food")), null);
});
