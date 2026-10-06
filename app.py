import json
import os
import sys

import webview

APP_NAME = "MonthTasks"


def resource(*parts):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


DATA_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), APP_NAME)
DATA_FILE = os.path.join(DATA_DIR, "data.json")
CONFIG_FILE = os.path.join(DATA_DIR, "sync.json")


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def write(path, data):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(data)
    os.replace(tmp, path)


class Api:
    def load(self):
        return read(DATA_FILE)

    def save(self, data):
        json.loads(data)  # refuse to write anything that isn't valid JSON
        write(DATA_FILE, data)
        return True

    def load_config(self):
        return read(CONFIG_FILE)

    def save_config(self, data):
        if data:
            json.loads(data)
            write(CONFIG_FILE, data)
        elif os.path.exists(CONFIG_FILE):
            os.remove(CONFIG_FILE)
        return True


if __name__ == "__main__":
    webview.create_window(
        "Month Tasks",
        resource("web", "index.html"),
        js_api=Api(),
        width=460,
        height=860,
        min_size=(400, 640),
        background_color="#FCFCFA",
    )
    # served over localhost (not file://) so the page can talk to the GitHub API for sync
    webview.start(private_mode=True, http_server=True)
