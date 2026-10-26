/** 摇杆只产生方向输入；单机与联机共用，与鼠标技能按钮可以多指同时操作。 */
export function joystickVector(dx, dy, radius = 40) {
  const distance = Math.hypot(dx, dy);
  if (distance < 6) return { x: 0, y: 0 };
  const strength = Math.min(1, (distance - 6) / (radius - 6));
  return { x: dx / distance * strength, y: dy / distance * strength };
}

export class TouchJoystick {
  constructor(element, onMove = () => {}) {
    this.element = element;
    this.thumb = element.querySelector(".joystick-thumb");
    this.onMove = onMove;
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

  move(event) {
    const rect = this.element.getBoundingClientRect();
    const dx = event.clientX - rect.left - rect.width / 2, dy = event.clientY - rect.top - rect.height / 2;
    this.vector = joystickVector(dx, dy);
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
