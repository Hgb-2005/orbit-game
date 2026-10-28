"""团队人机的协作意图；只生成普通输入，不直接修改质量或传送位置。"""
import math


def distance(a, b):
    return math.hypot(a['x'] - b['x'], a['y'] - b['y'])


def toward(a, b):
    dx, dy = b['x'] - a['x'], b['y'] - a['y']
    length = math.hypot(dx, dy) or 1
    return dx / length, dy / length


def clear_feed_path(start, end, spikes):
    dx, dy = end['x'] - start['x'], end['y'] - start['y']
    length_squared = dx * dx + dy * dy or 1
    for spike in spikes:
        t = max(0, min(1, ((spike['x'] - start['x']) * dx + (spike['y'] - start['y']) * dy) / length_squared))
        if math.hypot(spike['x'] - start['x'] - dx * t, spike['y'] - start['y'] - dy * t) < spike['radius'] + 16:
            return False
    return True


def cooperate(owner, cells, world, enemies, threat):
    if world.rules.mode != 'teams' or not owner.get('isBot'):
        return None
    bot = max(cells, key=lambda c: c['mass'])
    weakest = min(c['mass'] for c in cells)
    allies = [c for c in world.all_cells() if c['ownerId'] != owner['ownerId']
              and world.allies(owner, world.players[c['ownerId']])
              and world.players[c['ownerId']]['connected'] and world.players[c['ownerId']]['lives'] > 0]
    signals = [s for s in world.signals.snapshot(world.elapsed) if s['team'] == owner['team']
               and s['ownerId'] != owner['ownerId'] and world.players.get(s['ownerId'], {}).get('connected')
               and world.players[s['ownerId']]['lives'] > 0]

    def plan(target, action, stop=0, spore=False):
        dx, dy = toward(bot, target) if distance(bot, target) > stop else (0, 0)
        return dict(x=dx, y=dy, target=None, regroup=False, split=False, spore=spore, teamAction=action)

    # 逃生优先于标点。队友能吃掉追击者时才向其靠拢，防止把敌人带给更小的队友。
    if threat:
        enemy = threat[2]
        shelter = min((c for c in allies if c['mass'] >= enemy['mass'] * 1.28
                       and distance(bot, c) < 750
                       and sum(a * b for a, b in zip(toward(bot, c), toward(enemy, bot))) > .15),
                      key=lambda c: distance(bot, c), default=None)
        return plan(shelter, 'retreat') if shelter else None
    danger = next((s for s in reversed(signals) if s['kind'] == 'danger' and distance(bot, s) < 420), None)
    if danger:
        dx, dy = toward(danger, bot)
        if distance(danger, bot) < 1:
            dx, dy = toward(bot, {'x': world.bounds_width / 2, 'y': world.bounds_height / 2})
            if abs(dx) + abs(dy) < .01:
                dx = 1
        return dict(x=dx, y=dy, target=None, regroup=False, split=False, teamAction='avoid')

    # 安全喂食限于近处较小的队友；保留至少 112 m，每两秒最多吐一颗。
    receiver = min((c for c in allies if bot['mass'] >= 120 and c['mass'] < bot['mass'] * .8
                    and bot['radius'] + c['radius'] + 28 < distance(bot, c) < 330
                    and clear_feed_path(bot, c, world.spikes)
                    and not any(distance(e, bot) < e['radius'] + bot['radius'] + 550
                                or distance(e, c) < e['radius'] + c['radius'] + 420 for e in enemies)),
                   key=lambda c: (world.players[c['ownerId']]['isBot'], distance(bot, c)), default=None)
    command = next((s for s in reversed(signals) if s['kind'] in ('help', 'gather')), None)
    if command:
        # 不把标点当无条件冲锋令：危险目标只观察，不执行，也不主动分裂。
        unsafe = any(e['mass'] >= weakest * 1.28 and distance(e, command) < e['radius'] + 300 for e in enemies)
        if not unsafe:
            if receiver and distance(receiver, command) < 180 and distance(bot, command) < 350:
                return plan(receiver, 'feed', spore=world.elapsed >= owner.get('botFeedAt', 0))
            return plan(command, 'support' if command['kind'] == 'help' else 'gather', stop=90)
        return None
    if receiver:
        return plan(receiver, 'feed', spore=world.elapsed >= owner.get('botFeedAt', 0))
    return None
