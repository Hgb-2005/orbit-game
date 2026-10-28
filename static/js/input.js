import { TouchJoystick } from "./touch-joystick.js";

/** 输入统一转换成 [-1, 1] 的方向向量，与网络和物理更新无关。 */
export class InputController {
  constructor(canvas, joystickElement = null) {
    this.canvas = canvas;
    this.pointer = null;
    this.keys = new Set();
    this.mode = "pointer";
    this.sporeQueued = false;
    this.sporePointers = new Set();
    this.buttonSporeHeld = false;
    this.buttonRegroupHeld = false;
    this.splitQueued = false;
    this.onCommand = () => {};
    this.onSkillAttempt = () => {};
    this.onArenaPointer = () => false;
    this.joystick = joystickElement ? new TouchJoystick(joystickElement, () => {
      this.mode = "joystick"; this.pointer = null;
    }) : null;

    canvas.addEventListener("pointermove", event => {
      if (this.joystick?.active) return;
      const rect = canvas.getBoundingClientRect();
      this.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.mode = "pointer";
    });
    canvas.addEventListener("pointerdown", event => {
      if (this.onArenaPointer(event)) { event.preventDefault(); return; }
      if (this.joystick?.active) return;
      const rect = canvas.getBoundingClientRect();
      this.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.mode = "pointer";
      // 脉冲保留两帧之间的短按；持有状态让规则层按冷却连续吐孢子。
      if (event.pointerType === "mouse" && event.button === 0) {
        this.requestSpore();
        this.sporePointers.add(event.pointerId);
      }
      if (event.pointerType === "mouse" && event.button === 2) {
        event.preventDefault();
        this.requestSplit();
      }
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
    });
    // 右键技能不应弹出浏览器的原生菜单，也避免菜单打断联机输入。
    canvas.addEventListener("contextmenu", event => event.preventDefault());
    canvas.addEventListener("pointerleave", event => {
      if (!canvas.hasPointerCapture(event.pointerId)) this.pointer = null;
    });
    for (const eventName of ["pointerup", "pointercancel"]) {
      canvas.addEventListener(eventName, event => {
        if (eventName === "pointercancel" || event.button === 0) this.sporePointers.delete(event.pointerId);
        if (event.pointerType !== "mouse") this.pointer = null;
        if (!(event.buttons & 1) && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      });
    }
    canvas.addEventListener("lostpointercapture", event => this.sporePointers.delete(event.pointerId));
    const movementKeys = ["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"];
    window.addEventListener("keydown", event => {
      if (event.target.closest?.('dialog[open]')) return;
      if (event.ctrlKey || event.altKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      const key = event.key.toLowerCase();
      if (movementKeys.includes(key)) {
        event.preventDefault();
        this.keys.add(key);
        this.mode = "keyboard";
      }
      if (key === "e") {
        event.preventDefault();
        this.keys.add("e");
        if (!event.repeat) this.requestSpore();
      }
      if (key === "q") {
        event.preventDefault();
        this.keys.add("q");
        if (!event.repeat) this.requestSplit();
      }
      if (key === "c") { event.preventDefault(); this.keys.add("c"); }
      if (event.repeat) return;
      if (['1', '2', '3'].includes(key)) this.onCommand(`signal:${['gather', 'help', 'danger'][Number(key) - 1]}`);
      // 按钮保留空格键原生行为，避免点击后又被全局快捷键暂停。
      if ((key === " " || key === "escape") && !["BUTTON", "SUMMARY"].includes(event.target.tagName)) {
        event.preventDefault();
        this.onCommand(key === 'escape' ? 'escape' : 'pause');
      }
      if (key === "r") this.onCommand("restart");
      if (key === "f") {
        event.preventDefault();
        this.onCommand("focus");
      }
    });
    window.addEventListener("keyup", event => this.keys.delete(event.key.toLowerCase()));
    window.addEventListener("blur", () => this.reset());
  }

  reset() {
    this.pointer = null;
    this.keys.clear();
    this.sporeQueued = false;
    this.sporePointers.clear();
    this.buttonSporeHeld = false;
    this.buttonRegroupHeld = false;
    this.splitQueued = false;
    this.joystick?.reset();
  }

  requestSplit() {
    this.onSkillAttempt('split');
    this.splitQueued = true;
  }

  requestSpore() {
    this.onSkillAttempt('spore');
    this.sporeQueued = true;
  }

  setSporeHeld(held) {
    if (held && !this.buttonSporeHeld) this.requestSpore();
    this.buttonSporeHeld = held;
  }

  setRegroupHeld(held) { this.buttonRegroupHeld = held; }

  getInput(screenPosition, view) {
    const aim = this.getAim(screenPosition, view);
    const split = this.keys.has("q") || this.splitQueued;
    const spore = this.sporeQueued;
    const sporeHeld = this.buttonSporeHeld || this.sporePointers.size > 0 || this.keys.has("e");
    this.sporeQueued = false;
    this.splitQueued = false;
    const regroup = this.buttonRegroupHeld || this.keys.has("c");
    const pan = this.mode === 'keyboard' || this.mode === 'joystick' ? aim : { x: 0, y: 0 };
    return { ...aim, sprint: false, split, spore, sporeHeld, regroup, view, panX: pan.x, panY: pan.y };
  }

  /** 绘制预览可以读取瞄准，不消费等待发送的技能脉冲。 */
  getAim(screenPosition, view) {
    let target = null;
    if (this.mode === "pointer" && this.pointer && view) {
      const rect = this.canvas.getBoundingClientRect();
      target = {
        x: view.left + this.pointer.x / rect.width * (view.right - view.left),
        y: view.top + this.pointer.y / rect.height * (view.bottom - view.top),
      };
    }
    return { ...this.getDirection(screenPosition), target };
  }

  getDirection(screenPosition) {
    if (this.joystick?.active) return { ...this.joystick.vector };
    if (this.mode === "joystick") return { x: 0, y: 0 };
    if (this.mode === "keyboard") {
      const x = Number(this.keys.has("d") || this.keys.has("arrowright")) - Number(this.keys.has("a") || this.keys.has("arrowleft"));
      const y = Number(this.keys.has("s") || this.keys.has("arrowdown")) - Number(this.keys.has("w") || this.keys.has("arrowup"));
      const length = Math.hypot(x, y) || 1;
      return { x: x / length, y: y / length };
    }
    if (!this.pointer) return { x: 0, y: 0 };
    const dx = this.pointer.x - screenPosition.x;
    const dy = this.pointer.y - screenPosition.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 5) return { x: 0, y: 0 };
    const strength = Math.min(1, (distance - 5) / 75);
    return { x: dx / distance * strength, y: dy / distance * strength };
  }
}
