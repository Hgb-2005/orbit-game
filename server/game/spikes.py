"""喂刺与移动刺球的纯规则；不依赖房间、WebSocket 或绘制。"""

import math

FEED_COUNT = 5
MAX_SPIKES = 16
LAUNCH_SPEED = 720
LAUNCH_DECAY = 1.6
LIFETIME = 8


def update_spikes(spikes, dt, bounds):
    for spike in spikes:
        if not spike.get("projectile"):
            continue
        step = min(dt, max(0, spike["life"]))
        decay = math.exp(-LAUNCH_DECAY * step)
        travel = (1 - decay) / LAUNCH_DECAY
        for axis, limit in (("x", bounds["width"]), ("y", bounds["height"])):
            velocity = "v" + axis
            position = spike[axis] + spike[velocity] * travel
            spike[axis] = max(spike["radius"], min(limit - spike["radius"], position))
            spike[velocity] = spike[velocity] * decay if spike[axis] == position else 0
        spike["life"] -= dt
    return [spike for spike in spikes if not spike.get("projectile") or spike["life"] > 0]


def feed_spikes(spikes, spores, bounds, next_id):
    """同颗孢子最多喂一次；达到实体上限时不再吞掉孢子。"""
    events = []
    fixed = [spike for spike in spikes if not spike.get("projectile")]
    for spore in spores:
        if not spore["alive"] or len(spikes) >= MAX_SPIKES:
            continue
        spike = next((candidate for candidate in fixed if
                      (candidate["x"] - spore["x"]) ** 2 + (candidate["y"] - spore["y"]) ** 2
                      <= (candidate["radius"] * .72 + spore["radius"]) ** 2), None)
        if spike is None:
            continue
        spore["alive"] = False
        spike["charge"] = spike.get("charge", 0) + 1
        events.append({"type": "spike-feed", "actorId": spore.get("ownerId"), "x": spike["x"], "y": spike["y"], "color": spike["color"]})
        if spike["charge"] < FEED_COUNT:
            continue
        dx, dy = spore["vx"], spore["vy"]
        if math.hypot(dx, dy) < .001:
            dx, dy = spike["x"] - spore["x"], spike["y"] - spore["y"]
        length = math.hypot(dx, dy)
        dx, dy = (dx / length, dy / length) if length >= .001 else (1, 0)
        spike["charge"] = 0
        radius = spike["radius"]
        launched = {"id": next_id(), "radius": radius, "projectile": True, "life": LIFETIME,
                    "x": max(radius, min(bounds["width"] - radius, spike["x"] + dx * (radius * 2 + 4))),
                    "y": max(radius, min(bounds["height"] - radius, spike["y"] + dy * (radius * 2 + 4))),
                    "vx": dx * LAUNCH_SPEED, "vy": dy * LAUNCH_SPEED, "color": "#a5e17e"}
        spikes.append(launched)
        events.append({"type": "spike-launch", "actorId": spore.get("ownerId"), "x": launched["x"], "y": launched["y"], "color": launched["color"]})
    return events
