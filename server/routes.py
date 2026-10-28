"""HTTP 边界：验证输入，调用持久层，不混入游戏计算或绘制代码。"""

from flask import Blueprint, jsonify, render_template, request

from .database import read_record, save_record
from .database import read_match_history, save_match_history
from .history import local_history
from .network_info import lan_addresses
from urllib.parse import urlsplit

bp = Blueprint("game", __name__)


@bp.get("/")
def index():
    return render_template("index.html")


@bp.get("/api/network-info")
def network_info():
    port = urlsplit(request.host_url).port
    suffix = f":{port}" if port else ""
    response = jsonify(urls=[f"{request.scheme}://{address}{suffix}/" for address in lan_addresses()])
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.get("/api/high-score")
def high_score():
    response = jsonify(read_record())
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.post("/api/scores")
def submit_score():
    if not request.is_json:
        return jsonify(error="请使用 JSON 提交分数。"), 415
    payload = request.get_json(silent=True)
    score = payload.get("score") if isinstance(payload, dict) else None
    # bool 在 Python 中也是 int 的子类，这里必须显式排除。
    if type(score) is not int or not 0 <= score <= 1_000_000_000:
        return jsonify(error="score 必须是 0 到 1000000000 之间的整数。"), 400
    return jsonify(save_record(score))


@bp.get('/api/history')
def match_history():
    response = jsonify(matches=read_match_history())
    response.headers['Cache-Control'] = 'no-store'
    return response


@bp.post('/api/history')
def submit_history():
    if not request.is_json:
        return jsonify(error='请使用 JSON 提交单机复盘。'), 415
    try:
        match = local_history(request.get_json(silent=True))
    except ValueError as error:
        return jsonify(error=str(error)), 400
    return jsonify(save_match_history(match))
