"""服务端均匀空间网格；只缩小候选集合，不改变权威碰撞规则。"""

import math


class SpatialGrid:
    def __init__(self, cell_size=180):
        self.cell_size = max(16, cell_size)
        self.cells = {}
        self.entities = {}

    def clear(self):
        self.cells.clear()
        self.entities.clear()

    def _key(self, x, y):
        return math.floor(x / self.cell_size), math.floor(y / self.cell_size)

    def insert(self, entity, radius=None):
        radius = entity.get("radius", 0) if radius is None else radius
        min_x = math.floor((entity["x"] - radius) / self.cell_size)
        max_x = math.floor((entity["x"] + radius) / self.cell_size)
        min_y = math.floor((entity["y"] - radius) / self.cell_size)
        max_y = math.floor((entity["y"] + radius) / self.cell_size)
        entity_id = id(entity)
        self.entities[entity_id] = entity
        for cell_x in range(min_x, max_x + 1):
            for cell_y in range(min_y, max_y + 1):
                self.cells.setdefault((cell_x, cell_y), set()).add(entity_id)

    def build(self, entities, radius_for=None):
        self.clear()
        for entity in entities:
            self.insert(entity, radius_for(entity) if radius_for else None)
        return self

    def query_circle(self, x, y, radius):
        min_x = math.floor((x - radius) / self.cell_size)
        max_x = math.floor((x + radius) / self.cell_size)
        min_y = math.floor((y - radius) / self.cell_size)
        max_y = math.floor((y + radius) / self.cell_size)
        found = set()
        for cell_x in range(min_x, max_x + 1):
            for cell_y in range(min_y, max_y + 1):
                found.update(self.cells.get((cell_x, cell_y), ()))
        return [self.entities[entity_id] for entity_id in found]
