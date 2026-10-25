/** 输入统一转换成 [-1, 1] 的方向向量，与网络和物理更新无关。 */
export class InputController {
  constructor(canvas) {
    this.canvas = canvas;
    this.pointer = null;
    this.keys = new Set();
    this.mode = "pointer";
    this.sporeQueued = false;
    this.splitQueued = false;
    this.onCommand = () => {};

    canvas.addEventListener("pointermove", event => {
      const rect = canvas.getBoundingClientRect();
      this.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.mode = "pointer";
    });
    canvas.addEventListener("pointerdown", event => {
      const rect = canvas.getBoundingClientRect();
      this.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.mode = "pointer";
      // 鼠标左右键是技能的一次性触发；移动和技能仍共用同一套输入快照，
      // 所以单机、联机和触摸按钮不会出现不同的判定逻辑。
      if (event.pointerType === "mouse" && event.button === 0) this.sporeQueued = true;
      if (event.pointerType === "mouse" && event.button === 2) {
        event.preventDefault();
        this.splitQueued = true;
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
        if (event.pointerType !== "mouse") this.pointer = null;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      });
    }
    const movementKeys = ["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"];
    window.addEventListener("keydown", event => {
      if (event.ctrlKey || event.altKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      const key = event.key.toLowerCase();
      if (movementKeys.includes(key)) {
        event.preventDefault();
        this.keys.add(key);
        this.mode = "keyboard";
      }
      if (key === "e") {
        event.preventDefault();
        if (!event.repeat) this.sporeQueued = true;
      }
      if (key === "q") {
        event.preventDefault();
        this.keys.add("q");
        if (!event.repeat) this.splitQueued = true;
      }
      if (event.repeat) return;
      // 按钮保留空格键原生行为，避免点击后又被全局快捷键暂停。
      if ((key === " " || key === "escape") && !["BUTTON", "SUMMARY"].includes(event.target.tagName)) {
        event.preventDefault();
        this.onCommand("pause");
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
    this.splitQueued = false;
  }

  requestSplit() {
    this.splitQueued = true;
  }

  requestSpore() {
    this.sporeQueued = true;
  }

  getInput(screenPosition, view) {
    const direction = this.getDirection(screenPosition);
    const split = this.keys.has("q") || this.splitQueued;
    const spore = this.sporeQueued;
    let target = null;
    if (this.mode === "pointer" && this.pointer && view) {
      const rect = this.canvas.getBoundingClientRect();
      target = {
        x: view.left + this.pointer.x / rect.width * (view.right - view.left),
        y: view.top + this.pointer.y / rect.height * (view.bottom - view.top),
      };
    }
    this.sporeQueued = false;
    this.splitQueued = false;
    // Shift 冲刺已移除；保留 sprint:false 让旧的网络/存档代码平滑升级。
    return { ...direction, sprint: false, split, spore, target, view };
  }

  getDirection(screenPosition) {
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
