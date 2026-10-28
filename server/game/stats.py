"""服务器累计本局行为，客户端只能读取快照，不能提交复盘数值。"""

COUNTERS = {"food": "foods", "eat": "cellsEaten", "spore": "sporesEmitted", "spore-eat": "sporesEaten",
            "spike-feed": "spikesFed", "spike-launch": "spikesLaunched", "merge": "merges",
            "spike": "spikeHits", "celllost": "cellsLost"}


class RoundStats:
    def __init__(self):
        self.values = {key: 0 for key in COUNTERS.values()}
        self.values.update(splits=0, maxCells=1, peakMass=36, activeSeconds=0)
        self.last_split_tick = None
        self.timeline = []
        self.death_log = []
        self.sample_interval = 2

    def sample(self, elapsed, cells, force=False):
        """最多 121 个采样点；长局逐次降采样，保留起点与最终状态。"""
        mass = round(sum(c['mass'] for c in cells if c['alive']), 1)
        point = [round(elapsed, 3), mass]
        if self.timeline and self.timeline[-1] == point:
            return
        if not force and self.timeline and elapsed - self.timeline[-1][0] < self.sample_interval:
            return
        self.timeline.append(point)
        if len(self.timeline) > 121:
            self.timeline = self.timeline[::2] + [self.timeline[-1]]
            self.sample_interval *= 2

    def death(self, elapsed, cause, killer='', mass=0):
        self.death_log.append(dict(time=round(elapsed, 3), cause=cause, killer=killer, mass=round(mass, 1)))
        self.death_log = self.death_log[-40:]
        self.sample(elapsed, [], True)

    def record(self, event, tick):
        key = COUNTERS.get(event["type"])
        if key:
            self.values[key] += 1
        if event["type"] == "split" and self.last_split_tick != tick:
            self.values["splits"] += 1
            self.last_split_tick = tick

    def observe(self, cells):
        live = [cell for cell in cells if cell["alive"]]
        self.values["maxCells"] = max(self.values["maxCells"], len(live))
        self.values["peakMass"] = max(self.values["peakMass"], sum(cell["mass"] for cell in live))

    def snapshot(self, recap=False):
        result = {**self.values, "activeSeconds": round(self.values["activeSeconds"], 3)}
        if recap:
            result.update(massTimeline=[list(p) for p in self.timeline], deathLog=[dict(d) for d in self.death_log])
        return result

    def advance(self, dt):
        self.values["activeSeconds"] += dt
