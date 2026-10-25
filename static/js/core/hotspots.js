import { CONFIG } from "../config.js";
import { distanceSquared } from "./entities.js";

/** 富集区只改变食物的空间分布；计时随模拟推进，暂停时不会换位。 */
export class FoodHotspots {
  constructor(bounds, random = Math.random) {
    this.bounds = bounds;
    this.random = random;
    this.cycle = 0;
    this.remaining = CONFIG.hotspots.duration;
    this.zones = this.createZones([]);
  }

  createZones(previous) {
    const zones = [];
    const radius = CONFIG.hotspots.radius;
    const margin = radius + 60;
    for (let i = 0; i < CONFIG.hotspots.count; i++) {
      let best = null;
      let bestClearance = -Infinity;
      for (let attempt = 0; attempt < 60; attempt++) {
        const candidate = {
          id: `hotspot-${this.cycle}-${i}`, label: String.fromCharCode(65 + i), radius,
          x: margin + this.random() * (this.bounds.width - margin * 2),
          y: margin + this.random() * (this.bounds.height - margin * 2),
        };
        const neighbors = [...zones, ...previous];
        const clearance = neighbors.length ? Math.min(...neighbors.map(zone => Math.sqrt(distanceSquared(candidate, zone)))) : Infinity;
        if (clearance > bestClearance) { best = candidate; bestClearance = clearance; }
        if (clearance >= CONFIG.hotspots.separation) break;
      }
      // 随机源退化时使用分散的备用点，避免区域叠在一起或原地换位。
      if (bestClearance < radius * 2.2) {
        const choices = [
          { x: margin, y: margin }, { x: this.bounds.width - margin, y: this.bounds.height - margin },
          { x: margin, y: this.bounds.height - margin }, { x: this.bounds.width - margin, y: margin },
          { x: this.bounds.width / 2, y: this.bounds.height / 2 },
        ];
        const neighbors = [...zones, ...previous];
        const clearance = point => Math.min(...neighbors.map(zone => distanceSquared(point, zone)));
        choices.sort((a, b) => clearance(b) - clearance(a));
        best = { ...best, ...choices[0] };
      }
      zones.push(best);
    }
    return zones;
  }

  update(dt) {
    this.remaining -= dt;
    if (this.remaining > 0) return false;
    const cycles = Math.floor(-this.remaining / CONFIG.hotspots.duration) + 1;
    this.cycle += cycles;
    this.zones = this.createZones(this.zones);
    this.remaining += cycles * CONFIG.hotspots.duration;
    return true;
  }

  // 普通刷新按比例采样；区域换位时可明确指定位置类型，避免富集食物逐轮减少。
  sampleFoodPosition(inHotspot = this.random() < CONFIG.hotspots.foodRatio) {
    if (inHotspot) {
      const zone = this.zones[Math.min(this.zones.length - 1, Math.floor(this.random() * this.zones.length))];
      const angle = this.random() * Math.PI * 2;
      // sqrt 保证在圆形面积内均匀采样，而不是全部挤到中心。
      const distance = Math.sqrt(this.random()) * (zone.radius - CONFIG.food.radius);
      return { x: zone.x + Math.cos(angle) * distance, y: zone.y + Math.sin(angle) * distance, hotspotId: zone.id };
    }
    return {
      x: 20 + this.random() * (this.bounds.width - 40),
      y: 20 + this.random() * (this.bounds.height - 40), hotspotId: null,
    };
  }

  getSnapshot() {
    return { zones: this.zones, remaining: this.remaining, duration: CONFIG.hotspots.duration, cycle: this.cycle };
  }
}
