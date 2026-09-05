import contextlib
import functools
import http.server
import mimetypes
import pathlib
import threading
import time
import urllib.parse


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ServerState:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests = {}
        self.delays = {}
        self.failures = {}

    def reset(self):
        with self.lock:
            self.requests.clear()
            self.delays.clear()
            self.failures.clear()

    def count(self, path):
        with self.lock:
            return self.requests.get(path, 0)


class SearchHandler(http.server.SimpleHTTPRequestHandler):
    state = None

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        with self.state.lock:
            self.state.requests[path] = self.state.requests.get(path, 0) + 1
            delay = self.state.delays.get(path, 0)
            failure = self.state.failures.get(path)
        if delay:
            time.sleep(delay)
        if failure:
            self.send_error(failure)
            return
        super().do_GET()

    def translate_path(self, path):
        clean = urllib.parse.urlsplit(path).path
        if clean == "/search":
            clean = "/search/"
        if clean.startswith("/search/"):
            clean = clean[len("/search") :]
        return super().translate_path(clean)

    def guess_type(self, path):
        if path.endswith(".json.gz"):
            return "application/gzip"
        if path.endswith(".json"):
            return "application/json"
        if path.endswith(".js"):
            return "text/javascript"
        if path.endswith(".css"):
            return "text/css"
        return mimetypes.guess_type(path)[0] or "application/octet-stream"

    def log_message(self, *_args):
        pass


@contextlib.contextmanager
def local_server():
    state = ServerState()
    handler_class = type("StatefulSearchHandler", (SearchHandler,), {"state": state})
    handler = functools.partial(handler_class, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
