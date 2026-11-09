import {
  CONTROL_ACTION_META,
  formatKeyLabel,
  isBindableKey,
  normalizeKeyboardKey,
} from "./controls.js";

const $ = id => document.getElementById(id);

export function controlHint(snapshot, action, pointerPrefix = "") {
  const keys = snapshot.bindings[action].map(formatKeyLabel).join(" / ");
  return pointerPrefix ? `${pointerPrefix} / ${keys}` : keys;
}

/**
 * 设置面板只编辑本地输入偏好。面板打开时由 main.js 暂停单机对局；
 * 关闭后恢复控制，输入控制器会立即读取同一份设置快照。
 */
export class SettingsUI {
  constructor(settings, {
    onOpen = () => {},
    onClose = () => {},
  } = {}) {
    this.settings = settings;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.dialog = $("settings-dialog");
    this.bindingRoot = $("settings-bindings");
    this.capture = null;
    this.buildBindings();
    this.bind();
    this.unsubscribe = settings.subscribe(snapshot => this.render(snapshot));
    this.render(settings.snapshot);
  }

  buildBindings() {
    const rows = CONTROL_ACTION_META.map(definition => {
      const row = document.createElement("div");
      row.className = "control-binding-row";
      const label = document.createElement("span");
      label.className = "control-binding-label";
      label.textContent = definition.label;
      const keys = document.createElement("span");
      keys.className = "control-binding-keys";
      for (let slot = 0; slot < definition.slots; slot++) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "control-key-button";
        button.dataset.controlAction = definition.id;
        button.dataset.controlSlot = String(slot);
        button.setAttribute("aria-label", `设置${definition.label}${definition.slots > 1 ? `按键 ${slot + 1}` : ""}`);
        keys.append(button);
      }
      row.append(label, keys);
      return row;
    });
    this.bindingRoot.replaceChildren(...rows);
  }

  bind() {
    $("settings-open").addEventListener("click", () => this.open());
    $("settings-close").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", () => {
      this.stopCapture();
      this.onClose();
      $("settings-open").focus({ preventScroll: true });
    });
    this.bindingRoot.addEventListener("click", event => {
      const button = event.target.closest("[data-control-action]");
      if (!button) return;
      this.startCapture(button.dataset.controlAction, Number(button.dataset.controlSlot), button);
    });
    document.addEventListener("keydown", event => this.captureKey(event), true);
    for (const [id, key] of [["settings-dead-zone", "deadZone"], ["settings-touch-sensitivity", "sensitivity"]]) {
      $(id).addEventListener("input", event => {
        this.settings.updateTouch({ [key]: Number(event.target.value) });
      });
    }
    $("settings-reset").addEventListener("click", () => {
      this.settings.reset();
      this.setStatus("按键、死区和触控灵敏度已恢复默认值。", "ok");
    });
  }

  open() {
    if (this.dialog.open) return;
    this.onOpen();
    this.render(this.settings.snapshot);
    this.dialog.showModal();
  }

  startCapture(action, slot, button) {
    this.stopCapture();
    this.capture = { action, slot, button };
    button.dataset.capturing = "true";
    button.textContent = "按键…";
    this.setStatus("请按下新按键；Esc 取消。", "warning");
  }

  stopCapture() {
    if (!this.capture) return;
    this.capture.button.dataset.capturing = "false";
    this.capture = null;
    this.render(this.settings.snapshot);
  }

  captureKey(event) {
    if (!this.capture || !this.dialog.open) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      this.stopCapture();
      this.setStatus("已取消按键修改。", "");
      return;
    }
    const key = normalizeKeyboardKey(event.key);
    if (!isBindableKey(key) || event.ctrlKey || event.altKey || event.metaKey) {
      this.setStatus("方向键、Esc、Tab 和组合键保留给系统或移动，请换一个按键。", "warning");
      return;
    }
    try {
      this.settings.setBinding(this.capture.action, this.capture.slot, key);
      this.stopCapture();
      this.setStatus(`${formatKeyLabel(key)} 已保存，并立即生效。`, "ok");
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  }

  render(snapshot = this.settings.snapshot) {
    if (!this.dialog) return;
    for (const button of this.bindingRoot.querySelectorAll("[data-control-action]")) {
      if (button.dataset.capturing === "true") continue;
      const action = button.dataset.controlAction;
      const slot = Number(button.dataset.controlSlot);
      button.textContent = formatKeyLabel(snapshot.bindings[action]?.[slot]);
    }
    const deadZone = $("settings-dead-zone");
    if (document.activeElement !== deadZone) deadZone.value = String(snapshot.touch.deadZone);
    $("settings-dead-zone-value").textContent = `${snapshot.touch.deadZone} px`;
    const sensitivity = $("settings-touch-sensitivity");
    if (document.activeElement !== sensitivity) sensitivity.value = String(snapshot.touch.sensitivity);
    $("settings-touch-sensitivity-value").textContent = `${snapshot.touch.sensitivity}%`;

    const hints = {
      split: controlHint(snapshot, "split", "右键"),
      spore: controlHint(snapshot, "spore", "左键长按"),
      regroup: `按住 ${controlHint(snapshot, "regroup")}`,
      pause: controlHint(snapshot, "pause"),
      focus: controlHint(snapshot, "focus"),
      restart: controlHint(snapshot, "restart"),
      signalGather: controlHint(snapshot, "signalGather"),
      signalHelp: controlHint(snapshot, "signalHelp"),
      signalDanger: controlHint(snapshot, "signalDanger"),
    };
    for (const node of document.querySelectorAll("[data-control-hint]")) {
      node.textContent = hints[node.dataset.controlHint] || "";
    }
    $("split-button").title = `${hints.split}：朝移动方向分身；最多 8 个，10 秒后可合体。`;
    $("spore-button").title = `${hints.spore}：连续吐孢子；喂刺 5 颗可发射反击刺。`;
    $("regroup-button").title = `${hints.regroup}：向球群中心聚拢；合体冷却仍生效。`;
    $("split-key-hint").textContent = hints.split;
    $("spore-key-hint").textContent = hints.spore;
    $("regroup-key-hint").textContent = formatKeyLabel(snapshot.bindings.regroup[0]);
  }

  setStatus(message, kind = "") {
    const status = $("settings-status");
    status.textContent = message;
    status.dataset.kind = kind;
  }

  dispose() {
    this.unsubscribe?.();
  }
}
