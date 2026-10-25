"""运行：python -m unittest discover -s tests -v"""

import json
import tempfile
import unittest
from pathlib import Path

from server import create_app


class ScoreAPITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.config = {"TESTING": True, "DATABASE": str(Path(self.directory.name) / "test.sqlite3")}
        self.app = create_app(self.config)
        self.client = self.app.test_client()

    def tearDown(self):
        self.directory.cleanup()

    def test_page_and_initial_record(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/api/high-score").json["high_score"], 0)

    def test_record_only_increases_and_persists(self):
        first = self.client.post("/api/scores", json={"score": 120}).json
        self.assertTrue(first["is_new_record"])
        self.assertIsNotNone(first["updated_at"])
        for score in [5, 120, 0]:
            result = self.client.post("/api/scores", json={"score": score}).json
            self.assertFalse(result["is_new_record"])
            self.assertEqual(result["high_score"], 120)
        # 创建新应用，确认记录来自磁盘数据库，而非 Python 内存。
        other_client = create_app(self.config).test_client()
        self.assertEqual(other_client.get("/api/high-score").json["high_score"], 120)

    def test_reject_invalid_input(self):
        for payload in [{}, [], None, {"score": -1}, {"score": 1.5},
                        {"score": True}, {"score": "42"}, {"score": 1_000_000_001}]:
            response = self.client.post("/api/scores", data=json.dumps(payload),
                                        content_type="application/json")
            self.assertEqual(response.status_code, 400, payload)
        self.assertEqual(self.client.post("/api/scores", data="score=2").status_code, 415)
        self.assertEqual(self.client.post("/api/scores", data="{", content_type="application/json").status_code, 400)


if __name__ == "__main__":
    unittest.main()
