"""SQLite 持久层：每个请求独立连接，使用原子更新保证最高分只增不减。"""

import sqlite3
import json

from flask import current_app, g


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"], timeout=10)
        g.db.row_factory = sqlite3.Row
    return g.db


def close_db(_error=None):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def init_db():
    connection = get_db()
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            high_score INTEGER NOT NULL DEFAULT 0 CHECK (high_score >= 0),
            updated_at TEXT
        );
        INSERT OR IGNORE INTO records (id, high_score) VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS custom_records (
            rules_key TEXT PRIMARY KEY,
            high_score INTEGER NOT NULL DEFAULT 0 CHECK (high_score >= 0),
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS match_history (
            serial INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id TEXT NOT NULL UNIQUE,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
    """)
    connection.commit()


def read_record():
    row = get_db().execute(
        "SELECT high_score, updated_at FROM records WHERE id = 1"
    ).fetchone()
    return dict(row)


def save_record(score):
    connection = get_db()
    # 将比较放进 SQL，避免两个请求先读后写导致较低分覆盖较高分。
    with connection:
        cursor = connection.execute("""
            UPDATE records
            SET high_score = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = 1 AND high_score < ?
        """, (score, score))
        is_new_record = cursor.rowcount == 1
        record = read_record()
    return {**record, "is_new_record": is_new_record}


def save_custom_record(score, rules_key):
    """自定义成绩按完整规则分别记，绝不改写标准 records。只从权威结算调用。"""
    connection = get_db()
    with connection:
        connection.execute("INSERT OR IGNORE INTO custom_records (rules_key) VALUES (?)", (rules_key,))
        cursor = connection.execute("""
            UPDATE custom_records SET high_score = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE rules_key = ? AND high_score < ?
        """, (score, rules_key, score))
        record = dict(connection.execute("SELECT high_score, updated_at FROM custom_records WHERE rules_key = ?", (rules_key,)).fetchone())
    return {**record, "is_new_record": cursor.rowcount == 1}


def save_match_history(match):
    """同一回合重试只写一次；整局（含所有真人）占一条，最多保留 20 局。"""
    connection = get_db()
    with connection:
        connection.execute('INSERT OR IGNORE INTO match_history (match_id, payload) VALUES (?, ?)',
                           (match['id'], json.dumps(match, ensure_ascii=False, separators=(',', ':'))))
        connection.execute('DELETE FROM match_history WHERE serial NOT IN '
                           '(SELECT serial FROM match_history ORDER BY serial DESC LIMIT 20)')
    return {'saved': True, 'id': match['id']}


def read_match_history():
    rows = get_db().execute('SELECT payload, created_at FROM match_history ORDER BY serial DESC LIMIT 20').fetchall()
    return [{**json.loads(row['payload']), 'createdAt': row['created_at']} for row in rows]
