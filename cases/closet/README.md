# Server closet cooling

Steady-state airflow and temperature in a closet holding a server rack, for
comparing cooling ideas before cutting holes in a door. Solver:
`buoyantSimpleFoam` (buoyant air, k-epsilon turbulence).

```sh
nix develop
cd cases/closet
./Allrun                    # every scenario, ~5 min each on 8 cores
./Allrun door-vents         # just one
NPROCS=16 ./Allrun exhaust-fan
```

Each scenario runs in `runs/<scenario>/`. When it finishes, `report.py` prints
the numbers that matter and writes two pictures into the run directory:

- `side.png`: a slice through the middle of the rack, door on the left
- `front.png`: a slice through the gap between the door and the rack front

With more than one scenario, a comparison table is printed at the end. To see
everything in 3D, `touch runs/<scenario>/case.foam` and open it in ParaView
(`nix shell nixpkgs#paraview`).

## What to look at

**Rack intake temperature** is the number to optimise. Servers care about the
air arriving at their front panels, not the room average. ASHRAE's
recommended range tops out at 27 °C (80.6 °F). The "hottest" intake figure
shows whether hot exhaust is curling over the top of the rack and back into
the front, which is the usual failure in a small closet.

**Intake drift** says whether the solution has settled. If the report says
it is still moving, raise `endTime` in `system/controlDict` and rerun.

## Changing the setup

All the knobs are in `system/closetSettings`: closet size, rack size and
position, IT load in watts, rack airflow in CFM, house temperature, and the
openings. A scenario is a few lines in `scenarios/` that override those
settings. To try an idea, copy a scenario and edit it:

```sh
cp scenarios/door-vents scenarios/bigger-vents
$EDITOR scenarios/bigger-vents
./Allrun bigger-vents
```

Openings are boxes in space. Any closet wall face whose centre falls inside
the box becomes part of the opening. The door is the `y = 0` wall, the floor
is `z = 0`, so a vent in the door is a box that is thin in `y` around 0. Keep
edges on multiples of `cellSize` (2.5 cm).

Available openings: `lowVent` and `highVent` (passive, open to the house) and
`fan` (an exhaust fan with a fixed CFM, ducted out of the closet). For a
passive pair, set `outflowHeight` to the height of the one air should leave
by; see the comment in `closetSettings`.

## How it is modelled

- **The rack** is a solid box. Its front face removes `rackCFM` of air from
  the closet, and its back face returns the same air heated by `rackPower`
  (boundary condition `outletMappedUniformInletHeatAddition`). Nothing about
  the servers inside is modelled. Two consequences: blanking panels are
  assumed (no air short-circuits through the rack), and the airflow stays
  fixed even when the intake air gets hot, whereas real fans spin up.
- **Walls, door and ceiling** are 12.7 mm drywall with the house at
  `houseTempC` on the far side. This gives a small amount of heat loss even
  with no ventilation. The floor is adiabatic.
- **Openings** connect to the house as a large room of still air at
  `houseTempC`. A vent is modelled as fully open; a louvred grille has roughly
  half the free area of its face size, so draw the box at the free area.
- **Steady state** answers "where does this settle". It does not show warm-up
  time or the unsteady puffing a single door undercut really has. Treat the
  `closed-door` case as indicative only.

These are good for ranking ideas against each other. Absolute temperatures
depend on the real airflow and heat load of your gear, so set `rackPower` from
a power meter reading and `rackCFM` from the server specs if you can (rule of
thumb: about 160 CFM per kW for a 20 °F rise across the servers).
