"""联机外观白名单。未知或缺失字段始终回退默认值，旧客户端仍可加入房间。"""

BALL_SKIN_ORDER = (
    "mint-orbit",
    "ocean-tide",
    "ember-sun",
    "violet-nebula",
    "pixel-grid",
    "citrus-stripes",
)

SPORE_SKIN_ORDER = (
    "dew-drop",
    "comet-tail",
    "flower-bloom",
    "spark-crystal",
    "orbit-ring",
    "zigzag-seed",
)

# 集合只用于 O(1) 白名单校验；有序元组用于给人机和旧客户端稳定分配外观。
BALL_SKIN_IDS = frozenset(BALL_SKIN_ORDER)
SPORE_SKIN_IDS = frozenset(SPORE_SKIN_ORDER)

DEFAULT_APPEARANCE = {
    "ballSkin": "mint-orbit",
    "sporeSkin": "dew-drop",
}


def normalize_appearance(value=None):
    """分别规范化两个字段，避免一个非法 ID 清空另一项合法选择。"""
    source = value if isinstance(value, dict) else {}
    ball_skin = source.get("ballSkin")
    spore_skin = source.get("sporeSkin")
    return {
        "ballSkin": ball_skin if ball_skin in BALL_SKIN_IDS else DEFAULT_APPEARANCE["ballSkin"],
        "sporeSkin": spore_skin if spore_skin in SPORE_SKIN_IDS else DEFAULT_APPEARANCE["sporeSkin"],
    }
