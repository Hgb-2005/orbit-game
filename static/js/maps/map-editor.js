import { DEFAULT_MAP, MAP_LIMITS, cloneMap, normalizeMap } from "./map-schema.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const nextId = (prefix, values) => {
  let index = values.length + 1;
  const used = new Set(values.map(item => item.id));
  while (used.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
};

/**
 * 地图工坊只编辑协议数据，不直接启动游戏。所有输出都要经过严格校验，
 * 因而编辑器、单机和联机看到的是同一张规范化地图。
 */
export class MapEditor {
  constructor(canvas, { onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onChange = onChange;
    this.map = cloneMap(DEFAULT_MAP);
    this.tool = "obstacle";
    this.radius = 90;
    this.selectedId = "";
    this.drag = null;
    this.undoStack = [];
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", event => this.pointerDown(event));
    canvas.addEventListener("pointermove", event => this.pointerMove(event));
    canvas.addEventListener("pointerup", event => this.pointerUp(event));
    canvas.addEventListener("pointercancel", event => this.pointerUp(event));
    this.resize();
  }

  setMap(value) {
    this.map = cloneMap(value);
    this.selectedId = "";
    this.undoStack = [];
    this.draw();
    this.onChange(this.map);
    return this.map;
  }

  setTool(tool, radius = this.radius) {
    this.tool = ["obstacle", "spike", "spawn", "delete"].includes(tool) ? tool : "obstacle";
    this.radius = clamp(Number(radius) || 90, 30, 360);
    this.draw();
  }

  setRadius(value) {
    this.radius = clamp(Number(value) || 30, this.tool === "spike" ? 24 : 30,
      this.tool === "spike" ? 110 : 360);
    this.setSelectedRadius(this.radius);
  }

  setSelectedRadius(value) {
    const found = this.findSelected();
    if (!found || found.kind === "spawn") return;
    const limit = found.kind === "spike" ? [24, 110] : [30, 360];
    found.item.radius = clamp(Number(value) || limit[0], ...limit);
    this.changed();
  }

  removeSelected() {
    if (!this.selectedId) return false;
    if (this.map.spawnPoints.some(item => item.id === this.selectedId)) return false;
    const before = cloneMap(this.map);
    this.map.spikes = this.map.spikes.filter(item => item.id !== this.selectedId);
    this.map.obstacles = this.map.obstacles.filter(item => item.id !== this.selectedId);
    this.selectedId = "";
    this.commit(before);
    return true;
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.map = previous;
    this.selectedId = "";
    this.changed();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.draw();
  }

  fit() {
    const scale = Math.min((this.width - 30) / this.map.width, (this.height - 30) / this.map.height);
    return {
      scale,
      x: (this.width - this.map.width * scale) / 2,
      y: (this.height - this.map.height * scale) / 2,
    };
  }

  worldPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    const fit = this.fit();
    return {
      x: clamp((event.clientX - rect.left - fit.x) / fit.scale, 0, this.map.width),
      y: clamp((event.clientY - rect.top - fit.y) / fit.scale, 0, this.map.height),
    };
  }

  hitTest(point) {
    const groups = [
      ["obstacle", this.map.obstacles],
      ["spike", this.map.spikes],
      ["spawn", this.map.spawnPoints],
    ];
    for (const [kind, items] of groups) {
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        const radius = kind === "spawn" ? 34 : item.radius;
        if (Math.hypot(point.x - item.x, point.y - item.y) <= radius + 12) {
          return { kind, item, collection: items };
        }
      }
    }
    return null;
  }

  pointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    this.canvas.setPointerCapture?.(event.pointerId);
    const point = this.worldPoint(event);
    const hit = this.hitTest(point);
    if (this.tool === "delete") {
      if (hit && hit.kind !== "spawn") {
        this.selectedId = hit.item.id;
        this.removeSelected();
      }
      return;
    }
    const before = cloneMap(this.map);
    if (hit) {
      this.selectedId = hit.item.id;
      this.drag = { kind: hit.kind, item: hit.item, before, pointerId: event.pointerId };
    } else if (this.tool === "obstacle" || this.tool === "spike") {
      const limit = this.tool === "spike" ? MAP_LIMITS.maxSpikes : MAP_LIMITS.maxObstacles;
      const values = this.tool === "spike" ? this.map.spikes : this.map.obstacles;
      if (values.length >= limit) {
        this.onChange(this.map, { error: `最多放置 ${limit} 个${this.tool === "spike" ? "刺球" : "障碍物"}。` });
        return;
      }
      const radius = clamp(this.radius, this.tool === "spike" ? 24 : 30, this.tool === "spike" ? 110 : 360);
      const item = {
        id: nextId(this.tool === "spike" ? "spike" : "obstacle", [...this.map.spawnPoints, ...this.map.spikes, ...this.map.obstacles]),
        x: clamp(point.x, radius + 4, this.map.width - radius - 4),
        y: clamp(point.y, radius + 4, this.map.height - radius - 4),
        radius,
        color: this.tool === "spike" ? "#72c98e" : "#60716b",
      };
      values.push(item);
      this.selectedId = item.id;
      this.drag = { kind: this.tool, item, before, pointerId: event.pointerId };
    } else if (this.tool === "spawn") {
      const nearest = [...this.map.spawnPoints].sort((a, b) =>
        Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y))[0];
      if (!nearest) return;
      this.selectedId = nearest.id;
      nearest.x = clamp(point.x, 80, this.map.width - 80);
      nearest.y = clamp(point.y, 80, this.map.height - 80);
      this.drag = { kind: "spawn", item: nearest, before, pointerId: event.pointerId };
    }
    this.draw();
    this.onChange(this.map, { selectedId: this.selectedId, dragging: true });
  }

  pointerMove(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    const point = this.worldPoint(event);
    const item = this.drag.item;
    const margin = this.drag.kind === "spawn" ? 80 : item.radius;
    item.x = clamp(point.x, margin, this.map.width - margin);
    item.y = clamp(point.y, margin, this.map.height - margin);
    this.draw();
    this.onChange(this.map, { selectedId: this.selectedId, dragging: true });
  }

  pointerUp(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    const gesture = this.drag;
    this.drag = null;
    this.canvas.releasePointerCapture?.(event.pointerId);
    this.commit(gesture.before);
  }

  commit(before) {
    this.undoStack.push(before);
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.changed();
  }

  changed() {
    this.draw();
    this.onChange(this.map, { selectedId: this.selectedId });
  }

  findSelected() {
    if (!this.selectedId) return null;
    const groups = [["obstacle", this.map.obstacles], ["spike", this.map.spikes], ["spawn", this.map.spawnPoints]];
    for (const [kind, items] of groups) {
      const item = items.find(value => value.id === this.selectedId);
      if (item) return { kind, item };
    }
    return null;
  }

  draw() {
    if (!this.ctx || !this.width) return;
    const ctx = this.ctx;
    const fit = this.fit();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#101713";
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#19241e";
    ctx.fillRect(fit.x, fit.y, this.map.width * fit.scale, this.map.height * fit.scale);

    ctx.save();
    ctx.translate(fit.x, fit.y);
    ctx.scale(fit.scale, fit.scale);
    ctx.strokeStyle = "#314239";
    ctx.lineWidth = 1 / fit.scale;
    for (let x = 100; x < this.map.width; x += 100) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.map.height); ctx.stroke();
    }
    for (let y = 100; y < this.map.height; y += 100) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.map.width, y); ctx.stroke();
    }
    ctx.strokeStyle = "#718679";
    ctx.lineWidth = 2 / fit.scale;
    ctx.strokeRect(0, 0, this.map.width, this.map.height);

    for (const obstacle of this.map.obstacles) {
      ctx.save();
      ctx.fillStyle = obstacle.color;
      ctx.strokeStyle = obstacle.id === this.selectedId ? "#b4efcc" : "#aebbb3";
      ctx.lineWidth = (obstacle.id === this.selectedId ? 3 : 1.5) / fit.scale;
      ctx.beginPath();
      ctx.arc(obstacle.x, obstacle.y, obstacle.radius, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.globalAlpha = .7;
      ctx.strokeStyle = "#d7e2dc";
      ctx.beginPath();
      ctx.moveTo(obstacle.x - obstacle.radius * .35, obstacle.y - obstacle.radius * .35);
      ctx.lineTo(obstacle.x + obstacle.radius * .35, obstacle.y + obstacle.radius * .35);
      ctx.moveTo(obstacle.x + obstacle.radius * .35, obstacle.y - obstacle.radius * .35);
      ctx.lineTo(obstacle.x - obstacle.radius * .35, obstacle.y + obstacle.radius * .35);
      ctx.stroke();
      ctx.restore();
    }
    for (const spike of this.map.spikes) {
      ctx.save();
      ctx.translate(spike.x, spike.y);
      ctx.fillStyle = spike.color;
      ctx.strokeStyle = spike.id === this.selectedId ? "#f0d49b" : "#d2efda";
      ctx.lineWidth = (spike.id === this.selectedId ? 3 : 1.5) / fit.scale;
      ctx.beginPath();
      for (let index = 0; index < 12; index++) {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / 12;
        const radius = index % 2 ? spike.radius * .72 : spike.radius;
        const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
        if (!index) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    for (const spawn of this.map.spawnPoints) {
      ctx.save();
      ctx.fillStyle = "#d7bc77";
      ctx.strokeStyle = spawn.id === this.selectedId ? "#fff1bd" : "#6e6039";
      ctx.lineWidth = 2 / fit.scale;
      ctx.beginPath(); ctx.arc(spawn.x, spawn.y, 28, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#18221b";
      ctx.font = `${18 / fit.scale}px sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("S", spawn.x, spawn.y);
      ctx.restore();
    }
    ctx.restore();
    ctx.fillStyle = "#9bae9f";
    ctx.font = "11px 'Microsoft YaHei', sans-serif";
    ctx.fillText(`${this.map.name} · ${this.map.width}×${this.map.height}`, 12, this.height - 12);
  }

  dispose() {
    this.resizeObserver?.disconnect();
  }
}
