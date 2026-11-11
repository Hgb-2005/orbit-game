"""每日挑战契约、结算校验与 SQLite 汇总。

客户端可以离线生成相同契约，但提交时会用服务端当天契约重新核对目标，
避免客户端把另一天或另一组目标的结果写进当天记录。
"""

from __future__ import annotations

import json
import math
import re
from datetime import date as Date, datetime, timedelta, timezone

from .database import get_db

SHANGHAI = timezone(timedelta(hours=8))
GRADE_ORDER = {"S": 4, "A": 3, "B": 2, "C": 1}
GOAL_ORDER = (
    "top-three",
    "split-double",
    "hotspot-time",
    "peak-mass",
    "eat-three",
    "combo-three",
    "survive-time",
    "spike-launch",
    "no-spike",
)
RUN_ID_PATTERN = re.compile(r"local-[a-zA-Z0-9-]{8,80}")
UINT32 = 0xFFFFFFFF


def shanghai_date(now: datetime | None = None) -> str:
    current = now.astimezone(SHANGHAI) if now else datetime.now(SHANGHAI)
    return current.date().isoformat()


def stable_seed_hash(value: object) -> int:
    """与 static/js/core/random.js 相同的 FNV-1a 32 位哈希。"""
    result = 2166136261
    for char in str(value):
        result ^= ord(char)
        result = (result * 16777619) & UINT32
    return result


def _next_state(state: int) -> int:
    value = state or 0x9E3779B9
    value = (value ^ ((value << 13) & UINT32)) & UINT32
    value = (value ^ (value >> 17)) & UINT32
    value = (value ^ ((value << 5) & UINT32)) & UINT32
    return value or 0x6D2B79F5


def _next_int(state: int) -> tuple[int, int]:
    next_value = _next_state(state)
    return next_value, next_value % 1_000_000


def _goal_details(goal_id: str, state: int) -> dict:
    if goal_id == "top-three":
        return {
            "label": "登上领奖台",
            "description": "对局结束时进入前三名。命数、击败数和总质量共同决定名次。",
            "target": 3,
            "unit": "名",
        }
    if goal_id == "split-double":
        return {
            "label": "分裂连食",
            "description": "主动分裂后 2 秒内吞下 2 个对手球体。",
            "target": 2,
            "unit": "球",
        }
    if goal_id == "hotspot-time":
        _, roll = _next_int(state)
        target = (15, 20, 25)[roll % 3]
        return {
            "label": "富集区驻守",
            "description": f"在金色富集区内累计停留 {target} 秒，区域换位后仍可继续累计。",
            "target": target,
            "unit": "秒",
        }
    if goal_id == "peak-mass":
        _, roll = _next_int(state)
        target = (140, 180, 240, 320)[roll % 4]
        return {
            "label": "质量跃迁",
            "description": f"本局峰值质量达到 {target} m。分身与合体不会重复计算总质量。",
            "target": target,
            "unit": "m",
        }
    if goal_id == "eat-three":
        return {
            "label": "主动出击",
            "description": "主动吞下 3 个对手球体。",
            "target": 3,
            "unit": "球",
        }
    if goal_id == "combo-three":
        return {
            "label": "三连吞噬",
            "description": "在连击窗口内连续吞噬 3 个球。",
            "target": 3,
            "unit": "连",
        }
    if goal_id == "survive-time":
        _, roll = _next_int(state)
        target = (120, 150, 180)[roll % 3]
        return {
            "label": "稳定生长",
            "description": f"本局存活到 {target // 60} 分 {target % 60} 秒。",
            "target": target,
            "unit": "秒",
        }
    if goal_id == "spike-launch":
        return {
            "label": "刺球反击",
            "description": "连续喂给绿色刺球 5 颗孢子，并成功发射 1 次反击刺。",
            "target": 1,
            "unit": "次",
        }
    return {
        "label": "无伤穿行",
        "description": "整局不触发扎刺，坚持到对局结算。",
        "target": 1,
        "unit": "整局",
    }


def _choose_goal_ids(seed: str) -> tuple[list[str], int]:
    state = stable_seed_hash(f"{seed}:goals") or 0x6D2B79F5
    pool = list(GOAL_ORDER)
    for index in range(len(pool) - 1, 0, -1):
        state, roll = _next_int(state)
        swap = roll % (index + 1)
        pool[index], pool[swap] = pool[swap], pool[index]
    selected: list[str] = []
    for goal_id in pool:
        if goal_id == "spike-launch" and "no-spike" in selected:
            continue
        if goal_id == "no-spike" and "spike-launch" in selected:
            continue
        selected.append(goal_id)
        if len(selected) == 3:
            break
    return selected, state


def build_daily_challenge(challenge_date: str | None = None, mode: str = "daily") -> dict:
    challenge_date = challenge_date or shanghai_date()
    try:
        date_value = Date.fromisoformat(challenge_date)
    except ValueError as error:
        raise ValueError("挑战日期必须使用 YYYY-MM-DD。") from error
    if mode != "daily":
        raise ValueError("每日挑战模式必须是 daily。")
    seed = f"orbit:{challenge_date}:{mode}"
    goal_ids, state = _choose_goal_ids(seed)
    goals = []
    for order, goal_id in enumerate(goal_ids):
        goals.append({
            "id": goal_id,
            **_goal_details(goal_id, state),
            "progress": 0,
            "state": "active",
            "failureReason": "",
            "order": order,
        })
        state = _next_state(state)
    return {
        "date": date_value.isoformat(),
        "seed": seed,
        "mode": mode,
        "title": f"{date_value.month} 月 {date_value.day} 日 · 每日挑战",
        "rules": {
            "duration": 300,
            "initialLives": 3,
            "botCount": 13,
            "fixedSeed": True,
        },
        "goals": goals,
    }


def _integer(value: object, minimum: int, maximum: int, field: str) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{field} 必须是 {minimum} 到 {maximum} 之间的整数。")
    return value


def _finite(value: object, minimum: float, maximum: float, field: str) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{field} 必须是 {minimum} 到 {maximum} 之间的数值。")
    return float(value)


def _grade_for(score: int) -> str:
    if score >= 4000:
        return "S"
    if score >= 3000:
        return "A"
    if score >= 2000:
        return "B"
    return "C"


def validate_challenge_run(payload: object, today: str | None = None) -> dict:
    """验证并规范化一次已结束每日挑战，返回可持久化的安全载荷。"""
    if not isinstance(payload, dict):
        raise ValueError("每日挑战成绩必须是 JSON 对象。")
    today = today or shanghai_date()
    run_id = payload.get("runId")
    if not isinstance(run_id, str) or not RUN_ID_PATTERN.fullmatch(run_id):
        raise ValueError("无效的每日挑战编号。")
    if payload.get("challengeDate") != today:
        raise ValueError("只能提交北京时间今天的每日挑战。")
    contract = build_daily_challenge(today)
    if payload.get("seed") != contract["seed"] or payload.get("mode") != "daily":
        raise ValueError("挑战种子或模式与今天不匹配。")
    score = _integer(payload.get("score"), 0, 1_000_000, "score")
    completion = _integer(payload.get("completion"), 0, 100, "completion")
    rank = _integer(payload.get("rank"), 1, contract["rules"]["botCount"] + 1, "rank")
    kills = _integer(payload.get("kills"), 0, 1000, "kills")
    elapsed = _finite(payload.get("elapsed"), 0, contract["rules"]["duration"], "elapsed")
    grade = payload.get("grade")
    if grade not in GRADE_ORDER:
        raise ValueError("无效的成绩等级。")
    goals = payload.get("goals")
    if not isinstance(goals, list) or len(goals) != 3:
        raise ValueError("每日挑战必须提交三个完整目标。")
    canonical = {goal["id"]: goal for goal in contract["goals"]}
    clean_goals = []
    seen = set()
    for goal in goals:
        if not isinstance(goal, dict):
            raise ValueError("目标结果格式无效。")
        goal_id = goal.get("id")
        if goal_id not in canonical or goal_id in seen:
            raise ValueError("目标与今天契约不匹配。")
        seen.add(goal_id)
        expected = canonical[goal_id]
        target = _finite(goal.get("target"), 0, 1000, "target")
        if not math.isclose(target, expected["target"]):
            raise ValueError("目标数值与今天契约不匹配。")
        progress = _finite(goal.get("progress"), 0, expected["target"], "progress")
        state = goal.get("state")
        if state not in ("completed", "failed"):
            raise ValueError("已结算目标只能是 completed 或 failed。")
        reason = goal.get("failureReason", "")
        if not isinstance(reason, str) or len(reason) > 180:
            raise ValueError("目标失败说明过长。")
        if state == "completed" and not math.isclose(progress, expected["target"]):
            raise ValueError("已完成目标必须达到目标值。")
        if state == "failed" and math.isclose(progress, expected["target"]):
            raise ValueError("未完成目标不能达到目标值。")
        clean_goals.append({
            "id": goal_id,
            "label": expected["label"],
            "target": expected["target"],
            "progress": progress,
            "state": state,
            "failureReason": reason,
        })
    if seen != set(canonical):
        raise ValueError("目标与今天契约不匹配。")
    by_id = {goal["id"]: goal for goal in clean_goals}
    observable = {
        "top-three": rank <= 3,
        "eat-three": kills >= canonical["eat-three"]["target"] if "eat-three" in canonical else None,
        "survive-time": elapsed >= canonical["survive-time"]["target"] if "survive-time" in canonical else None,
    }
    for goal_id, satisfied in observable.items():
        if satisfied is None or goal_id not in by_id:
            continue
        completed_goal = by_id[goal_id]["state"] == "completed"
        if completed_goal != satisfied:
            raise ValueError(f"{canonical[goal_id]['label']}状态与最终名次、击败数或耗时不一致。")
    completed = sum(goal["state"] == "completed" for goal in clean_goals)
    expected_completion = round(completed / 3 * 100)
    if completion != expected_completion:
        raise ValueError("完成度与目标状态不一致。")
    rank_bonus = 1000 if rank == 1 else 750 if rank == 2 else 500 if rank == 3 else 250 if rank <= 7 else 0
    expected_score = completed * 900 + rank_bonus + round(kills * 120) + int(math.floor(elapsed * 2 + 0.5))
    if score != expected_score:
        raise ValueError("挑战分数与目标、名次或耗时不一致。")
    if grade != _grade_for(score):
        raise ValueError("成绩等级与分数不一致。")
    return {
        "runId": run_id,
        "challengeDate": today,
        "seed": contract["seed"],
        "mode": "daily",
        "score": score,
        "completion": completion,
        "rank": rank,
        "kills": kills,
        "elapsed": round(elapsed, 3),
        "grade": grade,
        "goals": clean_goals,
    }


def save_challenge_run(run: dict) -> dict:
    connection = get_db()
    encoded = json.dumps(run, ensure_ascii=False, separators=(",", ":"))
    with connection:
        cursor = connection.execute(
            """INSERT OR IGNORE INTO challenge_runs
               (run_id, challenge_date, challenge_seed, mode, score, completion, rank, grade, payload)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (run["runId"], run["challengeDate"], run["seed"], run["mode"], run["score"],
             run["completion"], run["rank"], run["grade"], encoded),
        )
        duplicate = cursor.rowcount == 0
        # 保留足够长的历史，同时给单机数据库设置明确上限。
        connection.execute(
            """DELETE FROM challenge_runs WHERE rowid NOT IN
               (SELECT rowid FROM challenge_runs ORDER BY created_at DESC, rowid DESC LIMIT 1000)"""
        )
    return {"saved": True, "duplicate": duplicate, **challenge_summary()}


def _streak(days: list[str], today: Date) -> int:
    if not days:
        return 0
    parsed = sorted({Date.fromisoformat(day) for day in days}, reverse=True)
    if parsed[0] < today - timedelta(days=1):
        return 0
    streak = 1
    cursor = parsed[0]
    for challenge_day in parsed[1:]:
        if challenge_day != cursor - timedelta(days=1):
            break
        streak += 1
        cursor = challenge_day
    return streak


def challenge_summary(today: str | None = None) -> dict:
    today = today or shanghai_date()
    connection = get_db()
    aggregate = connection.execute(
        """SELECT COUNT(*) AS runs, AVG(completion) AS average_completion
           FROM challenge_runs"""
    ).fetchone()
    today_row = connection.execute(
        """SELECT MAX(score) AS today_best,
                  CASE MAX(CASE grade WHEN 'S' THEN 4 WHEN 'A' THEN 3 WHEN 'B' THEN 2 ELSE 1 END)
                    WHEN 4 THEN 'S' WHEN 3 THEN 'A' WHEN 2 THEN 'B' WHEN 1 THEN 'C' END AS best_grade
           FROM challenge_runs WHERE challenge_date = ?""",
        (today,),
    ).fetchone()
    recent_rows = connection.execute(
        """SELECT run_id, challenge_date, score, completion, rank, grade, created_at
           FROM challenge_runs ORDER BY created_at DESC, rowid DESC LIMIT 7"""
    ).fetchall()
    days = [row["challenge_date"] for row in connection.execute(
        "SELECT DISTINCT challenge_date FROM challenge_runs"
    ).fetchall()]
    return {
        "todayBest": int(today_row["today_best"] or 0),
        "completionRate": round(float(aggregate["average_completion"] or 0)),
        "bestGrade": today_row["best_grade"],
        "streak": _streak(days, Date.fromisoformat(today)),
        "totalRuns": int(aggregate["runs"] or 0),
        "recent": [{
            "runId": row["run_id"],
            "date": row["challenge_date"],
            "score": row["score"],
            "completion": row["completion"],
            "rank": row["rank"],
            "grade": row["grade"],
            "createdAt": row["created_at"],
        } for row in recent_rows],
    }
