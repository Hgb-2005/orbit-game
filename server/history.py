"""对局归档的格式边界。单机为客户端记录；联机只从服务器世界生成。"""
import math
import re

STAT_KEYS = ('foods', 'cellsEaten', 'sporesEmitted', 'sporesEaten', 'spikesFed', 'spikesLaunched',
             'splits', 'merges', 'spikeHits', 'cellsLost', 'maxCells', 'peakMass', 'activeSeconds')


def number(value, limit=1_000_000_000):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= limit:
        raise ValueError('复盘数据包含无效数值。')
    return value


def local_history(payload):
    if not isinstance(payload, dict) or payload.get('mode') not in ('classic', 'survival'):
        raise ValueError('只能提交已结束的单机经典或生存局。')
    match_id = payload.get('id')
    if not isinstance(match_id, str) or not re.fullmatch(r'local-[a-zA-Z0-9-]{8,80}', match_id):
        raise ValueError('无效的单机对局编号。')
    duration = number(payload.get('duration'), 604800)
    stats = payload.get('stats')
    if not isinstance(stats, dict):
        raise ValueError('缺少本局统计。')
    clean = {key: number(stats.get(key, 0)) for key in STAT_KEYS}
    timeline, deaths = stats.get('massTimeline', []), stats.get('deathLog', [])
    if not isinstance(timeline, list) or len(timeline) > 121 or not isinstance(deaths, list) or len(deaths) > 40:
        raise ValueError('复盘采样数量超出限制。')
    clean['massTimeline'], clean['deathLog'] = [], []
    previous = -1
    for point in timeline:
        if not isinstance(point, list) or len(point) != 2:
            raise ValueError('无效的质量曲线。')
        t, mass = number(point[0], duration), number(point[1])
        if t < previous:
            raise ValueError('质量曲线必须按时间排序。')
        previous = t
        clean['massTimeline'].append([t, mass])
    for death in deaths:
        if not isinstance(death, dict) or death.get('cause') != 'eaten':
            raise ValueError('无效的生命损失记录。')
        killer = death.get('killer', '')
        if not isinstance(killer, str) or len(killer) > 40:
            raise ValueError('无效的对手名称。')
        clean['deathLog'].append(dict(time=number(death.get('time'), duration), cause='eaten',
                                     killer=killer, mass=number(death.get('mass', 0))))
    rank = payload.get('rank')
    if rank is not None and (type(rank) is not int or not 1 <= rank <= 100):
        raise ValueError('无效的名次。')
    won = payload.get('won', False)
    if type(won) is not bool:
        raise ValueError('无效的结算状态。')
    return dict(id=match_id, source='local', mode=payload['mode'], duration=duration,
                reason='eliminated' if payload['mode'] == 'classic' else 'complete',
                participants=[dict(name='单机玩家', rank=rank, won=won, kills=number(payload.get('kills', 0)),
                                   score=number(payload.get('score', 0)), stats=clean)])


def network_history(room, abandoned=False):
    world = room.world
    standings = {p['ownerId']: p for p in world.standings()}
    teams = {t['id']: t for t in world.team_standings()}
    participants = []
    for pid, owner in world.players.items():
        if owner['isBot']:
            continue
        standing = teams[owner['team']] if world.rules.mode == 'teams' else standings[pid]
        owner['stats'].sample(world.elapsed, world.cells[pid], True)
        won = not abandoned and standing['rank'] == 1 and (standing.get('active', owner['lives']) > 0)
        participants.append(dict(name=owner['name'], rank=standing['rank'], won=won,
                                 kills=owner['kills'], score=owner['score'], stats=owner['stats'].snapshot(True)))
    return dict(id='net-' + room.round_id, source='server',
                mode='network-survival' if world.rules.mode == 'survival' else world.rules.mode,
                rules=world.rules.snapshot(), duration=round(world.elapsed, 3),
                reason='abandoned' if abandoned else world.reason, participants=participants)
