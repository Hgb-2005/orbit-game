"""v0.27 每日挑战契约、服务端复核、SQLite 幂等与汇总测试。"""

import copy
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from server import create_app
from server.challenges import (
    build_daily_challenge,
    challenge_summary,
    save_challenge_run,
    shanghai_date,
    stable_seed_hash,
    validate_challenge_run,
)


def grade_for(score):
    if score >= 4000:
        return "S"
    if score >= 3000:
        return "A"
    if score >= 2000:
        return "B"
    return "C"


def make_run(
    challenge_date,
    *,
    run_id="local-test-0001",
    rank=14,
    kills=0,
    elapsed=0,
    completed_ids=(),
):
    contract = build_daily_challenge(challenge_date)
    completed_ids = set(completed_ids)
    goals = []
    for goal in contract["goals"]:
        completed = goal["id"] in completed_ids
        goals.append({
            "id": goal["id"],
            "target": goal["target"],
            "progress": goal["target"] if completed else 0,
            "state": "completed" if completed else "failed",
            "failureReason": "" if completed else "本局未达到目标。",
        })
    completed = len(completed_ids)
    rank_bonus = 1000 if rank == 1 else 750 if rank == 2 else 500 if rank == 3 else 250 if rank <= 7 else 0
    score = completed * 900 + rank_bonus + round(kills * 120) + round(elapsed * 2)
    return {
        "runId": run_id,
        "challengeDate": challenge_date,
        "seed": contract["seed"],
        "mode": "daily",
        "score": score,
        "completion": round(completed / 3 * 100),
        "rank": rank,
        "kills": kills,
        "elapsed": elapsed,
        "grade": grade_for(score),
        "goals": goals,
    }


class DailyChallengeContractTests(unittest.TestCase):
    def test_hash_and_fixed_sample_match_frontend(self):
        self.assertEqual(stable_seed_hash(""), 2166136261)
        self.assertEqual(stable_seed_hash("orbit:2026-11-11:daily"), 2158827140)
        contract = build_daily_challenge("2026-11-11")
        self.assertEqual(contract["seed"], "orbit:2026-11-11:daily")
        self.assertEqual(
            [(goal["id"], goal["target"]) for goal in contract["goals"]],
            [("survive-time", 150), ("eat-three", 3), ("spike-launch", 1)],
        )

    def test_same_date_is_stable_and_different_date_changes_course(self):
        self.assertEqual(
            build_daily_challenge("2026-11-11"),
            build_daily_challenge("2026-11-11"),
        )
        self.assertNotEqual(
            [(goal["id"], goal["target"]) for goal in build_daily_challenge("2026-11-11")["goals"]],
            [(goal["id"], goal["target"]) for goal in build_daily_challenge("2026-11-12")["goals"]],
        )

    def test_each_course_has_three_unique_non_conflicting_goals(self):
        for day in range(1, 32):
            contract = build_daily_challenge(f"2026-12-{day:02d}")
            ids = [goal["id"] for goal in contract["goals"]]
            self.assertEqual(len(ids), 3)
            self.assertEqual(len(set(ids)), 3)
            self.assertFalse("spike-launch" in ids and "no-spike" in ids)
            self.assertEqual(contract["rules"]["duration"], 300)
            self.assertEqual(contract["rules"]["initialLives"], 3)
            self.assertEqual(contract["rules"]["botCount"], 13)
            self.assertTrue(contract["rules"]["fixedSeed"])

    def test_shanghai_date_uses_utc_plus_eight(self):
        from datetime import datetime, timezone

        self.assertEqual(
            shanghai_date(datetime(2026, 1, 1, 15, 59, 59, tzinfo=timezone.utc)),
            "2026-01-01",
        )
        self.assertEqual(
            shanghai_date(datetime(2026, 1, 1, 16, 0, 0, tzinfo=timezone.utc)),
            "2026-01-02",
        )


class ChallengeValidationTests(unittest.TestCase):
    def setUp(self):
        self.day = "2026-11-11"
        self.valid = make_run(self.day)

    def rejected(self, payload):
        with self.assertRaises(ValueError):
            validate_challenge_run(payload, today=self.day)

    def test_valid_payload_is_recomputed_and_normalized(self):
        result = validate_challenge_run(self.valid, today=self.day)
        self.assertEqual(result["runId"], self.valid["runId"])
        self.assertEqual(result["score"], self.valid["score"])
        self.assertEqual(result["mode"], "daily")
        self.assertEqual(len(result["goals"]), 3)

    def test_rejects_date_seed_mode_and_goal_contract_tampering(self):
        payload = copy.deepcopy(self.valid)
        payload["challengeDate"] = "2026-11-10"
        self.rejected(payload)

        payload = copy.deepcopy(self.valid)
        payload["seed"] = "orbit:2026-11-12:daily"
        self.rejected(payload)

        payload = copy.deepcopy(self.valid)
        payload["mode"] = "classic"
        self.rejected(payload)

        payload = copy.deepcopy(self.valid)
        payload["goals"][0]["id"] = "peak-mass"
        self.rejected(payload)

        payload = copy.deepcopy(self.valid)
        payload["goals"][0]["target"] += 1
        self.rejected(payload)

        payload = copy.deepcopy(self.valid)
        payload["runId"] = "local-并发"
        self.rejected(payload)

    def test_rejects_score_completion_grade_and_progress_tampering(self):
        for field, value in (("score", 999), ("completion", 100), ("grade", "S"), ("rank", 7)):
            payload = copy.deepcopy(self.valid)
            payload[field] = value
            self.rejected(payload)

        payload = copy.deepcopy(self.valid)
        payload["goals"][0]["progress"] = payload["goals"][0]["target"]
        self.rejected(payload)

        payload = copy.deepcopy(self.valid)
        payload["goals"][0]["state"] = "active"
        self.rejected(payload)

    def test_rejects_outcomes_contradicted_by_observable_final_stats(self):
        payload = copy.deepcopy(self.valid)
        survive = next(goal for goal in payload["goals"] if goal["id"] == "survive-time")
        survive["state"] = "completed"
        survive["progress"] = survive["target"]
        survive["failureReason"] = ""
        payload["completion"] = 33
        payload["score"] = 900 + 0 + 0 + 0
        payload["grade"] = "C"
        self.rejected(payload)

    def test_accepts_completed_time_goal_when_elapsed_reaches_target(self):
        payload = make_run(
            self.day,
            completed_ids=("survive-time",),
            elapsed=150,
        )
        result = validate_challenge_run(payload, today=self.day)
        survive = next(goal for goal in result["goals"] if goal["id"] == "survive-time")
        self.assertEqual(survive["state"], "completed")


class ChallengeAPITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = str(Path(self.directory.name) / "challenge.sqlite3")
        self.config = {"TESTING": True, "DATABASE": self.database}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.today = shanghai_date()

    def tearDown(self):
        self.directory.cleanup()

    def test_today_endpoint_returns_contract_summary_and_no_store(self):
        response = self.client.get("/api/challenge/today")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.json["date"], self.today)
        self.assertEqual(len(response.json["goals"]), 3)
        self.assertEqual(response.json["summary"]["todayBest"], 0)
        self.assertEqual(response.json["summary"]["streak"], 0)

    def test_submit_is_idempotent_and_does_not_change_ordinary_score_or_history(self):
        payload = make_run(
            self.today,
            run_id="local-api-0001",
            rank=1,
            kills=3,
            elapsed=300,
            completed_ids=tuple(goal["id"] for goal in build_daily_challenge(self.today)["goals"]),
        )
        first = self.client.post("/api/challenges", json=payload)
        second = self.client.post("/api/challenges", json=payload)
        self.assertEqual(first.status_code, 200, first.json)
        self.assertEqual(second.status_code, 200, second.json)
        self.assertFalse(first.json["duplicate"])
        self.assertTrue(second.json["duplicate"])
        self.assertEqual(second.json["totalRuns"], 1)
        self.assertEqual(second.json["todayBest"], payload["score"])
        self.assertEqual(second.json["completionRate"], 100)

        self.assertEqual(self.client.get("/api/high-score").json["high_score"], 0)
        self.assertEqual(self.client.get("/api/history").json["matches"], [])

    def test_rejects_invalid_route_payload_without_writing(self):
        payload = make_run(self.today)
        payload["score"] += 1
        response = self.client.post("/api/challenges", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("分数", response.json["error"])
        self.assertEqual(self.client.get("/api/challenges/summary").json["totalRuns"], 0)

    def test_summary_tracks_today_best_completion_and_consecutive_streak(self):
        completed = tuple(goal["id"] for goal in build_daily_challenge(self.today)["goals"])
        today_payload = make_run(
            self.today,
            run_id="local-today-0001",
            rank=1,
            kills=3,
            elapsed=300,
            completed_ids=completed,
        )
        self.assertEqual(self.client.post("/api/challenges", json=today_payload).status_code, 200)

        yesterday = (date.fromisoformat(self.today) - timedelta(days=1)).isoformat()
        yesterday_payload = make_run(
            yesterday,
            run_id="local-yesterday-0001",
        )
        with self.app.app_context():
            save_challenge_run(validate_challenge_run(yesterday_payload, today=yesterday))
            summary = challenge_summary(self.today)
        self.assertEqual(summary["todayBest"], today_payload["score"])
        self.assertEqual(summary["completionRate"], 50)
        self.assertEqual(summary["streak"], 2)
        self.assertEqual(summary["totalRuns"], 2)
        self.assertEqual(len(summary["recent"]), 2)

    def test_sqlite_summary_survives_app_restart(self):
        payload = make_run(self.today, run_id="local-persist-0001")
        self.assertEqual(self.client.post("/api/challenges", json=payload).status_code, 200)
        restarted = create_app(self.config).test_client()
        summary = restarted.get("/api/challenges/summary").json
        self.assertEqual(summary["totalRuns"], 1)
        self.assertEqual(summary["recent"][0]["runId"], payload["runId"])


if __name__ == "__main__":
    unittest.main()
