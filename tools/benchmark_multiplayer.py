"""复现联机 CPU / 消息体积对比。默认对比首次发布提交，不启动端口或写排行榜。

运行：.venv/Scripts/python.exe tools/benchmark_multiplayer.py --baseline 0af35ac
结果保存到 dist/upgrade-benchmark.json。基线源码只解压到 dist 的临时目录。
"""

from collections import Counter
import io
import json
from pathlib import Path
import random
import statistics
import subprocess
import sys
import tempfile
import time
import zipfile


def measure(root):
    sys.path.insert(0, str(root))
    from server.game.entities import grow, split
    from server.game.world import MultiplayerWorld
    from server.multiplayer import RoomManager

    manager = RoomManager()
    pid = manager.connect()
    manager.command(pid, {"type": "create", "name": "Benchmark"})
    room = next(iter(manager.rooms.values()))
    members = [{"id": pid if i == 0 else f"bot-{i}", "name": f"Bot{i}", "isBot": True} for i in range(4)]
    room.world = MultiplayerWorld(members, random.Random(42))
    room.state, room.round_id = "playing", "benchmark"
    for cells in room.world.cells.values():
        grow(cells[0], 476)
        for _ in range(3):
            split(cells, (1, 0), lambda: room.world.new_id("cell"))
    manager.broadcast_state(room)
    initial = sum(len((m if isinstance(m, str) else json.dumps(m)).encode()) for m in manager.drain(pid))
    times, wire_bytes, types = [], 0, Counter()
    for _ in range(300):
        started = time.perf_counter()
        manager.advance(1 / 30)
        times.append((time.perf_counter() - started) * 1000)
        for message in manager.drain(pid):
            payload = message if isinstance(message, str) else json.dumps(message)
            wire_bytes += len(payload.encode())
            types[json.loads(payload)["type"]] += 1
    manager.close()
    return {"meanTickMs": round(statistics.mean(times), 3), "p95TickMs": round(sorted(times)[284], 3),
            "initialBytes": initial, "steadyKBpsPerClient": round(wire_bytes / 10 / 1024, 2),
            "messages": dict(types)}


def compare():
    root = Path(__file__).resolve().parents[1]
    baseline = sys.argv[sys.argv.index("--baseline") + 1] if "--baseline" in sys.argv else "0af35ac"
    output_dir = root / "dist"
    output_dir.mkdir(exist_ok=True)
    archive = subprocess.check_output(["git", "archive", "--format=zip", baseline], cwd=root)
    with tempfile.TemporaryDirectory(prefix="orbit-benchmark-", dir=output_dir) as directory:
        target = Path(directory).resolve()
        # 临时目录严格限制在项目 dist 下，归档来自本地 Git 对象。
        if target.parent != output_dir.resolve():
            raise RuntimeError("Unexpected benchmark directory")
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            bundle.extractall(target)
        command = [sys.executable, str(Path(__file__).resolve()), "--worker"]
        before = json.loads(subprocess.check_output(command + [str(target)], cwd=root))
        after = json.loads(subprocess.check_output(command + [str(root)], cwd=root))
    report = {"scenario": "4 bots; 32 starting cells; 560 foods; 300 ticks / 10 simulated seconds; seed 42",
              "baselineCommit": baseline, "before": before, "after": after,
              "networkReductionPercent": round((1 - after["steadyKBpsPerClient"] / before["steadyKBpsPerClient"]) * 100, 1)}
    (output_dir / "upgrade-benchmark.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    if "--worker" in sys.argv:
        print(json.dumps(measure(Path(sys.argv[-1]))))
    else:
        compare()
