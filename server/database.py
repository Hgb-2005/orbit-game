"""SQLite 持久层：每个请求独立连接，使用原子更新保证最高分只增不减。"""

import sqlite3

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
