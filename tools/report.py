#!/usr/bin/env python3
"""Summarise room-cooling runs: cases/closet scenarios and editor exports.

    report.py <run>                        print results, write *.png
    report.py --compare <run> <run> ...    one table across runs
    report.py --view <run>                 open the 3D view in a window

All numbers come from the function objects in system/controlDict, so this
needs nothing but the run directory. Machines and openings are found from
the function objects' names (<machine>Intake, <opening>Flow).
"""

import glob
import json
import os
import sys

import numpy as np

KG_S_TO_CFM = 1.0 / (0.00047194745 * 1.2)
M_TO_IN = 1 / 0.0254


def c(kelvin):
    return kelvin - 273.15


def f(kelvin):
    return c(kelvin) * 9 / 5 + 32


def dat(run, name):
    """Rows of a function object's .dat file, or None."""
    files = sorted(glob.glob(os.path.join(run, "postProcessing", name, "*", "*.dat")))
    if not files:
        return None
    with open(files[-1]) as fh:
        rows = [line.split() for line in fh if line.strip() and not line.startswith("#")]
    return rows or None


def series(run, name):
    rows = dat(run, name)
    if rows is None or len(rows[0]) < 2:
        return None
    data = np.array([[float(r[0]), float(r[1])] for r in rows])
    return data[:, 0], data[:, 1]


def last(run, name):
    s = series(run, name)
    return None if s is None else s[1][-1]


def wall_heat(run):
    """Heat out through each wall at the last write, W. Rows: time patch min max Q."""
    rows = dat(run, "wallHeat")
    if rows is None:
        return {}
    final = rows[-1][0]
    # wallHeatFlux counts heat into the domain as positive.
    return {r[1]: -float(r[4]) for r in rows if r[0] == final}


def function_objects(run, suffix):
    """Names X of postProcessing/X<suffix>, sorted."""
    names = []
    for path in glob.glob(os.path.join(run, "postProcessing", "*" + suffix)):
        name = os.path.basename(path)[: -len(suffix)]
        if name:
            names.append(name)
    return sorted(names)


def results(run):
    r = {"devices": {}, "openings": {}}
    for d in function_objects(run, "Intake"):
        r["devices"][d] = (
            last(run, d + "Intake"),
            last(run, d + "IntakeMax"),
            last(run, d + "Exhaust"),
        )
    for o in function_objects(run, "Flow"):
        v = last(run, o + "Flow")
        r["openings"][o] = 0.0 if v is None else v * KG_S_TO_CFM
    r["air"] = last(run, "air")
    r["airMax"] = last(run, "airMax")
    r["walls"] = wall_heat(run)

    # The machine with the hottest intake, and how much that intake still
    # moved over the last 20% of the run. A settled answer barely moves.
    hot = [(v[0], d) for d, v in r["devices"].items() if v[0] is not None]
    if hot:
        r["hottest"] = max(hot)[1]
        s = series(run, r["hottest"] + "Intake")
        tail = s[1][int(len(s[1]) * 0.8):]
        r["drift"] = tail.max() - tail.min()
    return r


def temp(k):
    return "      n/a      " if k is None else f"{f(k):5.1f}°F ({c(k):4.1f}°C)"


def run_name(run):
    return os.path.basename(os.path.abspath(run))


def print_run(run, r):
    name = run_name(run)
    print(f"\n{name}")
    print("  machine   intake avg         intake hottest     exhaust")
    for d, (avg, hot, out) in r["devices"].items():
        print(f"  {d:<8}  {temp(avg)}  {temp(hot)}  {temp(out)}")
    print(f"  room air average     {temp(r['air'])}")
    print(f"  room air hottest     {temp(r['airMax'])}")

    for o, cfm in r["openings"].items():
        if abs(cfm) >= 0.05:
            print(f"  {o:<14} net {abs(cfm):5.1f} CFM {'out' if cfm > 0 else 'in'}")
    print("  (a single opening like a door gap can carry air both ways at once;")
    print("   net flow near zero does not mean no exchange)")

    if r["walls"]:
        total = sum(r["walls"].values())
        parts = ", ".join(f"{k} {v:.0f}" for k, v in sorted(r["walls"].items(), key=lambda kv: -kv[1]))
        print(f"  heat out through walls  {total:5.0f} W  ({parts})")

    drift = r.get("drift")
    if drift is not None:
        note = "settled" if drift < 0.2 else "STILL MOVING, run longer before trusting it"
        print(f"  {r['hottest']} intake drift, last 20%  {drift * 1.8:4.2f}°F ({note})")


def compare(runs):
    print("\nscenario            hottest intake            its hottest spot  room avg")
    for run in runs:
        name = run_name(run)
        r = results(run)
        if "hottest" not in r or r["air"] is None:
            print(f"{name:<18}  no results")
            continue
        avg, hot, _ = r["devices"][r["hottest"]]
        label = f"{f(avg):5.1f}°F ({r['hottest']})"
        print(f"{name:<18}  {label:<24}  {f(hot):12.1f}°F  {f(r['air']):6.1f}°F")


def plot(run):
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.tri as mtri
    except ImportError:
        print("  (matplotlib not available, skipping plots)")
        return

    times = glob.glob(os.path.join(run, "postProcessing", "cuts", "*"))
    if not times:
        return
    latest = max(times, key=lambda p: float(os.path.basename(p)))

    # (horizontal axis, vertical axis, labels) for each cut.
    views = {
        "side": (1, 2, "front wall → back wall [in]", "height [in]"),
        "front": (0, 2, "left wall → right wall [in]", "height [in]"),
        "top": (0, 1, "left wall → right wall [in]", "front wall → back wall [in]"),
        "duct": (1, 2, "← duct   front wall → back wall [in]", "height [in]"),
    }
    for surface, (a, b, xlabel, ylabel) in views.items():
        tfile = os.path.join(latest, f"T_{surface}.raw")
        ufile = os.path.join(latest, f"U_{surface}.raw")
        if not os.path.exists(tfile):
            continue
        T = np.loadtxt(tfile, comments="#", ndmin=2)
        h, v, temps = T[:, a] * M_TO_IN, T[:, b] * M_TO_IN, f(T[:, 3])

        # Size the figure to the cut's shape, plus room for the colour bar.
        aspect = np.ptp(v) / max(np.ptp(h), 1e-9)
        width = 5 if aspect >= 1 else min(10, 5 / max(aspect, 0.4))
        fig, ax = plt.subplots(figsize=(width + 1, max(4, min(9, width * aspect))))
        tri = mtri.Triangulation(h, v)
        # Cuts have holes where the equipment is. Triangulation bridges them
        # with long thin triangles; drop anything much bigger than a cell.
        xy = np.stack([h, v], axis=1)[tri.triangles]
        edges = np.linalg.norm(xy - np.roll(xy, 1, axis=1), axis=2).max(axis=1)
        tri.set_mask(edges > 3 * np.median(edges))
        ax.set_facecolor("0.75")  # equipment shows as grey
        cs = ax.tricontourf(tri, temps, levels=40, cmap="inferno")
        fig.colorbar(cs, ax=ax, label="air temperature [°F]")

        if os.path.exists(ufile):
            U = np.loadtxt(ufile, comments="#", ndmin=2)
            step = max(1, int(len(U) / 700))
            sel = U[::step]
            ax.quiver(
                sel[:, a] * M_TO_IN, sel[:, b] * M_TO_IN, sel[:, 3 + a], sel[:, 3 + b],
                color="white", alpha=0.6, scale=4, width=0.003,
            )

        ax.set_aspect("equal")
        ax.set_xlabel(xlabel)
        ax.set_ylabel(ylabel)
        ax.set_title(f"{run_name(run)}: {surface} view")
        out = os.path.join(run, f"{surface}.png")
        fig.savefig(out, dpi=120, bbox_inches="tight")
        plt.close(fig)
        print(f"  wrote {out}")


# Walls drawn as the backdrop. The front, right and ceiling walls are left
# out so the camera can see in from the doorway corner.
BACKDROP = ("floor", "leftWall", "backWall")


def patch_roles(run):
    """{patch: role} for drawing: intake, exhaust, solid, opening or panel.

    Editor exports carry scenario.json, which says what everything is; the
    hand-written closet case falls back to its own patch names.
    """
    roles = {"rackWalls": "solid", "solidWalls": "solid"}
    path = os.path.join(run, "scenario.json")
    if os.path.exists(path):
        with open(path) as fh:
            for o in json.load(fh)["objects"]:
                t, i = o["type"], o["id"]
                if t == "machine":
                    roles[i + "In"] = "intake"
                    roles[i + "Out"] = "exhaust"
                elif t == "heater":
                    roles[i] = "solid"
                elif t in ("vent", "fan"):
                    roles[i] = "opening"
                elif t == "duct":
                    roles[i + "Far"] = "opening"
                elif t == "panel":
                    roles[i] = "panel"
        return roles
    roles.update({"ups": "solid", "window": "panel"})
    for d in ("nas", "gaming", "dev"):
        roles[d + "Front"] = "intake"
        roles[d + "Back"] = "exhaust"
    for o in ("doorGap", "fan", "officeRegister", "highVent"):
        roles[o] = "opening"
    return roles


ROLE_COLORS = {"intake": "#4c6fa5", "exhaust": "#a54c4c", "solid": "#555555", "opening": "#3fbf7f"}


def load_3d(run):
    """Latest time of a run as (air mesh, {patch: surface}), in inches with T in °F."""
    import pyvista as pv

    # The reader wants a .foam file to point at; any name will do.
    foams = glob.glob(os.path.join(run, "*.foam"))
    foam = foams[0] if foams else os.path.join(run, "case.foam")
    open(foam, "a").close()
    reader = pv.POpenFOAMReader(foam)
    reader.set_active_time_value(reader.time_values[-1])
    data = reader.read()
    air = data["internalMesh"].scale(M_TO_IN)
    air.point_data["T"] = f(air.point_data["T"])
    patches = {}
    for name in data["boundary"].keys():
        p = data["boundary"][name]
        if p is not None and p.n_cells:
            patches[name] = p.scale(M_TO_IN)
    return air, patches


def scene_3d(plotter, air, patches, roles, title):
    import pyvista as pv

    temps = air.point_data["T"]
    clim = (np.percentile(temps, 1), np.percentile(temps, 99.5))

    for name in BACKDROP:
        if name in patches:
            plotter.add_mesh(patches[name], color="#d8d4cc", opacity=0.35 if name != "floor" else 1.0)
    if "ductWalls" in patches:
        plotter.add_mesh(patches["ductWalls"], color="#b9b2a5", opacity=0.25)
    for name, role in roles.items():
        if name not in patches:
            continue
        if role == "panel":
            plotter.add_mesh(patches[name], color="#9ec9ff", opacity=0.5)
        else:
            plotter.add_mesh(patches[name], color=ROLE_COLORS[role])

    # The hottest air as a see-through shell.
    hot = air.contour([np.percentile(temps, 90)], scalars="T")
    if hot.n_points:
        plotter.add_mesh(hot, color="#ff8a3d", opacity=0.18, smooth_shading=True)

    # Streamlines from just inside each exhaust and opening. Patch normals
    # point out of the air, so step half an inch against them.
    seeds = []
    for name, role in roles.items():
        if role not in ("exhaust", "opening") or name not in patches:
            continue
        p = patches[name].compute_normals(cell_normals=True, point_normals=False)
        centres = p.cell_centers().points - 0.5 * p.cell_data["Normals"]
        step = max(1, len(centres) // 12)
        seeds.append(centres[::step])
    if seeds:
        lines = air.streamlines_from_source(
            pv.PolyData(np.vstack(seeds)), vectors="U", integration_direction="both",
            max_length=400, initial_step_length=0.5, max_steps=2000,
        )
        if lines.n_points:
            plotter.add_mesh(
                lines.tube(radius=0.3), scalars="T", cmap="inferno", clim=clim,
                scalar_bar_args={"title": "air temperature [°F]", "vertical": True},
            )

    plotter.add_text(title, font_size=12)
    # From above the front-right corner, framing the whole mesh.
    plotter.view_vector((1.0, -0.8, 0.9), viewup=(0, 0, 1))
    plotter.reset_camera()


def render_3d(run, interactive=False):
    try:
        import pyvista as pv
    except ImportError:
        print("  (pyvista not available, skipping 3D render)")
        return
    name = run_name(run)
    air, patches = load_3d(run)
    plotter = pv.Plotter(off_screen=not interactive, window_size=(1400, 1100))
    plotter.set_background("white")
    scene_3d(plotter, air, patches, patch_roles(run), f"{name}: hottest 10% of air, streamlines")
    if interactive:
        plotter.show()
        return
    out = os.path.join(run, "3d.png")
    plotter.screenshot(out)
    plotter.close()
    print(f"  wrote {out}")


def main(argv):
    if argv and argv[0] == "--compare":
        compare(argv[1:])
        return
    if argv and argv[0] == "--view":
        for run in argv[1:]:
            render_3d(run, interactive=True)
        return
    for run in argv:
        print_run(run, results(run))
        plot(run)
        render_3d(run)


if __name__ == "__main__":
    main(sys.argv[1:])
