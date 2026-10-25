/** 按控制者聚合真实存活分身，保留精确质量排序，UI 再进行四舍五入。 */
export function getLeaderboard(cells, limit = 5) {
  const owners = new Map();
  for (const cell of cells) {
    if (!cell.alive) continue;
    if (!owners.has(cell.ownerId)) {
      owners.set(cell.ownerId, { ownerId: cell.ownerId, name: cell.name, color: cell.color,
        isPlayer: cell.isPlayer, mass: 0, cells: 0 });
    }
    const entry = owners.get(cell.ownerId);
    entry.mass += cell.mass;
    entry.cells++;
  }
  const ranked = [...owners.values()].sort((a, b) => b.mass - a.mass || a.ownerId.localeCompare(b.ownerId))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  const player = ranked.find(entry => entry.isPlayer) ?? null;
  return { entries: ranked.slice(0, limit), player, total: ranked.length };
}
