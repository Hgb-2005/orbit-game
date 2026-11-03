import { PRACTICE_DRILLS } from '../core/practice.js';

const KEY = 'orbit.practice-progress.v1';
export function readPracticeProgress(storage) {
  try {
    storage ??= globalThis.localStorage;
    const raw = JSON.parse(storage.getItem(KEY) || '{}');
    return Object.fromEntries(PRACTICE_DRILLS.filter(d => Number.isFinite(raw?.[d.id]) && raw[d.id] >= 0)
      .map(d => [d.id, raw[d.id]]));
  } catch { return {}; }
}
export function rememberPractice(progress, drill, storage) {
  if (!drill?.complete || !Number.isFinite(drill.completedAt) || drill.completedAt < 0 || !PRACTICE_DRILLS.some(d => d.id === drill.id)) return false;
  progress[drill.id] = Math.min(progress[drill.id] ?? Infinity, drill.completedAt);
  try { (storage ?? globalThis.localStorage).setItem(KEY, JSON.stringify(progress)); return true; } catch { return false; }
}
export function practiceCheckpoints(snapshot) {
  const s = snapshot.stats ?? {}, drill = snapshot.practice;
  if (!drill) return [];
  const steps = drill.id === 'split' ? [
    ['对准靶球，按 Q / 右键或「分裂」', s.splits > 0],
    ['让分身接触并吞噬蓝色靶球', drill.complete],
  ] : drill.id === 'feed' ? [
    ['面对右侧绿色刺球，按住 E / 孢子按钮', s.sporesEmitted > 0],
    ['让孢子命中刺球，累积 5 格蓄能', s.spikesFed >= 5],
    ['蓄满后自动发射反击刺', drill.complete],
  ] : [
    ['按住 C /「按住聚拢」，收拢分身', drill.regroupSeconds >= .5],
    ['保持靠近，等合体冷却结束', drill.complete || snapshot.split?.mergeRemaining <= 0],
    ['冷却结束后靠拢，自动合成单球', drill.complete],
  ];
  const active = steps.findIndex(([, done]) => !done);
  return steps.map(([text, done], index) => ({ text, done: !!done, current: index === active }));
}
export function nextPractice(progress) {
  return PRACTICE_DRILLS.find(d => !Object.hasOwn(progress, d.id))?.id ?? 'split';
}
/** 建议只引用实际计数，不推断录像里才看得出的失败原因。 */
export function roundAdvice(snapshot) {
  const s = snapshot.stats;
  if (!s) return null;
  if (s.spikeHits > 0) return { drill: 'feed', title: '练一练喂刺反击', text: `本局记录了 ${s.spikeHits} 次扎刺。到练习场熟悉刺球蓄能和发射方向，再尝试用刺球反击。` };
  if (s.maxCells > 1 && s.cellsLost > 0) return { drill: 'regroup', title: '练一练聚拢合体', text: `本局最多 ${s.maxCells} 个分身，损失了 ${s.cellsLost} 球。练习收拢球群和等待合体，减少小分身落单的机会。` };
  if (s.splits === 0) return { drill: 'split', title: '试一次分裂吞噬', text: '本局没有主动分裂。先在安全靶场练习方向与距离，再把这一招带回球场。' };
  return { drill: 'split', title: '再练一次分裂吞噬', text: `本局主动分裂 ${s.splits} 次。用静止靶球继续熟悉分裂后的距离和质量变化。` };
}
