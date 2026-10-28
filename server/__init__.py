"""Flask 应用工厂：注册 HTTP、SQLite 和联机房间，各模块保持独立。"""

from pathlib import Path

from flask import Flask

from . import database
from .routes import bp
from .multiplayer import init_multiplayer


def create_app(test_config=None):
    root = Path(__file__).resolve().parent.parent
    app = Flask(__name__, template_folder=str(root / "templates"),
                static_folder=str(root / "static"), instance_path=str(root / "instance"))
    app.config.from_mapping(DATABASE=str(root / "instance" / "game.sqlite3"),
                            MAX_CONTENT_LENGTH=32768)
    if test_config:
        app.config.update(test_config)

    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    app.teardown_appcontext(database.close_db)
    with app.app_context():
        database.init_db()
    app.register_blueprint(bp)
    @app.after_request
    def revalidate_game_assets(response):
        # ES 模块彼此引用时不带入口版本串，每次重验证防止新旧规则混用。
        if response.mimetype in ("text/html", "text/javascript", "application/javascript", "text/css"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    init_multiplayer(app)
    return app
