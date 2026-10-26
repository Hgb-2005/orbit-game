"""食物增量复制：以连接上次实际取走的数据为基线，慢客户端也不会漏补丁。"""

from dataclasses import dataclass
from functools import cached_property
import json


def encode(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


@dataclass(frozen=True)
class FoodFrame:
    round_id: str
    version: int
    foods: dict

    @classmethod
    def capture(cls, round_id, version, foods):
        # 拍下独立的公开数据；世界换位时会原地修改食物，不能保留可变引用。
        copies = {food["id"]: {key: round(value, 3) if type(value) is float else value
                              for key, value in food.items() if key in ("id", "x", "y", "radius", "color", "hotspotId")}
                  for food in foods}
        return cls(round_id, version, copies)

    @cached_property
    def full_message(self):
        # 同一帧会发给多个连接，全量编码只做一次。
        return encode({"type": "foods", "roundId": self.round_id,
                       "version": self.version, "foods": list(self.foods.values())})

    def message(self, baseline=None, base_version=-1):
        full = self.full_message
        if baseline is None:
            return full
        patch = encode({"type": "food_patch", "roundId": self.round_id,
                        "baseVersion": base_version, "version": self.version,
                        "upsert": [food for key, food in self.foods.items() if baseline.get(key) != food],
                        "removed": [key for key in baseline if key not in self.foods]})
        # 富集区大量换位时，全量可能更短；首帧和重连也始终发送全量。
        return patch if len(patch) < len(full) else full
