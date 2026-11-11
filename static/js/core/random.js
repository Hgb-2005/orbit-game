/** 跨浏览器稳定的字符串哈希；数字种子也会先转成字符串。 */
export function stableSeedHash(value) {
  const text = String(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Mulberry32：同一种子生成同一序列，供每日地图和测试复用。
 * 普通模式仍使用 Math.random，不会受到这里的影响。
 */
export function createSeededRandom(seed) {
  let state = stableSeedHash(seed) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
