"""
Home Inventory - data layer.

Everything that touches the inventory lives here: validation, hierarchy rules,
tag rules and the atomic JSON file persistence. It uses only the Python
standard library.

Design rules
------------
* The in-memory dataset (`Store._data`) is NEVER mutated in place. Every change
  is applied to a deep copy, validated, written to disk, and only then swapped
  in. If anything fails, the previous valid inventory stays live.
* The file is written with the classic crash-safe recipe: write a temporary
  file in the same directory, fsync it, atomically `os.replace()` it over the
  live file, then fsync the directory.
* Hierarchy walks are iterative, so very deep nesting cannot hit Python's
  recursion limit.
"""

import copy
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

MAX_NAME_LEN = 200
MAX_DESCRIPTION_LEN = 5000
MAX_TAG_NAME_LEN = 40

# Visually distinct colours that all keep >= 4.5:1 contrast with white text.
# New tags are given colours from this palette automatically; users never pick.
TAG_PALETTE = [
    "#b91c1c",  # red
    "#0369a1",  # blue
    "#15803d",  # green
    "#a21caf",  # magenta
    "#b45309",  # amber / brown
    "#0f766e",  # teal
    "#6d28d9",  # violet
    "#be185d",  # pink
    "#4d7c0f",  # olive
    "#c2410c",  # orange
    "#4338ca",  # indigo
    "#475569",  # slate
]

_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,100}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class InventoryError(Exception):
    """An error that is safe to show to the user."""

    def __init__(self, code, message, status=400, field=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.field = field


class StoreLoadError(Exception):
    """The data file exists but cannot be used. The file is left untouched."""


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id():
    return uuid.uuid4().hex


def _parse_timestamp(value, where):
    if not isinstance(value, str) or not value:
        raise InventoryError("invalid_data", f"{where}: timestamp must be a text value.")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise InventoryError("invalid_data", f"{where}: '{value}' is not a valid ISO-8601 timestamp.")
    return value


def clean_name(value, field, label, max_len=MAX_NAME_LEN):
    if not isinstance(value, str):
        raise InventoryError("invalid_name", f"{label} must be text.", field=field)
    name = value.strip()
    if not name:
        raise InventoryError("name_required", f"{label} is required.", field=field)
    if len(name) > max_len:
        raise InventoryError("name_too_long", f"{label} must be {max_len} characters or fewer.", field=field)
    return name


def clean_description(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise InventoryError("invalid_description", "Description must be text.", field="description")
    text = value.strip()
    if len(text) > MAX_DESCRIPTION_LEN:
        raise InventoryError(
            "description_too_long",
            f"Description must be {MAX_DESCRIPTION_LEN} characters or fewer.",
            field="description",
        )
    return text


def choose_tag_color(tags):
    """
    Pick the next palette colour for a new tag.

    1. Prefer the colours used least so far (cycles predictably once the palette
       is exhausted).
    2. Among those, take the first one after the most recently created tag's
       colour, so tags created one after another never share a colour.
    """
    usage = {c: 0 for c in TAG_PALETTE}
    for t in tags:
        c = str(t.get("color", "")).lower()
        if c in usage:
            usage[c] += 1
    least = min(usage.values())
    candidates = {i for i, c in enumerate(TAG_PALETTE) if usage[c] == least}

    last_idx = -1
    if tags:
        last = str(tags[-1].get("color", "")).lower()
        if last in TAG_PALETTE:
            last_idx = TAG_PALETTE.index(last)

    n = len(TAG_PALETTE)
    for step in range(1, n + 1):
        i = (last_idx + step) % n
        if i in candidates:
            return TAG_PALETTE[i]
    return TAG_PALETTE[0]  # unreachable, defensive


def empty_dataset():
    return {"schemaVersion": SCHEMA_VERSION, "entries": [], "tags": []}


# --------------------------------------------------------------------------
# Whole-dataset validation (used on load, on import, and after every change)
# --------------------------------------------------------------------------

def validate_dataset(raw):
    """
    Validate and normalise a dataset. Returns a clean new dict, or raises
    InventoryError. Unknown keys are dropped. Nothing is modified in `raw`.
    """
    def bad(msg):
        return InventoryError("invalid_data", msg)

    if not isinstance(raw, dict):
        raise bad("The file must contain a JSON object at the top level.")

    version = raw.get("schemaVersion")
    if isinstance(version, bool) or not isinstance(version, int):
        raise InventoryError(
            "invalid_data", "The file has no valid 'schemaVersion', so it doesn't look like a Home Inventory export."
        )
    if version > SCHEMA_VERSION:
        raise InventoryError(
            "unsupported_schema",
            f"This file uses schema version {version}, but this app only understands up to version "
            f"{SCHEMA_VERSION}. Update the app or export the file from a compatible version.",
        )
    if version < 1:
        raise InventoryError("unsupported_schema", f"Schema version {version} is not supported.")

    raw_tags = raw.get("tags")
    raw_entries = raw.get("entries")
    if not isinstance(raw_tags, list):
        raise bad("'tags' must be a list.")
    if not isinstance(raw_entries, list):
        raise bad("'entries' must be a list.")

    now = now_iso()

    # ---- tags ----------------------------------------------------------
    tags = []
    tag_ids = set()
    tag_names = set()
    for i, t in enumerate(raw_tags, start=1):
        where = f"Tag #{i}"
        if not isinstance(t, dict):
            raise bad(f"{where} must be an object.")
        tid = t.get("id")
        if not isinstance(tid, str) or not _ID_RE.match(tid):
            raise bad(f"{where} has a missing or invalid 'id' (use letters, digits, '-' or '_').")
        if tid in tag_ids:
            raise bad(f"{where}: duplicate tag id '{tid}'.")
        try:
            name = clean_name(t.get("name"), "name", f"{where} name", MAX_TAG_NAME_LEN)
        except InventoryError as e:
            raise bad(e.message)
        key = name.casefold()
        if key in tag_names:
            raise bad(f"{where}: another tag is already called '{name}' (tag names must be unique, ignoring case).")
        color = t.get("color")
        if color is None:
            color = choose_tag_color(tags)
        elif not isinstance(color, str) or not _COLOR_RE.match(color):
            raise bad(f"{where} ('{name}'): colour must look like #aabbcc.")
        created = _parse_timestamp(t["createdAt"], where) if t.get("createdAt") is not None else now
        tag_ids.add(tid)
        tag_names.add(key)
        tags.append({"id": tid, "name": name, "color": color.lower(), "createdAt": created})

    # ---- entries -------------------------------------------------------
    entries = []
    entry_ids = set()
    for i, e in enumerate(raw_entries, start=1):
        where = f"Entry #{i}"
        if not isinstance(e, dict):
            raise bad(f"{where} must be an object.")
        eid = e.get("id")
        if not isinstance(eid, str) or not _ID_RE.match(eid):
            raise bad(f"{where} has a missing or invalid 'id' (use letters, digits, '-' or '_').")
        if eid in entry_ids:
            raise bad(f"{where}: duplicate entry id '{eid}'.")
        try:
            name = clean_name(e.get("name"), "name", f"{where} name")
            description = clean_description(e.get("description"))
        except InventoryError as err:
            raise bad(err.message)
        where = f"Entry #{i} ('{name}')"
        parent = e.get("parentId")
        if parent is not None and (not isinstance(parent, str) or not parent):
            raise bad(f"{where}: 'parentId' must be null or an entry id.")
        raw_tag_ids = e.get("tagIds", [])
        if raw_tag_ids is None:
            raw_tag_ids = []
        if not isinstance(raw_tag_ids, list):
            raise bad(f"{where}: 'tagIds' must be a list.")
        seen = set()
        clean_tag_ids = []
        for tid in raw_tag_ids:
            if not isinstance(tid, str) or tid not in tag_ids:
                raise bad(f"{where}: refers to a tag id that does not exist ({tid!r}).")
            if tid not in seen:
                seen.add(tid)
                clean_tag_ids.append(tid)
        created = _parse_timestamp(e["createdAt"], where) if e.get("createdAt") is not None else now
        updated = _parse_timestamp(e["updatedAt"], where) if e.get("updatedAt") is not None else created
        entry_ids.add(eid)
        entries.append(
            {
                "id": eid,
                "name": name,
                "description": description,
                "parentId": parent,
                "tagIds": clean_tag_ids,
                "createdAt": created,
                "updatedAt": updated,
            }
        )

    # ---- hierarchy: parents exist, no self-parenting, no cycles ---------
    parent_of = {}
    for e in entries:
        p = e["parentId"]
        if p is not None:
            if p == e["id"]:
                raise bad(f"Entry '{e['name']}' is its own parent.")
            if p not in entry_ids:
                raise bad(f"Entry '{e['name']}' has a parent id that does not exist ({p!r}).")
        parent_of[e["id"]] = p

    verified = set()
    for start in parent_of:
        if start in verified:
            continue
        path = []
        on_path = set()
        cur = start
        while cur is not None and cur not in verified:
            if cur in on_path:
                names = {e["id"]: e["name"] for e in entries}
                raise bad(f"The hierarchy contains a loop involving '{names[cur]}'.")
            on_path.add(cur)
            path.append(cur)
            cur = parent_of[cur]
        verified.update(path)

    return {"schemaVersion": SCHEMA_VERSION, "entries": entries, "tags": tags}


# --------------------------------------------------------------------------
# The store
# --------------------------------------------------------------------------

class Store:
    def __init__(self, path):
        self.path = Path(path)
        self._lock = threading.RLock()
        self._boot = format(int(time.time()), "x")
        self._counter = 0
        self._data = None
        self._load()

    # ---- revision (lets other devices notice changes cheaply) -----------
    @property
    def revision(self):
        return f"{self._boot}-{self._counter}"

    # ---- loading --------------------------------------------------------
    def _load(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Remove leftovers of a write that was interrupted by a crash/power cut.
        for leftover in self.path.parent.glob(self.path.name + ".tmp-*"):
            try:
                leftover.unlink()
            except OSError:
                pass

        if not self.path.exists():
            self._data = empty_dataset()
            self._write_file(self._data)
            return

        try:
            text = self.path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            raise StoreLoadError(f"Cannot read {self.path}: {e}")
        if not text.strip():
            raise StoreLoadError(
                f"{self.path} is empty. Restore it from an export, or move it aside to start a new inventory."
            )
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as e:
            raise StoreLoadError(f"{self.path} is not valid JSON ({e}). The file has been left untouched.")
        try:
            self._data = validate_dataset(raw)
        except InventoryError as e:
            raise StoreLoadError(f"{self.path} failed validation: {e.message} The file has been left untouched.")

    # ---- persistence ----------------------------------------------------
    def _write_file(self, data):
        payload = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        tmp = self.path.with_name(f"{self.path.name}.tmp-{os.getpid()}")
        try:
            with open(tmp, "wb") as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
            try:
                dir_fd = os.open(str(self.path.parent), os.O_RDONLY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            except OSError:
                pass  # directory fsync is best-effort (not supported everywhere)
        except OSError as e:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise InventoryError(
                "write_failed",
                "The change could not be saved to the Raspberry Pi's storage, so nothing was changed. "
                f"({e.strerror or e})",
                status=500,
            )

    def _commit(self, fn):
        """Apply `fn` to a copy, validate, persist, swap. All or nothing."""
        with self._lock:
            new = copy.deepcopy(self._data)
            result = fn(new)
            validate_dataset(new)  # defence in depth: never persist a broken hierarchy
            self._write_file(new)
            self._data = new
            self._counter += 1
            return result

    # ---- reads ----------------------------------------------------------
    def snapshot(self):
        """Return (data, revision). The returned data must be treated as read-only."""
        with self._lock:
            return self._data, self.revision

    def export(self):
        with self._lock:
            data = self._data
        out = {"schemaVersion": data["schemaVersion"], "exportedAt": now_iso()}
        out["tags"] = data["tags"]
        out["entries"] = data["entries"]
        return out

    def subtree_info(self, entry_id):
        data, _ = self.snapshot()
        by_id = {e["id"]: e for e in data["entries"]}
        if entry_id not in by_id:
            raise InventoryError("entry_not_found", "That entry no longer exists.", 404)
        ids = _subtree_ids(data["entries"], entry_id)
        return {"id": entry_id, "name": by_id[entry_id]["name"], "descendantCount": len(ids) - 1}

    def tag_usage(self, tag_id):
        data, _ = self.snapshot()
        if not any(t["id"] == tag_id for t in data["tags"]):
            raise InventoryError("tag_not_found", "That tag no longer exists.", 404)
        count = sum(1 for e in data["entries"] if tag_id in e["tagIds"])
        return {"id": tag_id, "entryCount": count}

    # ---- entry operations -----------------------------------------------
    def create_entry(self, name, description, parent_id, tag_ids):
        name = clean_name(name, "name", "Name")
        description = clean_description(description)

        def apply(d):
            by_id = {e["id"]: e for e in d["entries"]}
            if parent_id is not None and parent_id not in by_id:
                raise InventoryError(
                    "invalid_parent", "The place you are adding this to no longer exists.", 400, "parentId"
                )
            clean_tags = _clean_tag_ids(d, tag_ids)
            ts = now_iso()
            entry = {
                "id": new_id(),
                "name": name,
                "description": description,
                "parentId": parent_id,
                "tagIds": clean_tags,
                "createdAt": ts,
                "updatedAt": ts,
            }
            d["entries"].append(entry)
            return entry["id"]

        return self._commit(apply)

    def update_entry(self, entry_id, patch):
        if "parentId" in patch:
            raise InventoryError("use_move", "Use the Move action to change where an entry lives.")
        has_name = "name" in patch
        has_desc = "description" in patch
        has_tags = "tagIds" in patch
        name = clean_name(patch["name"], "name", "Name") if has_name else None
        desc = clean_description(patch["description"]) if has_desc else None

        def apply(d):
            entry = _find(d["entries"], entry_id)
            if entry is None:
                raise InventoryError("entry_not_found", "That entry no longer exists.", 404)
            if has_name:
                entry["name"] = name
            if has_desc:
                entry["description"] = desc
            if has_tags:
                entry["tagIds"] = _clean_tag_ids(d, patch["tagIds"])
            entry["updatedAt"] = now_iso()
            return entry["id"]

        return self._commit(apply)

    def move_entry(self, entry_id, new_parent_id):
        def apply(d):
            by_id = {e["id"]: e for e in d["entries"]}
            entry = by_id.get(entry_id)
            if entry is None:
                raise InventoryError("entry_not_found", "That entry no longer exists.", 404)
            if new_parent_id is not None:
                if new_parent_id not in by_id:
                    raise InventoryError(
                        "invalid_parent", "The destination no longer exists.", 400, "parentId"
                    )
                if new_parent_id == entry_id:
                    raise InventoryError(
                        "circular_move", "An entry can't be moved into itself.", 400, "parentId"
                    )
                # Walk up from the destination; meeting the moved entry means the
                # destination is inside it, which would create a loop.
                cur = new_parent_id
                steps = 0
                while cur is not None:
                    if cur == entry_id:
                        raise InventoryError(
                            "circular_move",
                            "An entry can't be moved inside something it contains.",
                            400,
                            "parentId",
                        )
                    cur = by_id[cur]["parentId"]
                    steps += 1
                    if steps > len(by_id) + 1:  # corrupted data guard
                        raise InventoryError("invalid_data", "The hierarchy is inconsistent.", 500)
            if entry["parentId"] == new_parent_id:
                return entry["id"]  # already there: nothing to do
            entry["parentId"] = new_parent_id
            entry["updatedAt"] = now_iso()
            return entry["id"]

        return self._commit(apply)

    def delete_entry(self, entry_id):
        def apply(d):
            if _find(d["entries"], entry_id) is None:
                raise InventoryError("entry_not_found", "That entry no longer exists.", 404)
            doomed = _subtree_ids(d["entries"], entry_id)
            d["entries"] = [e for e in d["entries"] if e["id"] not in doomed]
            return len(doomed)

        return self._commit(apply)

    # ---- tag operations -------------------------------------------------
    def create_tag(self, name):
        name = clean_name(name, "name", "Tag name", MAX_TAG_NAME_LEN)

        def apply(d):
            _ensure_unique_tag_name(d["tags"], name, ignore_id=None)
            tag = {
                "id": new_id(),
                "name": name,
                "color": choose_tag_color(d["tags"]),
                "createdAt": now_iso(),
            }
            d["tags"].append(tag)
            return tag["id"]

        return self._commit(apply)

    def rename_tag(self, tag_id, name):
        name = clean_name(name, "name", "Tag name", MAX_TAG_NAME_LEN)

        def apply(d):
            tag = _find(d["tags"], tag_id)
            if tag is None:
                raise InventoryError("tag_not_found", "That tag no longer exists.", 404)
            _ensure_unique_tag_name(d["tags"], name, ignore_id=tag_id)
            tag["name"] = name  # id, colour and assignments are untouched
            return tag_id

        return self._commit(apply)

    def delete_tag(self, tag_id):
        def apply(d):
            if _find(d["tags"], tag_id) is None:
                raise InventoryError("tag_not_found", "That tag no longer exists.", 404)
            d["tags"] = [t for t in d["tags"] if t["id"] != tag_id]
            affected = 0
            for e in d["entries"]:
                if tag_id in e["tagIds"]:
                    e["tagIds"] = [t for t in e["tagIds"] if t != tag_id]
                    affected += 1
            return affected

        return self._commit(apply)

    # ---- import ---------------------------------------------------------
    @staticmethod
    def validate_import(raw):
        data = validate_dataset(raw)
        return {"entries": len(data["entries"]), "tags": len(data["tags"])}

    def replace_all(self, raw):
        """Replace the whole inventory with imported data (validated first)."""
        clean = validate_dataset(raw)

        def apply(d):
            d.clear()
            d.update(clean)
            return {"entries": len(clean["entries"]), "tags": len(clean["tags"])}

        return self._commit(apply)


# --------------------------------------------------------------------------
# Module-level helpers
# --------------------------------------------------------------------------

def _find(items, item_id):
    for it in items:
        if it["id"] == item_id:
            return it
    return None


def _clean_tag_ids(d, tag_ids):
    if tag_ids is None:
        return []
    if not isinstance(tag_ids, list):
        raise InventoryError("invalid_tags", "Tags must be a list.", 400, "tagIds")
    known = {t["id"] for t in d["tags"]}
    out, seen = [], set()
    for tid in tag_ids:
        if not isinstance(tid, str) or tid not in known:
            raise InventoryError(
                "invalid_tag", "One of the selected tags no longer exists. Close this and try again.", 400, "tagIds"
            )
        if tid not in seen:
            seen.add(tid)
            out.append(tid)
    return out


def _ensure_unique_tag_name(tags, name, ignore_id):
    key = name.casefold()
    for t in tags:
        if t["id"] != ignore_id and t["name"].casefold() == key:
            raise InventoryError(
                "duplicate_tag", f"A tag called “{t['name']}” already exists.", 409, "name"
            )


def _subtree_ids(entries, root_id):
    """Ids of root_id and all its descendants, collected iteratively."""
    children = {}
    for e in entries:
        children.setdefault(e["parentId"], []).append(e["id"])
    found = {root_id}
    stack = [root_id]
    while stack:
        cur = stack.pop()
        for child in children.get(cur, ()):
            if child not in found:
                found.add(child)
                stack.append(child)
    return found
