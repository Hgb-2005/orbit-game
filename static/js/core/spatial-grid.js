/**
 * 均匀空间网格：先按位置筛选附近实体，再交给原有精确碰撞函数判断。
 * 网格只负责候选查询，不改变碰撞半径、排序或吞噬规则。
 */
export class SpatialGrid {
  constructor(cellSize = 180) {
    this.cellSize = Math.max(16, cellSize);
    this.cells = new Map();
  }

  clear() {
    this.cells.clear();
  }

  key(x, y) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  insert(entity, radius = entity.radius || 0) {
    const minX = Math.floor((entity.x - radius) / this.cellSize);
    const maxX = Math.floor((entity.x + radius) / this.cellSize);
    const minY = Math.floor((entity.y - radius) / this.cellSize);
    const maxY = Math.floor((entity.y + radius) / this.cellSize);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const key = `${x},${y}`;
        let bucket = this.cells.get(key);
        if (!bucket) this.cells.set(key, bucket = new Set());
        bucket.add(entity);
      }
    }
  }

  build(entities, radiusFor = entity => entity.radius || 0) {
    this.clear();
    for (const entity of entities) this.insert(entity, radiusFor(entity));
    return this;
  }

  queryCircle(x, y, radius) {
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);
    const result = new Set();
    for (let cellX = minX; cellX <= maxX; cellX++) {
      for (let cellY = minY; cellY <= maxY; cellY++) {
        const bucket = this.cells.get(`${cellX},${cellY}`);
        if (!bucket) continue;
        for (const entity of bucket) result.add(entity);
      }
    }
    return [...result];
  }
}
