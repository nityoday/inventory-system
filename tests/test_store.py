import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import store as store_mod  # noqa: E402
from store import InventoryError, Store, StoreLoadError, TAG_PALETTE, validate_dataset  # noqa: E402


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "inventory.json"
        self.store = Store(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    # helpers
    def data(self):
        return self.store.snapshot()[0]

    def entry(self, entry_id):
        return next(e for e in self.data()["entries"] if e["id"] == entry_id)

    def on_disk(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def add(self, name, parent=None, tags=None, description=""):
        return self.store.create_entry(name, description, parent, tags or [])


class EntryTests(StoreTestCase):
    def test_new_store_creates_valid_file(self):
        self.assertTrue(self.path.exists())
        self.assertEqual(self.on_disk(), {"schemaVersion": 1, "entries": [], "tags": []})

    def test_create_and_persist(self):
        eid = self.add("Property 203", description="  Main flat  ")
        e = self.entry(eid)
        self.assertEqual(e["name"], "Property 203")
        self.assertEqual(e["description"], "Main flat")
        self.assertIsNone(e["parentId"])
        self.assertEqual(self.on_disk()["entries"][0]["id"], eid)
        # survives a "restart"
        again = Store(self.path)
        self.assertEqual(again.snapshot()[0]["entries"][0]["id"], eid)

    def test_name_required_and_trimmed(self):
        for bad in ["", "   ", None, 5]:
            with self.assertRaises(InventoryError) as cm:
                self.add(bad)
            self.assertEqual(cm.exception.field, "name")
        self.assertEqual(self.data()["entries"], [])
        self.assertEqual(self.entry(self.add("  Box  "))["name"], "Box")

    def test_duplicate_names_allowed_among_siblings(self):
        a = self.add("Drawer")
        b = self.add("Drawer")
        self.assertNotEqual(a, b)
        self.assertEqual(len(self.data()["entries"]), 2)

    def test_invalid_parent_rejected(self):
        with self.assertRaises(InventoryError) as cm:
            self.add("X", parent="nope")
        self.assertEqual(cm.exception.code, "invalid_parent")
        self.assertEqual(self.data()["entries"], [])

    def test_unknown_tag_rejected(self):
        with self.assertRaises(InventoryError):
            self.add("X", tags=["nope"])

    def test_update_keeps_identity_and_parent(self):
        root = self.add("Root")
        child = self.add("Child", parent=root)
        tag = self.store.create_tag("Gift")
        self.store.update_entry(child, {"name": "Renamed", "description": "d", "tagIds": [tag, tag]})
        e = self.entry(child)
        self.assertEqual((e["id"], e["parentId"]), (child, root))
        self.assertEqual((e["name"], e["description"], e["tagIds"]), ("Renamed", "d", [tag]))
        with self.assertRaises(InventoryError):
            self.store.update_entry(child, {"name": " "})
        with self.assertRaises(InventoryError) as cm:
            self.store.update_entry(child, {"parentId": None})
        self.assertEqual(cm.exception.code, "use_move")

    def test_move_subtree_preserves_everything(self):
        p203, p303 = self.add("Property 203"), self.add("Property 303")
        bedroom = self.add("Bedroom", p203)
        cab = self.add("Cabinet", bedroom)
        tag = self.store.create_tag("Gift")
        box = self.add("Box", cab, tags=[tag], description="blue")
        item = self.add("Cable", box)
        before = copy.deepcopy(self.entry(box))

        self.store.move_entry(bedroom, p303)

        self.assertEqual(self.entry(bedroom)["parentId"], p303)
        after = self.entry(box)
        for k in ("id", "name", "description", "parentId", "tagIds", "createdAt"):
            self.assertEqual(after[k], before[k])
        self.assertEqual(self.entry(item)["parentId"], box)
        self.assertEqual(len(self.data()["entries"]), 6)

    def test_move_to_root(self):
        a = self.add("A")
        b = self.add("B", a)
        self.store.move_entry(b, None)
        self.assertIsNone(self.entry(b)["parentId"])

    def test_move_into_self_or_descendant_rejected(self):
        a = self.add("A")
        b = self.add("B", a)
        c = self.add("C", b)
        for target in (a, b, c):
            with self.assertRaises(InventoryError) as cm:
                self.store.move_entry(a, target)
            self.assertEqual(cm.exception.code, "circular_move")
        self.assertIsNone(self.entry(a)["parentId"])
        self.assertEqual(self.entry(c)["parentId"], b)

    def test_move_invalid_destination(self):
        a = self.add("A")
        with self.assertRaises(InventoryError) as cm:
            self.store.move_entry(a, "ghost")
        self.assertEqual(cm.exception.code, "invalid_parent")
        with self.assertRaises(InventoryError) as cm:
            self.store.move_entry("ghost", None)
        self.assertEqual(cm.exception.status, 404)

    def test_delete_removes_whole_subtree_only(self):
        root = self.add("Root")
        keep = self.add("Keep")
        a = self.add("A", root)
        b = self.add("B", a)
        self.add("C", b)
        self.assertEqual(self.store.subtree_info(root)["descendantCount"], 3)
        removed = self.store.delete_entry(root)
        self.assertEqual(removed, 4)
        ids = {e["id"] for e in self.data()["entries"]}
        self.assertEqual(ids, {keep})

    def test_very_deep_hierarchy_is_fine(self):
        # Build 3,000 levels directly (fast), then run the real operations on it.
        d = {"schemaVersion": 1, "tags": [], "entries": []}
        parent = None
        for i in range(3000):
            d["entries"].append(
                {
                    "id": f"e{i}", "name": f"L{i}", "description": "", "parentId": parent,
                    "tagIds": [], "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                }
            )
            parent = f"e{i}"
        self.store.replace_all(d)
        self.assertEqual(self.store.subtree_info("e0")["descendantCount"], 2999)
        with self.assertRaises(InventoryError):
            self.store.move_entry("e0", "e2999")
        self.store.move_entry("e1500", None)
        self.assertEqual(self.store.delete_entry("e0"), 1500)

    def test_failed_write_leaves_everything_unchanged(self):
        a = self.add("A")
        before_disk = self.path.read_text(encoding="utf-8")
        with mock.patch("store.os.replace", side_effect=OSError(28, "No space left on device")):
            with self.assertRaises(InventoryError) as cm:
                self.add("B")
        self.assertEqual(cm.exception.code, "write_failed")
        self.assertEqual([e["id"] for e in self.data()["entries"]], [a])
        self.assertEqual(self.path.read_text(encoding="utf-8"), before_disk)
        self.assertEqual([p.name for p in Path(self.tmp.name).iterdir()], ["inventory.json"])  # no temp files left
        with mock.patch("store.os.replace", side_effect=OSError(28, "No space left on device")):
            with self.assertRaises(InventoryError):
                self.store.delete_entry(a)
        self.assertEqual(len(self.data()["entries"]), 1)


class TagTests(StoreTestCase):
    def test_unique_case_insensitive_and_trimmed(self):
        self.store.create_tag("  Gift ")
        for dup in ("gift", "GIFT", " Gift"):
            with self.assertRaises(InventoryError) as cm:
                self.store.create_tag(dup)
            self.assertEqual(cm.exception.code, "duplicate_tag")
        with self.assertRaises(InventoryError):
            self.store.create_tag("   ")
        self.assertEqual([t["name"] for t in self.data()["tags"]], ["Gift"])

    def test_rename_keeps_id_colour_assignments(self):
        t = self.store.create_tag("Gift")
        other = self.store.create_tag("Winter")
        e = self.add("Box", tags=[t])
        colour = next(x for x in self.data()["tags"] if x["id"] == t)["color"]
        self.store.rename_tag(t, "Presents")
        tag = next(x for x in self.data()["tags"] if x["id"] == t)
        self.assertEqual((tag["name"], tag["color"]), ("Presents", colour))
        self.assertEqual(self.entry(e)["tagIds"], [t])
        with self.assertRaises(InventoryError):
            self.store.rename_tag(t, "winter")
        self.store.rename_tag(t, "PRESENTS")  # re-casing own name is allowed
        self.assertIsNotNone(other)

    def test_delete_removes_assignments_not_entries(self):
        t = self.store.create_tag("Gift")
        keep = self.store.create_tag("Keep")
        a = self.add("A", tags=[t, keep])
        b = self.add("B", a, tags=[t])
        self.assertEqual(self.store.tag_usage(t)["entryCount"], 2)
        self.assertEqual(self.store.delete_tag(t), 2)
        self.assertEqual(len(self.data()["entries"]), 2)
        self.assertEqual(self.entry(a)["tagIds"], [keep])
        self.assertEqual(self.entry(b)["tagIds"], [])

    def test_colours_automatic_distinct_and_cycling(self):
        colours = []
        for i in range(len(TAG_PALETTE) * 2 + 3):
            tid = self.store.create_tag(f"Tag {i}")
            colours.append(next(t for t in self.data()["tags"] if t["id"] == tid)["color"])
        first_round = colours[: len(TAG_PALETTE)]
        self.assertEqual(len(set(first_round)), len(TAG_PALETTE))          # all distinct first
        for a, b in zip(colours, colours[1:]):
            self.assertNotEqual(a, b)                                       # consecutive never equal
        counts = {c: colours.count(c) for c in set(colours)}
        self.assertLessEqual(max(counts.values()) - min(counts.values()), 1)  # evenly reused
        # persisted
        self.assertEqual([t["color"] for t in Store(self.path).snapshot()[0]["tags"]], colours)

    def test_palette_contrast_with_white(self):
        def lum(h):
            r, g, b = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
            f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
        for c in TAG_PALETTE:
            self.assertGreaterEqual(1.05 / (lum(c) + 0.05), 4.5, c)


class ImportTests(StoreTestCase):
    def valid(self):
        return {
            "schemaVersion": 1,
            "tags": [{"id": "t1", "name": "Gift", "color": "#B91C1C", "createdAt": "2026-01-01T00:00:00Z"}],
            "entries": [
                {"id": "a", "name": "A", "description": "x", "parentId": None, "tagIds": ["t1"],
                 "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"},
                {"id": "b", "name": "B", "parentId": "a"},
            ],
        }

    def test_valid_import_replaces_everything(self):
        self.add("Old")
        counts = self.store.replace_all(self.valid())
        self.assertEqual(counts, {"entries": 2, "tags": 1})
        d = self.data()
        self.assertEqual({e["id"] for e in d["entries"]}, {"a", "b"})
        self.assertEqual(d["tags"][0]["color"], "#b91c1c")        # colour preserved
        self.assertEqual(self.on_disk()["entries"][1]["tagIds"], [])  # defaults filled in

    def test_export_roundtrip(self):
        t = self.store.create_tag("Gift")
        a = self.add("A", tags=[t], description="desc")
        self.add("B", a)
        exported = self.store.export()
        self.assertIn("exportedAt", exported)
        other = Store(Path(self.tmp.name) / "other.json")
        other.replace_all(json.loads(json.dumps(exported)))
        self.assertEqual(other.snapshot()[0], self.data())

    def test_rejections_leave_live_data_intact(self):
        keep = self.add("Keep")
        disk_before = self.path.read_text(encoding="utf-8")
        cases = {}
        d = self.valid(); d["schemaVersion"] = 99; cases["newer schema"] = d
        d = self.valid(); del d["schemaVersion"]; cases["no schema"] = d
        d = self.valid(); d["entries"][1]["parentId"] = "ghost"; cases["missing parent"] = d
        d = self.valid(); d["entries"][0]["parentId"] = "a"; cases["self parent"] = d
        d = self.valid(); d["entries"][0]["parentId"] = "b"; cases["cycle"] = d
        d = self.valid(); d["entries"][0]["tagIds"] = ["zzz"]; cases["unknown tag"] = d
        d = self.valid(); d["entries"][1]["id"] = "a"; cases["duplicate id"] = d
        d = self.valid(); d["entries"][0]["name"] = "  "; cases["empty name"] = d
        d = self.valid(); d["tags"].append({"id": "t2", "name": "GIFT"}); cases["duplicate tag name"] = d
        d = self.valid(); d["tags"][0]["color"] = "red"; cases["bad colour"] = d
        d = self.valid(); d["entries"][0]["createdAt"] = "yesterday"; cases["bad timestamp"] = d
        cases["not an object"] = [1, 2]
        cases["tags missing"] = {"schemaVersion": 1, "entries": []}
        for label, payload in cases.items():
            with self.subTest(label):
                with self.assertRaises(InventoryError):
                    self.store.replace_all(payload)
                with self.assertRaises(InventoryError):
                    Store.validate_import(payload)
        self.assertEqual([e["id"] for e in self.data()["entries"]], [keep])
        self.assertEqual(self.path.read_text(encoding="utf-8"), disk_before)

    def test_unsupported_schema_has_its_own_code(self):
        d = self.valid(); d["schemaVersion"] = 2
        with self.assertRaises(InventoryError) as cm:
            validate_dataset(d)
        self.assertEqual(cm.exception.code, "unsupported_schema")

    def test_failed_write_during_import_keeps_old_inventory(self):
        keep = self.add("Keep")
        with mock.patch("store.os.replace", side_effect=OSError(5, "I/O error")):
            with self.assertRaises(InventoryError):
                self.store.replace_all(self.valid())
        self.assertEqual([e["id"] for e in self.data()["entries"]], [keep])
        self.assertEqual([e["id"] for e in self.on_disk()["entries"]], [keep])


class LoadTests(unittest.TestCase):
    def test_corrupt_file_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "inventory.json"
            p.write_text("{ this is not json", encoding="utf-8")
            with self.assertRaises(StoreLoadError):
                Store(p)
            self.assertEqual(p.read_text(encoding="utf-8"), "{ this is not json")

    def test_invalid_hierarchy_file_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "inventory.json"
            bad = {"schemaVersion": 1, "tags": [], "entries": [{"id": "a", "name": "A", "parentId": "a"}]}
            p.write_text(json.dumps(bad), encoding="utf-8")
            with self.assertRaises(StoreLoadError):
                Store(p)
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), bad)

    def test_leftover_temp_files_are_cleaned(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "inventory.json"
            Store(p)
            leftover = Path(tmp) / "inventory.json.tmp-123"
            leftover.write_text("partial", encoding="utf-8")
            Store(p)
            self.assertFalse(leftover.exists())


if __name__ == "__main__":
    unittest.main()
