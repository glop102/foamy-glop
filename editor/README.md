# Scenario editor

A 3D editor for room-cooling scenarios: lay out machines, vents, fans,
windows and ducts in a box-shaped room, then export a runnable OpenFOAM case.
No OpenFOAM dictionaries to write by hand.

```sh
nix run .#editor          # serves the editor at http://localhost:8642/
# or, inside `nix develop`, serve your working copy while you change it:
foamy-editor editor
```

It is a static page (three.js from a CDN, no build step), so any static file
server works too. It needs internet access to load three.js.

## Using it

- **Add** things from the left. Click one in the view or the list to select
  it; the right panel edits every number.
- **Move** mode: drag the arrows. Things snap to the mesh grid and stay inside
  the room. Wall things only slide along their wall.
- **Resize** mode: drag the dots on each face (or edge, for wall things).
- **Checks** lists problems as you go. Errors (red) block the export;
  warnings (yellow) are things that will mesh but may not be what you meant.
- **Save** downloads the scenario as JSON, **Open** loads one back, and the
  page also autosaves to your browser.
- **Export case** downloads `<name>.tar.gz`, a complete case directory:

  ```sh
  tar xzf closet-back-fan.tar.gz
  nix develop /path/to/foamy-glop
  closet-back-fan/Allrun        # mesh, solve, and run foamy-report on it
  ```

Keys: Del deletes, Ctrl+D duplicates, Ctrl+Z / Ctrl+Shift+Z undo and redo,
Esc deselects, M / R switch between move and resize.

The same export runs without a browser:

```sh
foamy-export editor/examples/closet-back-fan.json runs/closet-back-fan
```

## What you can place

All lengths are inches, temperatures °F. Standing in the doorway, x runs left
to right, y from the front wall to the back, z up.

| Thing | What it does |
| --- | --- |
| Machine | A solid box. Pulls `cfm` in through its intake face, heats it by `power` and blows it out its exhaust face. |
| Passive heater | A fanless box (UPS, switch) giving off `power` from all of its surface. |
| Obstacle | A solid box air goes around: furniture, shelves, storage. |
| Vent | An opening in a wall onto still air at the house, outside or attic temperature. |
| Fan | A fixed airflow in or out through a wall. Blowing out needs a vent or duct for air to come back in. |
| Wall panel | Part of a wall with its own construction, such as a window. |
| Ceiling duct | A ceiling register ducted through the attic to a register beyond the room, opening onto the house. |

Each of the six walls has a construction (interior stud, exterior R-13,
double glazing, ceiling under R-22, wood floor, slab, or adiabatic) and the
air temperature beyond it.

## How a scenario becomes a case

`src/export.js` writes every file of a `buoyantSimpleFoam` case from the
scenario, with plain numbers and no `#include` chains, so the files can be
read on their own. `scenario.json` goes in too, as the source to edit.

The mesh is a box of `cellSize` cells, half as tall below `fineZ`. Things
should sit on that grid; the editor snaps to it and the exporter rounds
anything that doesn't. Each solid is cut out of the mesh, and the faces it
leaves behind become its patches. Ducts add an attic slab above the ceiling
for the duct to run through. The physics is the same as `cases/closet`: see
"How it is modelled" in [its README](../cases/closet/README.md).

`examples/` has the closet from `cases/closet` as scenarios, plus a small,
coarse room that meshes and solves in seconds for trying changes out.

## Files

- `index.html`, `style.css`, `src/app.js`: the editor page.
- `src/model.js`: what a scenario is, defaults, snapping and checks.
- `src/export.js`: scenario to OpenFOAM case.
- `src/tar.js`: packs the case for download.
- `cli.mjs`: the export from the command line (`foamy-export`).

In the browser console, `editor.scenario` is the live scenario; change it
and call `editor.commit()` to redraw.
