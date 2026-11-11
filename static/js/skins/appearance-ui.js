import {
  BALL_SKINS,
  SPORE_SKINS,
  getBallSkin,
  getSporeSkin,
  normalizeAppearance,
  readAppearance,
  writeAppearance,
} from "./catalog.js";
import { drawBallSkin, drawSporeSkin } from "./renderers.js";

const $ = id => document.getElementById(id);

/**
 * 开始界面中的外观选择器。预览卡与正式画布共享渲染器；选中项会立即
 * 持久化并通过 onChange 通知本地会话或联机准备室。
 */
export class AppearanceUI {
  constructor(storage, onChange = () => {}) {
    this.storage = storage;
    this.onChange = onChange;
    this.selection = readAppearance(storage);
    this.cards = [];
    this.frame = null;
    this.reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.buildCards();
    this.bindSelection();
    this.renderSummary();
    this.animate = this.animate.bind(this);
    this.frame = requestAnimationFrame(this.animate);
  }

  buildCards() {
    $("ball-skin-grid").replaceChildren(...BALL_SKINS.map(skin =>
      this.createCard("ballSkin", skin)));
    $("spore-skin-grid").replaceChildren(...SPORE_SKINS.map(skin =>
      this.createCard("sporeSkin", skin)));
  }

  createCard(kind, skin) {
    const button = document.createElement("button");
    const canvas = document.createElement("canvas");
    const name = document.createElement("strong");
    const description = document.createElement("span");
    button.type = "button";
    button.className = "skin-card";
    button.dataset.kind = kind;
    button.dataset.skinId = skin.id;
    button.title = `${skin.name}：${skin.description}`;
    canvas.width = 104;
    canvas.height = 64;
    canvas.setAttribute("aria-hidden", "true");
    name.textContent = skin.name;
    description.textContent = skin.description;
    button.append(canvas, name, description);
    this.cards.push({ button, canvas });
    return button;
  }

  bindSelection() {
    for (const { button } of this.cards) {
      button.addEventListener("click", () => {
        const key = button.dataset.kind;
        this.select({ ...this.selection, [key]: button.dataset.skinId });
      });
    }
  }

  select(value, { persist = true, notify = true } = {}) {
    const normalized = normalizeAppearance(value);
    const changed = normalized.ballSkin !== this.selection.ballSkin ||
      normalized.sporeSkin !== this.selection.sporeSkin;
    this.selection = persist ? writeAppearance(this.storage, normalized) : normalized;
    this.renderSummary();
    if (changed && notify) this.onChange(this.getSelection());
    return this.getSelection();
  }

  getSelection() {
    return { ...this.selection };
  }

  renderSummary() {
    const ball = getBallSkin(this.selection.ballSkin);
    const spore = getSporeSkin(this.selection.sporeSkin);
    $("appearance-summary").textContent = `${ball.name}球体 · ${spore.name}孢子`;
    for (const { button } of this.cards) {
      const selected = this.selection[button.dataset.kind] === button.dataset.skinId;
      button.setAttribute("aria-pressed", String(selected));
      button.dataset.selected = String(selected);
    }
  }

  drawCard(canvas, kind, skinId, time) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#15221f");
    gradient.addColorStop(1, "#263a35");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    if (kind === "ballSkin") {
      // 球体主色由游戏实体正常负责；预览没有实体底色，需要先补上底圆。
      ctx.fillStyle = getBallSkin(skinId).accent;
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, 23, 0, Math.PI * 2);
      ctx.fill();
      drawBallSkin(ctx, {
        id: skinId,
        ballSkin: skinId,
        x: width / 2,
        y: height / 2,
        radius: 23,
        color: getBallSkin(skinId).accent,
      }, { time, reducedMotion: this.reducedMotion, detail: 1, theme: "dark" });
    } else {
      // 先画孢子主色，再叠加纹样；正式画布保持同样的“底色 → 纹样 → 高光”顺序。
      ctx.fillStyle = getSporeSkin(skinId).accent;
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, 8, 0, Math.PI * 2);
      ctx.fill();
      drawSporeSkin(ctx, {
        id: skinId,
        sporeSkin: skinId,
        x: width / 2,
        y: height / 2,
        radius: 9,
        vx: 1,
        vy: -.15,
      }, { time, reducedMotion: this.reducedMotion });
    }
  }

  animate(now) {
    if (!document.hidden && !$("appearance-selector").hidden) {
      for (const { canvas, button } of this.cards) {
        this.drawCard(canvas, button.dataset.kind, button.dataset.skinId, now / 1000);
      }
    }
    this.frame = requestAnimationFrame(this.animate);
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}
