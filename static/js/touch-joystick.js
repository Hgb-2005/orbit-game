import { normalizeTouchSettings } from "./settings/controls.js";

/**
 * 摇杆只产生方向输入；单机与联机共用，与鼠标技能按钮可以多指同时操作。
 * 默认死区 6px、灵敏度 100%，与阶段 5 的固定手感完全一致。
 */
export function joystickVector(dx, dy, radius = 40, options = {}) {
  const settings = normalizeTouchSettings(options);
  const distance = Math.hypot(dx, dy);
  if (distance < settings.deadZone) return { x: 0, y: 0 };
  const travel = Math.max(1, radius - settings.deadZone);
  const strength = Math.min(1, (distance - settings.deadZone) / travel * settings.sensitivity / 100);
  return { x: dx / distance * strength, y: dy / distance * strength };
}

export class TouchJoystick {
  constructor(element, onMove = () => {}, settings = {}) {
    this.element = element;
    this.thumb = element.querySelector(".joystick-thumb");
    this.onMove = onMove;
    this.settings = normalizeTouchSettings(settings);
    this.pointerId = null;
    this.vector = { x: 0, y: 0 };
    element.addEventListener("pointerdown", event => {
      if (this.pointerId !== null) return;
      event.preventDefault(); event.stopPropagation();
      this.pointerId = event.pointerId;
      element.setPointerCapture(event.pointerId);
      this.move(event);
    });
    element.addEventListener("pointermove", event => {
      if (event.pointerId === this.pointerId) { event.preventDefault(); this.move(event); }
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      element.addEventListener(name, event => { if (event.pointerId === this.pointerId) this.reset(); });
    }
  }

  get active() { return this.pointerId !== null; }

  setSettings(settings) {
    this.settings = normalizeTouchSettings({ ...this.settings, ...settings });
  }

  move(event) {
    const rect = this.element.getBoundingClientRect();
    const dx = event.clientX - rect.left - rect.width / 2, dy = event.clientY - rect.top - rect.height / 2;
    this.vector = joystickVector(dx, dy, Math.min(40, Math.min(rect.width, rect.height) / 2), this.settings);
    const scale = Math.min(1, 32 / (Math.hypot(dx, dy) || 1));
    this.thumb.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
    this.element.dataset.active = "true";
    this.onMove();
  }

  reset() {
    const pointerId = this.pointerId;
    this.pointerId = null;
    if (pointerId !== null && this.element.hasPointerCapture(pointerId)) this.element.releasePointerCapture(pointerId);
    this.vector = { x: 0, y: 0 };
    this.thumb.style.transform = "translate(0px, 0px)";
    this.element.dataset.active = "false";
  }
}
