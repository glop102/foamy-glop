# Server closet cooling

Steady-state airflow and temperature in the server closet, for comparing
cooling ideas before buying fans or cutting holes. Solver:
`buoyantSimpleFoam` (buoyant air, k-epsilon turbulence).

```sh
nix develop
cd cases/closet
./Allrun gaming-load         # ~15 min on 16 cores
./Allrun                     # every scenario in scenarios/
NPROCS=24 ./Allrun gaming-load
```

Each scenario runs in `runs/<scenario>/`. When it finishes,
[`tools/report.py`](../../tools/report.py) prints
each machine's intake and exhaust temperature, airflow through the openings
and heat lost through each wall, then writes these pictures into the run
directory:

- `side.png`: a slice through the middle of the rack, door on the left
- `front.png`: a slice across the closet between the door and the rack
- `top.png`: a level slice through the middle of the gaming machine
- `duct.png`: a side slice through the ceiling register, duct and office
  register
- `3d.png`: the whole closet from the doorway corner, with streamlines from
  the machines' exhausts and the openings coloured by temperature, and the
  hottest 10% of the air shown as a see-through shell

To turn that 3D view around yourself, `foamy-report --view runs/<scenario>`
opens it in a window. For anything more, open `runs/<scenario>/case.foam`
(written by the report) in ParaView (`nix shell nixpkgs#paraview`).

The same closet is in the [scenario editor](../../editor/README.md) as
`editor/examples/closet-*.json`, if you would rather move things around in 3D
than edit `closetSettings`.

## The closet as modelled

All in `system/closetSettings`, in **inches**. Standing in the doorway:

- 60 in wide, 73 in deep, 96 in tall. Door centred in the front wall, kept
  shut, with a 1.5 in gap under it.
- Left, front and back walls are interior stud walls with the house (68 °F)
  behind them. The right wall is an outside wall (63 °F outside) with a
  30 × 51 in window, 28 in off the floor and 7 in from the back wall.
- Ceiling: drywall under R-22, attic above (assumed at the outside
  temperature). Floor: plywood and hardwood over 68 °F house.
- HVAC register, 5 × 11 in, in the middle of the ceiling. An 8 ft run of
  6 in insulated flex duct through the attic joins it to an identical
  register in the office ceiling, and the office is open to the house. With
  the HVAC off, warm closet air loops up this duct, out into the office and
  back in under the door. That loop is what brings the model in line with
  the ~95 °F seen in real life.
- Open-frame rack against the left wall, fronts facing the door. Only the
  equipment is modelled, a 17 × 24 in stack starting 5 in off the floor,
  bottom to top:

  | Machine | Height | Power | Airflow | Notes |
  | --- | --- | --- | --- | --- |
  | `ups` | 2U | 10 W | none | passive box, sheds heat from its faces |
  | `nas` | 4U | 80 W | 40 CFM | 8 idle HDDs, 15 W CPU |
  | `gaming` | 5U | 270 W | 100 CFM | 7700X + 7900 XTX, typical game load |
  | `dev` | 4U | 120 W | 50 CFM | 5800X + 7900 XTX, light use |

Powers and airflows are estimates, not measurements. The gaming figure is a
measured 150 W GPU and 55 W CPU while playing EVE Online, about 40 W for the
rest of the system, and PSU losses on top; flat out it would be about 560 W. A wall power meter
reading beats all of these. If you can't measure airflow, about 160 CFM per kW
gives a 20 °F rise across the machine.

## What to look at

**Each machine's intake temperature** is the number to optimise. Machines
care about the air arriving at their front panels, not the room average. The
"hottest" intake figure shows whether hot exhaust is curling over the rack and
back into the front.

**Gaming intake drift** says whether the solution has settled. If the report
says it is still moving, raise `endTime` in `system/controlDict` and rerun.

## Trying ideas

A scenario is a few lines in `scenarios/` that override `closetSettings`.
Copy one and edit it:

```sh
cp scenarios/back-fan scenarios/back-fan-40
sed -i 's/fanCFM .*/fanCFM 40;/' scenarios/back-fan-40
./Allrun back-fan-40
```

Scenarios so far:

| Scenario | What changes | Closet avg | Gaming intake |
| --- | --- | --- | --- |
| `gaming-load` | nothing, the baseline | 94.4 °F | 91.9 °F |
| `door-fan` | fan pushes 20 CFM in under the door | 94.1 °F | 91.5 °F |
| `back-fan` | fan pulls 20 CFM out high on the back wall | 88.5 °F | 85.2 °F |

The door fan barely helps because about 19 CFM already flows in under the
door on its own. The back fan helps because it adds a second way out.

The levers already wired in:

- `fan`, `fanCFM`: an exhaust fan pulling air out of the closet (box
  position, airflow). Defaults to 6 × 6 in high on the back wall, off.
- `doorGapMode fan`, `doorFanCFM`: a fan pushing office air in through the
  door gap instead of leaving it passive.
- `grilleK`: pressure loss of each register grille (2 to 5 is typical).
- Duct layout: `registerX`, `registerY`, `officeRegisterY`, `ductDiameter`
  and friends.
- `highVent`: an extra passive opening to the house. Set `outflowHeight` to
  its height if air should leave by it; see the comment in `closetSettings`.
- `doorGap`: the undercut, if you trim the door or add a grille.
- Any machine's `power` and `cfm`.

Openings are boxes. Any closet wall face whose centre falls inside the box
becomes part of the opening, so a vent in the door is a box thin in `y`
around 0. Keep edges on the mesh: half inch below 32 in, whole inches above.

## How it is modelled

- **Each fan-cooled machine** is a solid box. Its front face removes `cfm` of
  air from the closet, and its back face returns the same air heated by
  `power` (boundary condition `outletMappedUniformInletHeatAddition`). What
  happens inside it is not modelled, and its fans don't speed up when the
  intake gets hot.
- **Walls, floor and ceiling** lose heat to whatever is behind them through
  layered constructions: drywall, air cavity, drywall for interior walls;
  drywall, R-13 and siding for the outside wall; an equivalent double-glazing
  layer for the window; drywall and R-22 for the ceiling; plywood and
  hardwood for the floor.
- **Openings** connect to the house as a large room of still air at
  `houseTempF`.
- **The duct** is meshed: a boot above each register, joined by a round
  pipe through a slab of attic, with R-6 insulation to the attic air. Each
  boot holds a porous zone giving the grille's pressure loss (`grilleK`).
  HVAC airflow through it is not modelled yet.
- **Steady state** answers "where does this settle". It does not show warm-up
  time or the unsteady puffing of a single door gap.

These are good for ranking ideas against each other. Absolute temperatures
depend on the real heat load and airflow of your gear.
