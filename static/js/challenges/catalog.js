import { stableSeedHash } from "../core/random.js";

export const DAILY_CHALLENGE_MODES = Object.freeze(["daily"]);

const GOAL_ORDER = Object.freeze([
  "top-three",
  "split-double",
  "hotspot-time",
  "peak-mass",
  "eat-three",
  "combo-three",
  "survive-time",
  "spike-launch",
  "no-spike",
]);

function nextState(state) {
  let value = state || 0x9e3779b9;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0 || 0x6d2b79f5;
}

function nextInt(state) {
  const next = nextState(state);
  return { state: next, value: next % 1_000_000 };
}

/** 服务端同口径使用北京时间；这里按日期各部分组装，避免依赖浏览器区域格式。 */
export function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function goalDetails(id, state) {
  if (id === "top-three") {
    return {
      label: "登上领奖台",
      description: "对局结束时进入前三名。命数、击败数和总质量共同决定名次。",
      target: 3,
      unit: "名",
    };
  }
  if (id === "split-double") {
    return {
      label: "分裂连食",
      description: "主动分裂后 2 秒内吞下 2 个对手球体。",
      target: 2,
      unit: "球",
    };
  }
  if (id === "hotspot-time") {
    const roll = nextInt(state);
    const target = [15, 20, 25][roll.value % 3];
    return {
      label: "富集区驻守",
      description: `在金色富集区内累计停留 ${target} 秒，区域换位后仍可继续累计。`,
      target,
      unit: "秒",
    };
  }
  if (id === "peak-mass") {
    const roll = nextInt(state);
    const target = [140, 180, 240, 320][roll.value % 4];
    return {
      label: "质量跃迁",
      description: `本局峰值质量达到 ${target} m。分身与合体不会重复计算总质量。`,
      target,
      unit: "m",
    };
  }
  if (id === "eat-three") {
    return {
      label: "主动出击",
      description: "主动吞下 3 个对手球体。",
      target: 3,
      unit: "球",
    };
  }
  if (id === "combo-three") {
    return {
      label: "三连吞噬",
      description: "在连击窗口内连续吞噬 3 个球。",
      target: 3,
      unit: "连",
    };
  }
  if (id === "survive-time") {
    const roll = nextInt(state);
    const target = [120, 150, 180][roll.value % 3];
    return {
      label: "稳定生长",
      description: `本局存活到 ${Math.floor(target / 60)} 分 ${target % 60} 秒。`,
      target,
      unit: "秒",
    };
  }
  if (id === "spike-launch") {
    return {
      label: "刺球反击",
      description: "连续喂给绿色刺球 5 颗孢子，并成功发射 1 次反击刺。",
      target: 1,
      unit: "次",
    };
  }
  return {
    label: "无伤穿行",
    description: "整局不触发扎刺，坚持到对局结算。",
    target: 1,
    unit: "整局",
  };
}

function chooseGoalIds(seed) {
  let state = stableSeedHash(`${seed}:goals`) || 0x6d2b79f5;
  const pool = [...GOAL_ORDER];
  for (let index = pool.length - 1; index > 0; index--) {
    const roll = nextInt(state);
    state = roll.state;
    const swap = roll.value % (index + 1);
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  const selected = [];
  for (const id of pool) {
    if ((id === "spike-launch" && selected.includes("no-spike")) ||
        (id === "no-spike" && selected.includes("spike-launch"))) continue;
    selected.push(id);
    if (selected.length === 3) break;
  }
  return { ids: selected, state };
}

/**
 * 服务端返回同一结构；本地离线时也用此函数生成，因此可直接开始每日挑战。
 * goals 是契约的一部分，规则层只认 id、target 和 progress，不理解页面文案。
 */
export function buildDailyChallenge(date = shanghaiDate(), mode = "daily") {
  const seed = `orbit:${date}:${mode}`;
  const picked = chooseGoalIds(seed);
  let state = picked.state;
  const goals = picked.ids.map((id, index) => {
    const details = goalDetails(id, state);
    state = nextState(state);
    return {
      id,
      ...details,
      progress: 0,
      state: "active",
      failureReason: "",
      order: index,
    };
  });
  const [, month, day] = date.split("-");
  return {
    date,
    seed,
    mode,
    title: `${Number(month)} 月 ${Number(day)} 日 · 每日挑战`,
    rules: {
      duration: 300,
      initialLives: 3,
      botCount: 13,
      fixedSeed: true,
    },
    goals,
  };
}
