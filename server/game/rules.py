"""房间规则的唯一入口；只接受白名单参数，客户端不能修改物理或生命数。"""

from dataclasses import asdict, dataclass


TEAMS = (("薄荷队", "#93d9bc"), ("星云队", "#b5a3e8"))


@dataclass(frozen=True)
class RoomRules:
    mode: str = "survival"
    duration: int = 300

    @classmethod
    def parse(cls, value=None):
        if value is None:
            return cls()
        if not isinstance(value, dict) or set(value) - {"mode", "duration"}:
            raise ValueError("房间规则仅支持玩法和时长设置。")
        mode, duration = value.get("mode", "survival"), value.get("duration", 300)
        if mode not in ("survival", "teams"):
            raise ValueError("请选择生存乱斗或 2v2 团队模式。")
        if type(duration) is not int or duration not in (180, 300, 480):
            raise ValueError("对局时长只能选择 3、5 或 8 分钟。")
        return cls(mode, duration)

    def snapshot(self):
        return asdict(self)
