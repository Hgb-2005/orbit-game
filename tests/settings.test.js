import test from "node:test";
import assert from "node:assert/strict";

import {
  ControlSettings,
  DEFAULT_CONTROL_SETTINGS,
  STORAGE_KEY,
  formatKeyLabel,
  isBindableKey,
  normalizeControlSettings,
  normalizeKeyboardKey,
  normalizeTouchSettings,
} from "../static/js/settings/controls.js";
import { ErrorMonitor, describeError } from "../static/js/debug/error-monitor.js";
import { controlHint } from "../static/js/settings/settings-ui.js";
import { joystickVector } from "../static/js/touch-joystick.js";
import { InputController } from "../static/js/input.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test("按键默认值稳定，归一化会拒绝系统键并限制触控参数", () => {
  const defaults = normalizeControlSettings();
  assert.deepEqual(defaults.bindings.split, ["q", "w"]);
  assert.deepEqual(defaults.bindings.spore, ["e"]);
  assert.deepEqual(defaults.touch, { deadZone: 6, sensitivity: 100 });

  assert.equal(normalizeKeyboardKey(" "), "space");
  assert.equal(normalizeKeyboardKey("ArrowUp"), "arrowup");
  assert.equal(formatKeyLabel(" "), "Space");
  assert.equal(formatKeyLabel("f2"), "F2");
  assert.equal(isBindableKey("escape"), false);
  assert.equal(isBindableKey("control"), false);
  assert.equal(isBindableKey("x"), true);
  assert.deepEqual(normalizeTouchSettings({ deadZone: -10, sensitivity: 999 }),
    { deadZone: 2, sensitivity: 150 });
});

test("控制设置会持久化、通知输入层、拒绝冲突并可恢复默认", () => {
  const storage = memoryStorage();
  const settings = new ControlSettings(storage);
  const snapshots = [];
  const unsubscribe = settings.subscribe(snapshot => snapshots.push(snapshot));

  settings.setBinding("split", 1, "X");
  settings.updateTouch({ deadZone: 12, sensitivity: 125 });
  assert.equal(snapshots.length, 2);
  assert.deepEqual(settings.keysFor("split"), ["q", "x"]);
  assert.deepEqual(settings.snapshot.touch, { deadZone: 12, sensitivity: 125 });
  assert.equal(settings.actionForKey("X"), "split");
  assert.throws(() => settings.setBinding("spore", 0, "x"), /已用于「分身」/);
  assert.throws(() => settings.setBinding("pause", 0, "escape"), /不能设为技能键/);

  const restored = new ControlSettings(storage);
  assert.deepEqual(restored.keysFor("split"), ["q", "x"]);
  assert.deepEqual(restored.snapshot.touch, { deadZone: 12, sensitivity: 125 });
  assert.ok(storage.values.has(STORAGE_KEY));

  settings.reset();
  assert.deepEqual(settings.snapshot.bindings.split, [...DEFAULT_CONTROL_SETTINGS.bindings.split]);
  assert.deepEqual(settings.snapshot.touch, { deadZone: 6, sensitivity: 100 });
  unsubscribe();
  settings.updateTouch({ deadZone: 8 });
  assert.equal(snapshots.length, 3);
});

test("损坏或越界的本机设置回退到安全值", () => {
  const malformed = new ControlSettings(memoryStorage({ [STORAGE_KEY]: "{broken" }));
  assert.deepEqual(malformed.keysFor("spore"), ["e"]);
  assert.deepEqual(malformed.snapshot.touch, { deadZone: 6, sensitivity: 100 });

  const partial = memoryStorage({
    [STORAGE_KEY]: JSON.stringify({
      bindings: { split: ["Alt", "x", "q", "w"], spore: [] },
      touch: { deadZone: 999, sensitivity: null },
    }),
  });
  const normalized = new ControlSettings(partial);
  assert.deepEqual(normalized.keysFor("split"), ["x", "q"]);
  assert.deepEqual(normalized.keysFor("spore"), ["e"]);
  assert.deepEqual(normalized.snapshot.touch, { deadZone: 20, sensitivity: 100 });
});

test("自定义技能键立即驱动输入，同时保留固定 WASD 移动", t => {
  const previousWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const canvas = {
    addEventListener(type, callback) { listeners.set(`canvas:${type}`, callback); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    focus() {},
    setPointerCapture() {},
    hasPointerCapture: () => false,
    releasePointerCapture() {},
  };
  const settings = new ControlSettings(null);
  const commands = [];
  const input = new InputController(canvas, null, settings);
  input.onCommand = command => commands.push(command);

  const press = key => {
    const event = { key, target: { tagName: "CANVAS" }, preventDefault() {}, repeat: false };
    listeners.get("keydown")(event);
    return event;
  };
  const release = key => listeners.get("keyup")({ key });

  let event = press("w");
  const movingAndSplitting = input.getInput({ x: 200, y: 150 });
  assert.equal(movingAndSplitting.y, -1);
  assert.equal(movingAndSplitting.split, true);
  release(event.key);

  for (const [action, slot, key] of [
    ["spore", 0, "z"], ["pause", 0, "p"], ["focus", 0, "g"],
    ["restart", 0, "t"], ["signalGather", 0, "4"],
  ]) settings.setBinding(action, slot, key);

  event = press("z");
  const spore = input.getInput({ x: 200, y: 150 });
  assert.equal(spore.spore, true);
  assert.equal(spore.sporeHeld, true);
  release(event.key);
  press("p"); release("p");
  press("g"); release("g");
  press("t"); release("t");
  press("4"); release("4");
  assert.deepEqual(commands, ["pause", "focus", "restart", "signal:gather"]);
});

test("触屏死区和灵敏度可调，默认值保持旧版手感", () => {
  assert.deepEqual(joystickVector(2, 2), { x: 0, y: 0 });
  assert.equal(Math.hypot(...Object.values(joystickVector(100, 100))), 1);

  const deadZone = joystickVector(2, 0, 40, { deadZone: 20, sensitivity: 100 });
  assert.deepEqual(deadZone, { x: 0, y: 0 });
  const justPastDeadZone = joystickVector(20.1, 0, 40, { deadZone: 20, sensitivity: 100 });
  assert.ok(justPastDeadZone.x > 0 && justPastDeadZone.x < .01);
  const normal = joystickVector(25, 0, 40, { deadZone: 6, sensitivity: 100 });
  const sensitive = joystickVector(25, 0, 40, { deadZone: 6, sensitivity: 150 });
  assert.ok(sensitive.x > normal.x);
  assert.ok(sensitive.x <= 1);
});

test("设置面板根据持久化快照生成控制提示", () => {
  const snapshot = normalizeControlSettings({
    bindings: { split: ["q", "x"], spore: ["e"] },
  });
  assert.equal(controlHint(snapshot, "split"), "Q / X");
  assert.equal(controlHint(snapshot, "spore", "左键长按"), "左键长按 / E");
});

test("全局错误监控有界记录异常，并可订阅、清空和释放", () => {
  const target = new EventTarget();
  const monitor = new ErrorMonitor(target, { limit: 3 });
  const snapshots = [];
  monitor.subscribe(errors => snapshots.push(errors));
  for (let index = 0; index < 5; index++) monitor.capture(new Error(`错误 ${index}`), "test");
  assert.equal(monitor.snapshot.length, 3);
  assert.match(monitor.snapshot[0].message, /错误 4/);
  assert.equal(snapshots.length, 5);

  const event = Object.assign(new Event("error", { cancelable: true }), {
    error: new Error("来自 window"),
    filename: "main.js",
  });
  target.dispatchEvent(event);
  assert.match(monitor.snapshot[0].source, /^script:main\.js$/);
  assert.match(describeError({ reason: new Error(" Promise 拒绝 ") }, "promise").message, /Promise 拒绝/);

  monitor.clear();
  assert.equal(monitor.snapshot.length, 0);
  monitor.dispose();
  const eventAfterDispose = Object.assign(new Event("error", { cancelable: true }), {
    error: new Error("释放后不应记录"),
    filename: "main.js",
  });
  target.dispatchEvent(eventAfterDispose);
  assert.equal(monitor.snapshot.length, 0);
});
