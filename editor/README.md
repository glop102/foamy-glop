# Scenario studio

A 3D editor for airflow and cooling scenarios, plus a local runner. Build a
space out of boxes, pipes and ducts, put machines, fans and openings in it,
press Run, and watch it solve. No OpenFOAM dictionaries to write by hand.

```sh
nix run .#studio          # http://localhost:8642/, runs go in ./runs/
# or, inside `nix develop`, serve your working copy while you change it:
foamy-studio --editor editor --export "node editor/cli.mjs"
```

The page also works as plain static files (any file server), without the
Run button: Export downloads the case instead. It loads three.js from a CDN,
so it needs internet access.

## How a scenario is put together

A scenario is an ordered list of items. Lengths are inches, temperatures °F;
x runs left to right, y front to back, z up.

| Group | Item | What it does |
| --- | --- | --- |
| Space | Air | Space air can be in: a box, a cylinder, or a path (a duct with bends). Overlapping air joins up, so two rooms and a doorway are three boxes, and a duct is just air in a pipe shape. An air item can give its own surfaces a construction, which is how a duct gets its insulation. |
| Solids | Machine | A box that pulls `cfm` in its intake face, heats it by `power` and blows it out its exhaust face. At 0 W it is a box fan. |
| | Passive heater | A fanless box giving off `power` from its surface. |
| | Obstacle | A box or cylinder air goes around. |
| Surfaces | Wall section | Surfaces inside its box get a construction: a window, an outside wall, a floor. |
| | Opening | Surfaces inside its box open onto still air at an ambient temperature. |
| | Wall fan | Surfaces inside its box move a fixed airflow in or out. |
| Zones | Heat source | Adds `power` to the air inside it, with no solid: a person, a radiator. |
| | Pressure loss | Resists flow through it: a grille or filter, with loss coefficient `K` over its length. |

Surface items are boxes that **catch the surfaces inside them**, wherever
those are: a room's wall, the top of a cabinet, the end of a duct. Click
one in the Add panel, then click a surface in the view and it is placed flat
on it. Later items in the list win where they overlap (↑/↓ reorder).
Everything else gets the **default surface** from the scenario settings.

**Ambients** are the still air beyond surfaces: house, outside, attic and
below-floor to start with, and you can add more. Constructions and openings
point at one.

Things snap to the mesh grid: `cellSize` cells, half as tall below
`fineZ`. Cylinders and paths need to be at least two cells across.

## Using the editor

- Click an item in the view or the list to select it; the right panel has
  every number. Nothing selected shows the scenario settings.
- **Move** mode: drag the arrows. Surface items only slide along their
  surface. For cylinders and paths, click a dot to move just that point.
- **Resize** mode: drag the dots on each face of a box.
- **Checks** lists problems as you go. Errors (red) block Run and Export;
  warnings (yellow) will mesh but may not be what you meant.
- **Save** and **Open** move scenario JSON in and out; the page also
  autosaves in your browser. Ctrl+Z / Ctrl+Shift+Z undo and redo, Del
  deletes, Ctrl+D duplicates, Esc deselects, M and R switch modes.

## Running

With the studio, **▶ Run** exports the scenario to `runs/<name>/` and runs
its `Allrun` there. The Runs panel shows the phase, the iteration, machine
intake temperatures and solver residuals as they go, then the report and
pictures. **Open 3D view** opens the PyVista window on your desktop;
**Load scenario** brings a run's scenario back into the editor. A run with
the same name is replaced, so rename the scenario to keep both.

Without the studio, Export downloads `<name>.tar.gz`:

```sh
tar xzf two-rooms.tar.gz
nix develop /path/to/foamy-glop
two-rooms/Allrun        # mesh, solve, write report.txt and pictures
```

`foamy-export scenario.json <dir>` does the same export from the command
line.

## What the export does

`src/export.js` writes every file of a `buoyantSimpleFoam` case, with plain
numbers, so each file can be read on its own:

1. `blockMesh` makes one grid block over the bounding box of all the air.
2. `topoSet` selects the air items' cells and removes the solids';
   `subsetMesh` keeps just those. Every surface left is "surfaces", the
   default construction.
3. A second `topoSet` makes a face set for each patch, in priority order:
   machine faces, then surface items (later first), heaters, the rest of
   the solids' surfaces, then air items with their own construction.
   `createPatch` turns them into patches.
4. `Allrun` checks that every fan and machine face caught some faces (with
   none, a fixed airflow has nowhere to go), then solves.

The physics is the same as `cases/closet`; see "How it is modelled" in
[its README](../cases/closet/README.md). `examples/` has that closet as
scenarios, a small coarse room that solves in seconds, and two rooms joined
by a doorway and a duct.

## Files

- `index.html`, `style.css`, `src/app.js`: the editor.
- `src/runs.js`: the Run button and Runs panel (only with the studio).
- `src/model.js`: what a scenario is, defaults, snapping and checks.
- `src/export.js`: scenario to OpenFOAM case.
- `src/tar.js`: packs the case for download.
- `cli.mjs`: the export from the command line (`foamy-export`).
- `../tools/studio.py`: the studio server (`foamy-studio`).

In the browser console, `editor.scenario` is the live scenario; change it
and call `editor.commit()` to redraw.
