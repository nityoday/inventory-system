import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402


class ApiTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.path = Path(cls.tmp.name) / "inventory.json"
        cls.httpd, cls.store = server.create_server("127.0.0.1", 0, cls.path)
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None, headers=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        h = {"Content-Type": "application/json"} if data is not None else {}
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def j(self, method, path, body=None, **kw):
        status, raw, headers = self.call(method, path, body, **kw)
        return status, json.loads(raw.decode()) if raw else None

    def reset(self):
        self.store.replace_all({"schemaVersion": 1, "entries": [], "tags": []})


class StaticTests(ApiTestCase):
    def test_index_and_assets(self):
        for p, ctype in (("/", "text/html"), ("/app.js", "javascript"), ("/style.css", "text/css")):
            status, raw, h = self.call("GET", p)
            self.assertEqual(status, 200, p)
            self.assertIn(ctype, h["Content-Type"])

    def test_etag_304(self):
        _, _, h = self.call("GET", "/style.css")
        status, _, _ = self.call("GET", "/style.css", headers={"If-None-Match": h["ETag"]})
        self.assertEqual(status, 304)

    def test_path_traversal_blocked(self):
        for p in ("/../server.py", "/..%2fserver.py", "/%2e%2e/store.py"):
            status, raw, _ = self.call("GET", p)
            self.assertEqual(status, 404, p)
            self.assertNotIn(b"InventoryError", raw)


class ApiTests(ApiTestCase):
    def setUp(self):
        self.reset()

    def test_full_flow(self):
        s, r = self.j("POST", "/api/tags", {"name": "Gift"})
        self.assertEqual(s, 201)
        gift = r["tagId"]
        s, r = self.j("POST", "/api/entries", {"name": "Cabinet", "parentId": None, "tagIds": [gift]})
        self.assertEqual(s, 201)
        cab = r["entryId"]
        s, r = self.j("POST", "/api/entries", {"name": "Box", "description": "blue", "parentId": cab})
        box = r["entryId"]
        self.assertEqual(len(r["state"]["entries"]), 2)

        s, r = self.j("GET", f"/api/entries/{cab}/subtree")
        self.assertEqual((s, r["descendantCount"]), (200, 1))

        s, r = self.j("PATCH", f"/api/entries/{box}", {"name": "Blue Box"})
        self.assertEqual(s, 200)

        s, r = self.j("POST", f"/api/entries/{cab}/move", {"parentId": box})
        self.assertEqual((s, r["error"]["code"]), (400, "circular_move"))

        s, r = self.j("POST", f"/api/entries/{box}/move", {"parentId": None})
        self.assertEqual(s, 200)

        s, r = self.j("DELETE", f"/api/entries/{cab}")
        self.assertEqual((s, r["deletedCount"]), (200, 1))
        s, r = self.j("GET", "/api/state")
        self.assertEqual([e["name"] for e in r["entries"]], ["Blue Box"])

        s, r = self.j("DELETE", f"/api/tags/{gift}")
        self.assertEqual((s, r["affectedEntries"]), (200, 0))

    def test_errors_are_json_and_friendly(self):
        s, r = self.j("POST", "/api/entries", {"name": "  "})
        self.assertEqual((s, r["error"]["code"], r["error"]["field"]), (400, "name_required", "name"))
        self.j("POST", "/api/tags", {"name": "Gift"})
        s, r = self.j("POST", "/api/tags", {"name": "gift"})
        self.assertEqual((s, r["error"]["code"]), (409, "duplicate_tag"))
        s, r = self.j("POST", "/api/entries", {"name": "X", "parentId": "missing"})
        self.assertEqual((s, r["error"]["code"]), (400, "invalid_parent"))
        s, r = self.j("DELETE", "/api/entries/doesnotexist")
        self.assertEqual(s, 404)
        s, r = self.j("GET", "/api/nope")
        self.assertEqual(s, 404)
        s, r = self.j("PATCH", "/api/entries/x", raw=b"not json{")
        self.assertEqual(s, 400)
        self.assertNotIn("Traceback", json.dumps(r))

    def test_csrf_protections(self):
        s, _, _ = self.call("POST", "/api/tags", {"name": "Evil"}, headers={"Origin": "http://evil.example"})
        self.assertEqual(s, 403)
        s, _, _ = self.call("POST", "/api/tags", raw=b'{"name":"Evil"}', headers={"Content-Type": "text/plain"})
        self.assertEqual(s, 415)
        s, _, _ = self.call("POST", "/api/tags", {"name": "Fine"}, headers={"Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(s, 201)

    def test_revision_changes_on_mutation(self):
        _, a = self.j("GET", "/api/revision")
        self.j("POST", "/api/tags", {"name": "T"})
        _, b = self.j("GET", "/api/revision")
        self.assertNotEqual(a["revision"], b["revision"])
        # failed mutation does not bump it
        self.j("POST", "/api/tags", {"name": "t"})
        _, c = self.j("GET", "/api/revision")
        self.assertEqual(b["revision"], c["revision"])

    def test_export_import_roundtrip(self):
        _, t = self.j("POST", "/api/tags", {"name": "Gift"})
        _, a = self.j("POST", "/api/entries", {"name": "A", "tagIds": [t["tagId"]]})
        self.j("POST", "/api/entries", {"name": "B", "parentId": a["entryId"]})
        s, raw, h = self.call("GET", "/api/export")
        self.assertEqual(s, 200)
        self.assertRegex(h["Content-Disposition"], r'filename="home-inventory-\d{4}-\d{2}-\d{2}\.json"')
        exported = json.loads(raw)
        self.assertEqual(exported["schemaVersion"], 1)

        self.j("DELETE", f"/api/entries/{a['entryId']}")
        self.assertEqual(self.j("GET", "/api/state")[1]["entries"], [])

        s, r = self.j("POST", "/api/import/validate", raw=raw)
        self.assertEqual((s, r), (200, {"entries": 2, "tags": 1}))
        s, r = self.j("POST", "/api/import", raw=raw)
        self.assertEqual((s, r["imported"]), (200, {"entries": 2, "tags": 1}))
        state = self.j("GET", "/api/state")[1]
        self.assertEqual({e["name"] for e in state["entries"]}, {"A", "B"})
        self.assertEqual(state["tags"], exported["tags"])

    def test_bad_import_does_not_touch_live_data(self):
        self.j("POST", "/api/entries", {"name": "Keep"})
        before = self.path.read_bytes()
        s, r = self.j("POST", "/api/import", raw=b"this is not json")
        self.assertEqual((s, r["error"]["code"]), (400, "invalid_json"))
        s, r = self.j("POST", "/api/import", {"schemaVersion": 7, "entries": [], "tags": []})
        self.assertEqual((s, r["error"]["code"]), (400, "unsupported_schema"))
        s, r = self.j("POST", "/api/import", {"schemaVersion": 1, "entries": [{"id": "a", "name": "A", "parentId": "zz"}], "tags": []})
        self.assertEqual((s, r["error"]["code"]), (400, "invalid_data"))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual([e["name"] for e in self.j("GET", "/api/state")[1]["entries"]], ["Keep"])


if __name__ == "__main__":
    unittest.main()
