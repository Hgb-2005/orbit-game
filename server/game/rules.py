"""房间规则的唯一入口；只接受白名单参数，客户端不能修改物理或生命数。"""

from dataclasses import asdict, dataclass
import json


TEAMS = (("薄荷队", "#93d9bc"), ("星云队", "#b5a3e8"))


@dataclass(frozen=True)
class RoomRules:
    mode: str = "survival"
    duration: int = 300
    botCount: int = -1  # -1 自动补满；指定数量仍受四席上限约束。
    botDifficulty: str = "standard"
    foodDensity: str = "normal"
    initialMass: int = 36

    @classmethod
    def parse(cls, value=None):
        if value is None:
            return cls()
        if not isinstance(value, dict) or set(value) - set(cls.__dataclass_fields__):
            raise ValueError("房间规则包含不支持的设置。")
        mode, duration = value.get("mode", "survival"), value.get("duration", 300)
        if mode not in ("survival", "teams", "shrink"):
            raise ValueError("请选择生存乱斗、缩圈乱斗或 2v2 团队模式。")
        if type(duration) is not int or duration not in (180, 300, 480):
            raise ValueError("对局时长只能选择 3、5 或 8 分钟。")
        bots, difficulty = value.get("botCount", -1), value.get("botDifficulty", "standard")
        density, mass = value.get("foodDensity", "normal"), value.get("initialMass", 36)
        if type(bots) is not int or bots not in (-1, 0, 1, 2, 3):
            raise ValueError("人机数量只能自动补满或选择 0～3 名。")
        if difficulty not in ("casual", "standard", "challenge"):
            raise ValueError("请选择休闲、标准或挑战人机。")
        if density not in ("sparse", "normal", "rich"):
            raise ValueError("请选择稀疏、标准或密集食物。")
        if type(mass) is not int or mass not in (36, 72, 144):
            raise ValueError("开局质量只能选择 36、72 或 144 m。")
        if mode == "teams" and bots != -1:
            raise ValueError("2v2 团队需要自动补满四席。")
        return cls(mode, duration, bots, difficulty, density, mass)

    @property
    def ranked(self):
        return self.mode != "shrink" and self.botCount == -1 and self.botDifficulty == "standard" and self.foodDensity == "normal" and self.initialMass == 36

    def ai_count(self, humans):
        free = max(0, 4 - humans)
        return free if self.botCount == -1 else min(self.botCount, free)

    @property
    def record_key(self):
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))

    def snapshot(self):
        return asdict(self)
