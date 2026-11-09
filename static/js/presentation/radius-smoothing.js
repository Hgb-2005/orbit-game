/** 仅平滑绘制半径；碰撞、吞噬和可见性继续使用实体真实半径。 */
export function smoothDisplayRadius(previous, target, dt, snap = false) {
  if (!Number.isFinite(target) || target < 0) return previous;
  if (snap || !Number.isFinite(previous) || previous < 0) return target;
  const safeDt = Math.max(0, Math.min(Number(dt) || 0, 0.1));
  return target + (previous - target) * Math.exp(-14 * safeDt);
}
