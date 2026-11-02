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

Each scenario runs in `runs/<scenario>/`. When it finishes, `report.py` prints
each machine's intake and exhaust temperature, airflow through the openings
and heat lost through each wall, then writes three pictures into the run
directory:

- `side.png`: a slice through the middle of the rack, door on the left
- `front.png`: a slice across the closet between the door and the rack
- `top.png`: a level slice through the middle of the gaming machine

To see everything in 3D, `touch runs/<scenario>/case.foam` and open it in
ParaView (`nix shell nixpkgs#paraview`).

## The closet as modelled

All in `system/closetSettings`, in **inches**. Standing in the doorway:

- 60 in wide, 73 in deep, 96 in tall. Door centred in the front wall, kept
  shut, with a 1.5 in gap under it.
- Left, front and back walls are interior stud walls with the house (68 °F)
  behind them. The right wall is an outside wall (63 °F outside) with a
  30 × 51 in window, 28 in off the floor and 7 in from the back wall.
- Ceiling: drywall under R-22, attic above (assumed at the outside
  temperature). Floor: plywood and hardwood over 68 °F house.
- HVAC supply register, 5 × 11 in, in the middle of the ceiling, ducted
  through the attic to the rest of the house. Off by default.
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
cp scenarios/gaming-load scenarios/ac-on
echo 'acCFM 100;' >> scenarios/ac-on
./Allrun ac-on
```

The levers already wired in:

- `acCFM`, `acTempF`: HVAC supply through the ceiling register.
- `registerMode open`: the register as a plain hole to the house instead,
  for air drifting up the duct and out of the office register with the HVAC
  off. No duct friction, so it is a best case; see `scenarios/register-open`.
- `fan`, `fanCFM`: an exhaust fan ducted out of the closet (box position,
  airflow).
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
- **Steady state** answers "where does this settle". It does not show warm-up
  time or the unsteady puffing of a single door gap.

These are good for ranking ideas against each other. Absolute temperatures
depend on the real heat load and airflow of your gear.
