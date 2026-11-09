const STORAGE_KEY = "orbit.controls.v1";
const SCHEMA_VERSION = 1;

export const CONTROL_ACTION_META = Object.freeze([
  { id: "split", label: "分身", slots: 2, mouse: "右键" },
  { id: "spore", label: "吐孢子", slots: 1, mouse: "左键长按" },
  { id: "regroup", label: "聚拢分身", slots: 1 },
  { id: "pause", label: "暂停 / 继续", slots: 1 },
  { id: "focus", label: "专注模式", slots: 1 },
  { id: "restart", label: "重新开始", slots: 1 },
  { id: "signalGather", label: "标点：集合", slots: 1 },
  { id: "signalHelp", label: "标点：支援", slots: 1 },
  { id: "signalDanger", label: "标点：危险", slots: 1 },
]);

const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  bindings: Object.freeze({
    split: Object.freeze(["q", "w"]),
    spore: Object.freeze(["e"]),
    regroup: Object.freeze(["c"]),
    pause: Object.freeze(["space"]),
    focus: Object.freeze(["f"]),
    restart: Object.freeze(["r"]),
    signalGather: Object.freeze(["1"]),
    signalHelp: Object.freeze(["2"]),
    signalDanger: Object.freeze(["3"]),
  }),
  touch: Object.freeze({
    deadZone: 6,
    sensitivity: 100,
  }),
});

const TOUCH_LIMITS = Object.freeze({
  deadZone: [2, 20],
  sensitivity: [50, 150],
});

const UNBINDABLE_KEYS = new Set([
  "alt", "altgraph", "capslock", "control", "meta", "shift", "tab", "escape",
  "arrowup", "arrowdown", "arrowleft", "arrowright",
]);

const KEY_LABELS = Object.freeze({
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
});

function clampWhole(value, fallback, [minimum, maximum]) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

/** KeyboardEvent.key 的展示文本归一化；配置和比较都使用小写稳定值。 */
export function normalizeKeyboardKey(value) {
  const source = typeof value === "string" ? value : "";
  if (!source) return "";
  if (source === " " || source === "Spacebar") return "space";
  const raw = source.trim();
  if (!raw) return "";
  if (raw === "Esc") return "escape";
  if (/^arrow(?:up|down|left|right)$/i.test(raw)) return raw.toLowerCase();
  if (/^f(?:[1-9]|1[0-2])$/i.test(raw)) return raw.toLowerCase();
  if (raw.length === 1) return raw.toLowerCase();
  return raw.toLowerCase().replace(/\s+/g, "");
}

export function formatKeyLabel(key) {
  const normalized = normalizeKeyboardKey(key);
  if (KEY_LABELS[normalized]) return KEY_LABELS[normalized];
  if (/^f(?:[1-9]|1[0-2])$/.test(normalized)) return normalized.toUpperCase();
  if (normalized.length === 1) return normalized.toUpperCase();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "未设置";
}

export function isBindableKey(key) {
  const normalized = normalizeKeyboardKey(key);
  return Boolean(normalized) && normalized.length <= 12 && !UNBINDABLE_KEYS.has(normalized);
}

export function normalizeTouchSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    deadZone: clampWhole(source.deadZone, DEFAULTS.touch.deadZone, TOUCH_LIMITS.deadZone),
    sensitivity: clampWhole(source.sensitivity, DEFAULTS.touch.sensitivity, TOUCH_LIMITS.sensitivity),
  };
}

function normalizeBinding(action, values) {
  const fallback = DEFAULTS.bindings[action];
  const source = Array.isArray(values) ? values : values === undefined ? [] : [values];
  const result = [];
  for (const value of source) {
    const key = normalizeKeyboardKey(value);
    if (isBindableKey(key) && !result.includes(key)) result.push(key);
    if (result.length >= fallback.length) break;
  }
  return result.length ? result : [...fallback];
}

export function normalizeControlSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const sourceBindings = source.bindings && typeof source.bindings === "object" ? source.bindings : {};
  const bindings = {};
  for (const definition of CONTROL_ACTION_META) {
    bindings[definition.id] = normalizeBinding(definition.id, sourceBindings[definition.id]);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    bindings,
    touch: normalizeTouchSettings(source.touch),
  };
}

export function findBindingConflict(bindings, action, slot, key) {
  const targetKey = normalizeKeyboardKey(key);
  for (const definition of CONTROL_ACTION_META) {
    const values = Array.isArray(bindings?.[definition.id]) ? bindings[definition.id] : [];
    for (let index = 0; index < values.length; index++) {
      if (definition.id === action && index === slot) continue;
      if (normalizeKeyboardKey(values[index]) === targetKey) {
        return { action: definition.id, label: definition.label, slot: index };
      }
    }
  }
  return null;
}

function cloneSettings(values) {
  return {
    schemaVersion: values.schemaVersion,
    bindings: Object.fromEntries(Object.entries(values.bindings).map(([action, keys]) => [action, [...keys]])),
    touch: { ...values.touch },
  };
}

function freezeSnapshot(values) {
  const bindings = Object.fromEntries(Object.entries(values.bindings)
    .map(([action, keys]) => [action, Object.freeze([...keys])]));
  return Object.freeze({
    schemaVersion: values.schemaVersion,
    bindings: Object.freeze(bindings),
    touch: Object.freeze({ ...values.touch }),
  });
}

/**
 * 输入偏好独立于世界和网络。设置变更只通知输入控制器，不触发重开或状态同步。
 */
export class ControlSettings {
  constructor(storage = null) {
    this.storage = storage;
    this.listeners = new Set();
    let saved = null;
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch { /* 损坏或禁用存储时使用安全默认值。 */ }
    this.values = normalizeControlSettings(saved);
  }

  get snapshot() {
    return freezeSnapshot(this.values);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  keysFor(action) {
    return [...(this.values.bindings[action] || [])];
  }

  actionForKey(key) {
    const normalized = normalizeKeyboardKey(key);
    for (const definition of CONTROL_ACTION_META) {
      if (this.values.bindings[definition.id].includes(normalized)) return definition.id;
    }
    return null;
  }

  setBinding(action, slot, key) {
    const definition = CONTROL_ACTION_META.find(entry => entry.id === action);
    if (!definition || !Number.isInteger(slot) || slot < 0 || slot >= definition.slots) {
      throw new Error("无效的按键位置");
    }
    const normalized = normalizeKeyboardKey(key);
    if (!isBindableKey(normalized)) throw new Error("方向键、Esc 和修饰键不能设为技能键");
    const conflict = findBindingConflict(this.values.bindings, action, slot, normalized);
    if (conflict) throw new Error(`${formatKeyLabel(normalized)} 已用于「${conflict.label}」`);
    const bindings = Object.fromEntries(Object.entries(this.values.bindings)
      .map(([id, keys]) => [id, [...keys]]));
    bindings[action][slot] = normalized;
    this.values = normalizeControlSettings({ ...this.values, bindings });
    this.commit();
  }

  updateTouch(patch) {
    this.values.touch = normalizeTouchSettings({ ...this.values.touch, ...patch });
    this.commit();
  }

  reset() {
    this.values = normalizeControlSettings(DEFAULTS);
    this.commit();
  }

  commit() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch { /* 本次页面内仍使用新设置。 */ }
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}

export { DEFAULTS as DEFAULT_CONTROL_SETTINGS, SCHEMA_VERSION, STORAGE_KEY };
