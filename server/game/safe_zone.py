"""缩圈时间表与圈外惩罚。只接受服务端时钟，不接受客户端上报的位置或伤害。"""
import math

from .entities import grow


class SafeZone:
    exposure_limit = 8.0

    def __init__(self, bounds, duration):
        self.x, self.y = bounds['width'] / 2, bounds['height'] / 2
        self.initial_radius = math.hypot(self.x, self.y) + 20
        self.duration = duration

    def at(self, elapsed):
        """每局三次缩圈；提前五秒预告，每次用十五秒平滑缩至下一圈。"""
        radius = self.initial_radius
        for index, (fraction, ratio) in enumerate(((.25, .62), (.5, .4), (.75, .19))):
            start, target = self.duration * fraction, self.initial_radius * ratio
            if elapsed < start:
                return dict(x=self.x, y=self.y, radius=radius, nextRadius=target, stage=index,
                            phase='warning' if elapsed >= start - 5 else 'waiting',
                            remaining=max(0, start - elapsed), exposureLimit=self.exposure_limit)
            if elapsed < start + 15:
                progress = max(0, (elapsed - start) / 15)
                return dict(x=self.x, y=self.y, radius=radius + (target - radius) * progress,
                            nextRadius=target, stage=index + 1, phase='shrinking',
                            remaining=start + 15 - elapsed, exposureLimit=self.exposure_limit)
            radius = target
        return dict(x=self.x, y=self.y, radius=radius, nextRadius=radius, stage=3,
                    phase='final', remaining=0, exposureLimit=self.exposure_limit)

    @staticmethod
    def outside(cell, state, padding=0):
        # 按分身圆心判定，大球仍有进入最终安全区的空间。
        return math.hypot(cell['x'] - state['x'], cell['y'] - state['y']) > state['radius'] - padding

    def apply(self, world, dt):
        state = self.at(world.elapsed)
        for owner_id, owner in world.players.items():
            cells = world.cells[owner_id]
            if not cells or owner['lives'] <= 0 or owner['protectedUntil'] > world.elapsed:
                owner['zoneExposure'] = 0
                continue
            outside = [cell for cell in cells if self.outside(cell, state)]
            # 每个圈外分身每秒损失 2%（至少 1 m），最低保留 12 m。
            for cell in outside:
                loss = min(max(0, cell['mass'] - 12), max(1, cell['mass'] * .02) * dt)
                grow(cell, -loss)
            owner['zoneExposure'] = owner['zoneExposure'] + dt if len(outside) == len(cells) else 0
            if owner['zoneExposure'] + 1e-8 < self.exposure_limit:
                continue
            owner['lives'] -= 1
            owner['deaths'] += 1
            owner['killer'] = '安全区外'
            owner['stats'].death(world.elapsed, 'zone', mass=sum(c['mass'] for c in cells))
            for cell in cells:
                owner['stats'].record({'type': 'celllost'}, world.tick)
            world.cells[owner_id] = []
            owner['zoneExposure'] = 0
            world.emit('zone-death', owner, lives=owner['lives'])
            if owner['lives'] > 0:
                world.respawn(owner)
            else:
                world.emit('eliminated', owner, name=owner['name'])
        world.check_victory()
