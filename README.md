# Home Inventory

A searchable map of everything stored around your home, for a Raspberry Pi on your home network.
Organise belongings in a hierarchy of any depth (property → room → cabinet → shelf → box → item, or whatever
you like), tag them, search all of it instantly, and use it from any phone, tablet, or computer.

* **No dependencies.** Python 3 standard library on the server; plain HTML/CSS/JavaScript in the browser.
  Nothing to `pip install`, no build step, and no internet access needed after you copy the files.
* **One JSON file** (`data/inventory.json`) is the live data store.
* **No login.** It is built for a trusted home network only (see [Security](#security)).

## Quick start

On the Raspberry Pi (Raspberry Pi OS ships with Python 3):

```bash
cd home-inventory
python3 server.py
```

Open `http://<pi-address>:8080` from any device on your network, for example
`http://raspberrypi.local:8080` or `http://192.168.1.50:8080`.

Options (command line or environment variable):

| Option | Environment variable | Default |
|---|---|---|
| `--port` | `HOME_INVENTORY_PORT` | `8080` |
| `--host` | `HOME_INVENTORY_HOST` | `0.0.0.0` (all network interfaces) |
| `--data` | `HOME_INVENTORY_DATA` | `./data/inventory.json` |

## Run it permanently (starts on boot, restarts after a crash)

1. Copy the `home-inventory` folder to `/home/pi/home-inventory` (or edit the paths in the service file).
2. Install and start the service:

```bash
sudo cp deploy/home-inventory.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now home-inventory
```

Useful commands: `systemctl status home-inventory`, `journalctl -u home-inventory -f`,
`sudo systemctl restart home-inventory`.

Tips:

* Give the Pi a fixed address (a DHCP reservation in your router is easiest) so bookmarks keep working.
* Want `http://raspberrypi.local` without `:8080`? Either run on port 80 by adding
  `AmbientCapabilities=CAP_NET_BIND_SERVICE` to the service file and setting `HOME_INVENTORY_PORT=80`,
  or forward port 80 to 8080 with your firewall.
* On a phone, use "Add to Home Screen" in the browser menu for an app-like shortcut.

## Using it

* **Search** (top of the home screen) looks through names, descriptions, directly assigned tags, and inherited
  tags, across the whole hierarchy. It's case-insensitive and matches partial words. With several words, every
  word must match somewhere in the entry (name, description, or a tag). Results appear as a tree in their real
  locations: matches are highlighted with a filled dot; ancestors shown only for context are faded and labelled
  *context*. **Open** jumps to the entry with its path expanded.
* **Filter** (button beside the search box) picks one or more tags. An entry qualifies if it has *any* selected
  tag, directly or inherited. Combined with text, both must hold.
* **Tree**: tap the arrow to expand/collapse; tap a name to select it. Siblings are sorted alphabetically,
  ignoring case ("Drawer 2" sorts before "Drawer 10"). Navigating to another location resets the tree so only the
  path to it is open.
* **Selected entry** shows a clickable breadcrumb, description, tags (solid = assigned here, dashed = inherited,
  with where from), and the actions **Add inside**, **Edit**, **Move**, **Delete**.
* **Tags** screen: create, rename, delete. Colours are assigned automatically and never change.
* **Import / Export** screen: download the whole inventory as `home-inventory-YYYY-MM-DD.json`, or replace the
  inventory from such a file.

### Inherited tags

Tags are stored only on the entries you assign them to. An entry's *effective* tags are its own plus those of all
its ancestors, computed from the hierarchy every time, never copied into descendants. So removing a tag from a
cabinet immediately stops its boxes and items matching it (unless another ancestor has the same tag), and moving
a box to another room changes what it inherits straight away.

## Data safety

* Every change is applied to a copy, validated (parents exist, no loops, tag references valid, tag names
  unique), written to a temporary file, `fsync`ed, and atomically renamed over `inventory.json`. A crash or power
  cut leaves either the old or the new file, never half of one. If saving fails, the app tells you and the
  in-memory data stays as it was.
* Move and delete are single atomic operations; moving a subtree never changes any ID.
* If `inventory.json` is ever unreadable or invalid at start-up, the server **refuses to start and leaves the
  file untouched**, printing the reason, rather than overwriting it.
* Importing validates the whole file first; a bad file never touches the live data.
* **There are no automatic backups.** Use *Export* from time to time, or simply copy `data/inventory.json`.

## Data format (`schemaVersion` 1)

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-10-12T09:30:00.000Z",
  "tags": [
    { "id": "…", "name": "Gift", "color": "#b91c1c", "createdAt": "…" }
  ],
  "entries": [
    {
      "id": "…", "name": "Blue Box", "description": "…",
      "parentId": "…or null for a root entry",
      "tagIds": ["…direct assignments only…"],
      "createdAt": "…", "updatedAt": "…"
    }
  ]
}
```

IDs are random and permanent (letters, digits, `-`, `_`). Names are free text and may be duplicated anywhere.
A file with a newer `schemaVersion` than the app understands is refused with a clear message.
Limits: names 200 characters, descriptions 5,000, tag names 40, import files 32 MB.

## Project layout

```
server.py            HTTP server and JSON API (standard library only)
store.py             validation, hierarchy and tag rules, atomic file persistence
static/              the web app (index.html, style.css, logic.js, app.js)
deploy/              systemd service file
tests/               unit and API tests
data/inventory.json  your data (created on first start)
```

API (all JSON; used by the web app): `GET /api/state`, `GET /api/revision`, `POST /api/entries`,
`PATCH /api/entries/<id>`, `POST /api/entries/<id>/move`, `GET /api/entries/<id>/subtree`,
`DELETE /api/entries/<id>`, `POST /api/tags`, `PATCH|DELETE /api/tags/<id>`, `GET /api/tags/<id>/usage`,
`GET /api/export`, `POST /api/import/validate`, `POST /api/import`.

Several devices can use it at once; each device checks for changes made elsewhere every few seconds and
refreshes itself.

## Security

There is deliberately no login: anyone who can reach the Pi's port can read and change the inventory.
Use it only on a trusted home network, and **don't forward the port to the internet**. The server does refuse
requests that other websites try to send through your browser (cross-site checks), and it never shows stack
traces to users (errors go to the service log).

## Tests

```bash
python3 -m unittest discover -s tests -p "test_*.py"    # server, storage, API (standard library only)
node tests/test_logic.js                                  # tree, inheritance and search logic (optional, needs Node)
```

## Troubleshooting

* **Can't open the page from my phone**: check the Pi's address, that the phone is on the same Wi-Fi, and that
  the service is running (`systemctl status home-inventory`). A red banner in the app means the Pi can't be reached.
* **"Home Inventory cannot start"**: the message names the problem with the data file. Fix or move the file,
  or restore it from an export (rename an export to `data/inventory.json`).
* **Port already in use**: choose another with `--port`.
