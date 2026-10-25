import { clamp } from "./core/entities.js";

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.width = 1;
    this.height = 1;
  }

  update(player, bounds, width, height, dt = 0.016, snap = false) {
    this.width = width;
    this.height = height;
    // 长大后适度拉远视野；地图边缘处允许相机继续保持在世界范围内。
    const growthZoom = clamp((18 / player.radius) ** 0.28, 0.43, 1);
    // 球群拉开距离时进一步缩小，让所有分身及其半径留在视野内。
    const fitZoom = Math.min(width, height) * 0.4 / Math.max(1, player.viewRadius ?? player.radius);
    const targetZoom = clamp(Math.min(growthZoom, fitZoom), 0.16, 1);
    const smoothing = snap ? 1 : 1 - Math.exp(-6 * dt);
    this.zoom += (targetZoom - this.zoom) * smoothing;
    const halfWidth = width / (2 * this.zoom);
    const halfHeight = height / (2 * this.zoom);
    const targetX = halfWidth > bounds.width / 2 ? bounds.width / 2 : clamp(player.x, halfWidth, bounds.width - halfWidth);
    const targetY = halfHeight > bounds.height / 2 ? bounds.height / 2 : clamp(player.y, halfHeight, bounds.height - halfHeight);
    this.x += (targetX - this.x) * smoothing;
    this.y += (targetY - this.y) * smoothing;
  }

  worldToScreen(point) {
    return { x: (point.x - this.x) * this.zoom + this.width / 2,
      y: (point.y - this.y) * this.zoom + this.height / 2 };
  }

  getView() {
    return {
      left: this.x - this.width / (2 * this.zoom), right: this.x + this.width / (2 * this.zoom),
      top: this.y - this.height / (2 * this.zoom), bottom: this.y + this.height / (2 * this.zoom),
    };
  }
}
