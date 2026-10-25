import { CONFIG } from "../config.js";
import { clamp, distanceSquared } from "../core/entities.js";

/** 缩放只改变文字详略，不改变质量、危险判定或碰撞规则。 */
export function describeBallLabel(ball, snapshot, zoom) {
  const owner = snapshot.survival?.standings.find(owner => owner.ownerId === ball.ownerId);
  const protectedBall = snapshot.survival?.protectionByOwner[ball.ownerId] > 0;
  const mass = `${Math.round(ball.mass)} m${owner ? ` · ${owner.lives}命` : ""}`;
  if (ball.isPlayer) {
    const detail = snapshot.playerCells.length > 1
      ? ball.mergeRemaining > 0 ? `${Math.ceil(ball.mergeRemaining)}s 合体` : "正在合体"
      : protectedBall ? "保护中" : "你的小球";
    return { text: `${mass} · ${detail}`, priority: 3, dangerous: false };
  }
  const dangerous = snapshot.playerCells.some(cell => ball.mass >= cell.mass * CONFIG.rules.eatMassRatio);
  const edible = snapshot.playerCells.some(cell => cell.mass >= ball.mass * CONFIG.rules.eatMassRatio);
  const distant = snapshot.playerCells.every(cell => distanceSquared(ball, cell) > CONFIG.labels.detailDistance ** 2);
  const compact = zoom < CONFIG.labels.detailZoom && distant;
  return { text: compact ? mass : `${mass} · ${protectedBall ? "保护中" : dangerous ? "注意避开" : edible ? "可以吞噬" : "势均力敌"}`,
    priority: dangerous ? 2 : 1, dangerous };
}

export function rectanglesOverlap(a, b, gap = 3) {
  return a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top;
}

export function rectangleHitsCircle(rect, circle, gap = 3) {
  const x = clamp(circle.x, rect.left, rect.right);
  const y = clamp(circle.y, rect.top, rect.bottom);
  return (x - circle.x) ** 2 + (y - circle.y) ** 2 < (circle.radius + gap) ** 2;
}

/** 在屏幕坐标内放置标签：优先玩家，再保留危险 AI，拥挤时隐藏低优先级 AI 标签。
 * 调用方提供已测量的文字尺寸、球体圆形和 HUD 矩形；此模块不访问 Canvas 或 DOM。
 */
export function layoutBallLabels(labels, { width, height, circles = [], obstacles = [] }) {
  const placed = [];
  const margin = 6;
  const ordered = [...labels].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const label of ordered) {
    const halfWidth = label.width / 2;
    const halfHeight = label.height / 2;
    if (label.width > width - margin * 2 || label.height > height - margin * 2) continue;
    const toRect = point => ({ left: point.x - halfWidth, right: point.x + halfWidth,
      top: point.y - halfHeight, bottom: point.y + halfHeight });
    const bounded = point => ({ x: clamp(point.x, halfWidth + margin, width - halfWidth - margin),
      y: clamp(point.y, halfHeight + margin, height - halfHeight - margin) });
    const baseY = label.y + label.radius + halfHeight + 7;
    const candidates = [];
    // 附近优先，候选顺序和控制者 ID 都稳定，质量排序变化不会打乱标签位置。
    for (let row = 0; row < 5; row++) {
      for (const direction of [1, -1]) {
        const y = label.y + direction * (label.radius + halfHeight + 7 + row * (label.height + 5));
        for (const shift of [0, -0.55, 0.55]) candidates.push(bounded({ x: label.x + shift * label.width, y }));
      }
    }
    for (const direction of [-1, 1]) candidates.push(bounded({ x: label.x + direction * (label.radius + halfWidth + 8), y: label.y }));
    const clear = (point, includeCircles = true) => {
      const rect = toRect(point);
      return !placed.some(other => rectanglesOverlap(rect, other.rect)) &&
        !obstacles.some(other => rectanglesOverlap(rect, other)) &&
        (!includeCircles || !circles.some(circle => rectangleHitsCircle(rect, circle)));
    };
    let point = candidates.find(candidate => clear(candidate));
    if (!point && label.isPlayer) {
      // 手机屏幕或四分身紧贴时，再寻找更远的空位；细引线保留球与文字的对应关系。
      const overflow = [];
      for (let y = halfHeight + margin; y <= height - halfHeight - margin; y += label.height + 5) {
        for (const x of [label.x, halfWidth + margin, width / 2, width - halfWidth - margin]) overflow.push(bounded({ x, y }));
      }
      overflow.sort((a, b) => (a.x - label.x) ** 2 + (a.y - baseY) ** 2 - ((b.x - label.x) ** 2 + (b.y - baseY) ** 2));
      point = overflow.find(candidate => clear(candidate));
      // 大球覆盖整个视野时允许文字覆盖球体，仍优先保证文字不互相覆盖、不盖住 HUD。
      if (!point) point = [...candidates, ...overflow].find(candidate => clear(candidate, false));
    }
    if (point) placed.push({ ...label, ...point, rect: toRect(point), anchor: { x: label.x, y: label.y },
      linked: Math.abs(point.x - label.x) > 8 || Math.abs(point.y - baseY) > 8 });
  }
  return placed;
}
