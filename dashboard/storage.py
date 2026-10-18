"""JSON ファイルによる簡易永続化（勤怠・タスク・ショートカット）。"""

import json
import os
import threading
import uuid

_lock = threading.Lock()


class JsonStore:
    def __init__(self, path, default):
        self.path = path
        self.default = default

    def load(self):
        with _lock:
            if not os.path.exists(self.path):
                return json.loads(json.dumps(self.default))
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)

    def save(self, data):
        with _lock:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)


def new_id():
    return uuid.uuid4().hex[:12]
