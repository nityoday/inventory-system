#!/usr/bin/env python3
"""
Home Inventory - web server.

A tiny, dependency-free server (Python standard library only) that

  * serves the single-page web app from ./static, and
  * exposes a small JSON API under /api/ backed by one JSON file.

Run:   python3 server.py                       (http://<pi-address>:8080)
       python3 server.py --port 8080 --data /path/to/inventory.json

For the trusted home network only: there is deliberately no login.
"""

import argparse
import json
import mimetypes
import os
import re
import signal
import sys
import threading
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from store import InventoryError, Store, StoreLoadError

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

MAX_JSON_BODY = 1 * 1024 * 1024          # ordinary requests
MAX_IMPORT_BODY = 32 * 1024 * 1024       # inventory imports

ID = r"([A-Za-z0-9_\-]{1,100})"


def make_handler(store):
    class Handler(BaseHTTPRequestHandler):
        server_version = "HomeInventory/1.0"
        sys_version = ""

        # ------------------------------------------------------------------
        # plumbing
        # ------------------------------------------------------------------
        def log_message(self, fmt, *args):
            # Keep the journal readable: skip the 5-second polling requests.
            if self.path.startswith("/api/revision"):
                return
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def _send_json(self, status, payload, extra_headers=None):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra_headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _send_error(self, err):
            body = {"error": {"code": err.code, "message": err.message}}
            if err.field:
                body["error"]["field"] = err.field
            self._send_json(err.status, body)

        def _read_body(self, limit):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise InventoryError("bad_request", "Invalid request.", 400)
            if length > limit:
                raise InventoryError(
                    "too_large",
                    f"That request is too large (limit {limit // (1024 * 1024)} MB).",
                    413,
                )
            return self.rfile.read(length) if length else b""

        def _read_json(self, limit=MAX_JSON_BODY):
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                raise InventoryError("bad_request", "Requests must be sent as application/json.", 415)
            raw = self._read_body(limit)
            try:
                return json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise InventoryError(
                    "invalid_json", "That isn't valid JSON. Choose a file exported from Home Inventory."
                )

        def _check_origin(self):
            """Block browsers on other sites from posting to the Pi (CSRF)."""
            origin = self.headers.get("Origin")
            if origin and origin != "null":
                if urlparse(origin).netloc != (self.headers.get("Host") or ""):
                    raise InventoryError("forbidden", "Cross-site requests are not allowed.", 403)
            elif origin == "null":
                raise InventoryError("forbidden", "Cross-site requests are not allowed.", 403)

        # ------------------------------------------------------------------
        # routing
        # ------------------------------------------------------------------
        def _dispatch(self, method):
            path = urlparse(self.path).path
            if path.startswith("/api/"):
                try:
                    if method in ("POST", "PATCH", "DELETE"):
                        self._check_origin()
                    for m, pattern, handler in ROUTES:
                        if m != method:
                            continue
                        match = re.fullmatch(pattern, path)
                        if match:
                            return handler(self, *[unquote(g) for g in match.groups()])
                    raise InventoryError("not_found", "Unknown API endpoint.", 404)
                except InventoryError as e:
                    self._send_error(e)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception:  # never leak a stack trace to the browser
                    traceback.print_exc()
                    self._send_error(
                        InventoryError("server_error", "Something went wrong on the server. Nothing was changed.", 500)
                    )
            elif method in ("GET", "HEAD"):
                self._serve_static(path)
            else:
                self._send_error(InventoryError("method_not_allowed", "Method not allowed.", 405))

        do_GET = lambda self: self._dispatch("GET")
        do_HEAD = lambda self: self._dispatch("GET")
        do_POST = lambda self: self._dispatch("POST")
        do_PATCH = lambda self: self._dispatch("PATCH")
        do_DELETE = lambda self: self._dispatch("DELETE")

        # ------------------------------------------------------------------
        # static files
        # ------------------------------------------------------------------
        def _serve_static(self, path):
            rel = unquote(path).lstrip("/") or "index.html"
            target = (STATIC_DIR / rel).resolve()
            try:
                target.relative_to(STATIC_DIR)
            except ValueError:
                return self._plain(404, "Not found")
            if not target.is_file():
                return self._plain(404, "Not found")
            st = target.stat()
            etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
                ctype += "; charset=utf-8"
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def _plain(self, status, text):
            body = text.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        # ------------------------------------------------------------------
        # API handlers
        # ------------------------------------------------------------------
        def _state_payload(self, **extra):
            data, revision = store.snapshot()
            state = {
                "schemaVersion": data["schemaVersion"],
                "revision": revision,
                "tags": data["tags"],
                "entries": data["entries"],
            }
            return {"state": state, **extra}

        def api_state(self):
            data, revision = store.snapshot()
            self._send_json(
                200,
                {
                    "schemaVersion": data["schemaVersion"],
                    "revision": revision,
                    "tags": data["tags"],
                    "entries": data["entries"],
                },
            )

        def api_revision(self):
            self._send_json(200, {"revision": store.revision})

        # entries
        def api_entry_create(self):
            body = _require_object(self._read_json())
            entry_id = store.create_entry(
                body.get("name"), body.get("description"), body.get("parentId"), body.get("tagIds", [])
            )
            self._send_json(201, self._state_payload(entryId=entry_id))

        def api_entry_update(self, entry_id):
            body = _require_object(self._read_json())
            store.update_entry(entry_id, body)
            self._send_json(200, self._state_payload(entryId=entry_id))

        def api_entry_move(self, entry_id):
            body = _require_object(self._read_json())
            if "parentId" not in body:
                raise InventoryError("bad_request", "parentId is required (use null for top level).")
            store.move_entry(entry_id, body["parentId"])
            self._send_json(200, self._state_payload(entryId=entry_id))

        def api_entry_subtree(self, entry_id):
            self._send_json(200, store.subtree_info(entry_id))

        def api_entry_delete(self, entry_id):
            deleted = store.delete_entry(entry_id)
            self._send_json(200, self._state_payload(deletedCount=deleted))

        # tags
        def api_tag_create(self):
            body = _require_object(self._read_json())
            tag_id = store.create_tag(body.get("name"))
            self._send_json(201, self._state_payload(tagId=tag_id))

        def api_tag_rename(self, tag_id):
            body = _require_object(self._read_json())
            store.rename_tag(tag_id, body.get("name"))
            self._send_json(200, self._state_payload(tagId=tag_id))

        def api_tag_usage(self, tag_id):
            self._send_json(200, store.tag_usage(tag_id))

        def api_tag_delete(self, tag_id):
            affected = store.delete_tag(tag_id)
            self._send_json(200, self._state_payload(affectedEntries=affected))

        # export / import
        def api_export(self):
            snapshot = store.export()
            body = json.dumps(snapshot, ensure_ascii=False, indent=2).encode("utf-8")
            filename = f"home-inventory-{datetime.now().strftime('%Y-%m-%d')}.json"
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def api_import_validate(self):
            raw = self._read_json(MAX_IMPORT_BODY)
            self._send_json(200, store.validate_import(raw))

        def api_import(self):
            raw = self._read_json(MAX_IMPORT_BODY)
            counts = store.replace_all(raw)
            self._send_json(200, self._state_payload(imported=counts))

    ROUTES = [
        ("GET", r"/api/state", Handler.api_state),
        ("GET", r"/api/revision", Handler.api_revision),
        ("POST", r"/api/entries", Handler.api_entry_create),
        ("PATCH", rf"/api/entries/{ID}", Handler.api_entry_update),
        ("POST", rf"/api/entries/{ID}/move", Handler.api_entry_move),
        ("GET", rf"/api/entries/{ID}/subtree", Handler.api_entry_subtree),
        ("DELETE", rf"/api/entries/{ID}", Handler.api_entry_delete),
        ("POST", r"/api/tags", Handler.api_tag_create),
        ("PATCH", rf"/api/tags/{ID}", Handler.api_tag_rename),
        ("GET", rf"/api/tags/{ID}/usage", Handler.api_tag_usage),
        ("DELETE", rf"/api/tags/{ID}", Handler.api_tag_delete),
        ("GET", r"/api/export", Handler.api_export),
        ("POST", r"/api/import/validate", Handler.api_import_validate),
        ("POST", r"/api/import", Handler.api_import),
    ]
    return Handler


def _require_object(value):
    if not isinstance(value, dict):
        raise InventoryError("bad_request", "Expected a JSON object.")
    return value


def create_server(host, port, data_path):
    store = Store(data_path)
    httpd = ThreadingHTTPServer((host, port), make_handler(store))
    httpd.daemon_threads = True
    return httpd, store


def main():
    parser = argparse.ArgumentParser(description="Home Inventory server")
    parser.add_argument("--host", default=os.environ.get("HOME_INVENTORY_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("HOME_INVENTORY_PORT", "8080")))
    parser.add_argument(
        "--data",
        default=os.environ.get("HOME_INVENTORY_DATA", str(BASE_DIR / "data" / "inventory.json")),
        help="path of the live JSON data file",
    )
    args = parser.parse_args()

    try:
        httpd, store = create_server(args.host, args.port, args.data)
    except StoreLoadError as e:
        print(f"\nHome Inventory cannot start:\n  {e}\n", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"\nHome Inventory cannot start: {e}\n", file=sys.stderr)
        return 1

    def stop(signum, frame):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    print(f"Home Inventory running on http://{args.host}:{args.port}  (data: {store.path})", flush=True)
    httpd.serve_forever()
    httpd.server_close()
    print("Home Inventory stopped.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
