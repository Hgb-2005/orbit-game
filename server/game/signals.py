"""有期限的队伍标点；身份、队伍和冷却都取自权威世界。"""
import math

from .entities import BOUNDS, clamp


class TeamSignals:
    lifetime = 6
    cooldown = 2
    kinds = ('gather', 'help', 'danger')

    def __init__(self):
        self.items = []
        self.next_at = {}
        self.serial = 0

    def send(self, world, owner_id, message):
        owner = world.players.get(owner_id)
        if world.finished or world.rules.mode != 'teams' or not owner or not owner['connected'] or owner['lives'] <= 0:
            raise ValueError('只有正在参赛的团队玩家可以标点。')
        kind, x, y = message.get('kind'), message.get('x'), message.get('y')
        if kind not in self.kinds or any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 10_000_000 for v in (x, y)):
            raise ValueError('请选择有效的标点类型和地图位置。')
        if self.next_at.get(owner_id, 0) > world.elapsed:
            raise ValueError('标点间隔为两秒，请稍候。')
        self.serial += 1
        self.items = [item for item in self.items if item['ownerId'] != owner_id and item['expiresAt'] > world.elapsed]
        self.items.append(dict(id=self.serial, ownerId=owner_id, name=owner['name'], team=owner['team'], kind=kind,
                               x=clamp(x, 0, BOUNDS['width']), y=clamp(y, 0, BOUNDS['height']),
                               expiresAt=world.elapsed + self.lifetime))
        self.next_at[owner_id] = world.elapsed + self.cooldown

    def snapshot(self, elapsed):
        return [dict(item) for item in self.items if item['expiresAt'] > elapsed]

    def remaining(self, owner_id, elapsed):
        return max(0, self.next_at.get(owner_id, 0) - elapsed)
