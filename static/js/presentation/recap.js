/** 只展示已有统计；旧服务端没提供计数时显示破折号，避免把缺失数据当零。 */
export function recapItems(snapshot) {
  const stats = snapshot.stats;
  const count = key => stats && Number.isFinite(stats[key]) ? Math.round(stats[key]).toLocaleString("zh-CN") : "—";
  return [
    { label: "最高总质量", value: `${Math.round(stats?.peakMass ?? snapshot.peakMass ?? 0).toLocaleString("zh-CN")} m` },
    { label: "最多分身", value: count("maxCells") },
    { label: "吞噬球数", value: count("cellsEaten") },
    { label: "收集食物", value: count("foods") },
    { label: "主动分裂", value: `${count("splits")} 次` },
    { label: "吐出孢子", value: `${count("sporesEmitted")} 颗` },
    { label: "喂刺 / 反击", value: `${count("spikesFed")} 颗 / ${count("spikesLaunched")} 次` },
    { label: "扎刺 / 损失分身", value: `${count("spikeHits")} 次 / ${count("cellsLost")} 球` },
  ];
}
