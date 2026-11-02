#!/usr/bin/env python3
"""Summarise closet scenario runs.

    report.py runs/<scenario>              print results, write side.png/front.png
    report.py --compare runs/a runs/b ...  one table across scenarios

All numbers come from the function objects in system/controlDict, so this
needs nothing but the run directory.
"""

import glob
import os
import sys

import numpy as np

KG_S_TO_CFM = 1.0 / (0.00047194745 * 1.2)


def c(kelvin):
    return kelvin - 273.15


def f(kelvin):
    return c(kelvin) * 9 / 5 + 32


def series(run, name):
    """Iteration and value columns of a function object's .dat file."""
    files = sorted(glob.glob(os.path.join(run, "postProcessing", name, "*", "*.dat")))
    if not files:
        return None
    data = np.loadtxt(files[-1], comments="#", ndmin=2)
    if data.shape[0] == 0 or data.shape[1] < 2:
        return None
    return data[:, 0], data[:, 1]


def last(run, name):
    s = series(run, name)
    return None if s is None else s[1][-1]


def results(run):
    r = {
        "intake": last(run, "intake"),
        "intakeMax": last(run, "intakeMax"),
        "exhaust": last(run, "exhaust"),
        "air": last(run, "air"),
        "airMax": last(run, "airMax"),
    }
    for vent in ("lowVent", "highVent", "fan"):
        v = last(run, vent + "Flow")
        r[vent] = 0.0 if v is None else v * KG_S_TO_CFM

    # How much the intake temperature still moved over the last 20% of the
    # run. A steady answer should barely move.
    s = series(run, "intake")
    if s is not None:
        tail = s[1][int(len(s[1]) * 0.8):]
        r["drift"] = tail.max() - tail.min()
    return r


def temp(k):
    return "   n/a" if k is None else f"{c(k):5.1f}°C / {f(k):5.1f}°F"


def flow(cfm):
    # Positive means air leaving the closet.
    if abs(cfm) < 0.05:
        return "      0 CFM"
    return f"{abs(cfm):5.1f} CFM {'out' if cfm > 0 else 'in '}"


def print_run(run, r):
    name = os.path.basename(os.path.normpath(run))
    print(f"\n{name}")
    print(f"  rack intake, average   {temp(r['intake'])}")
    print(f"  rack intake, hottest   {temp(r['intakeMax'])}")
    print(f"  rack exhaust, average  {temp(r['exhaust'])}")
    print(f"  closet air, average    {temp(r['air'])}")
    print(f"  closet air, hottest    {temp(r['airMax'])}")
    print(f"  low vent               {flow(r['lowVent'])}")
    print(f"  high vent              {flow(r['highVent'])}")
    print(f"  exhaust fan            {flow(r['fan'])}")
    drift = r.get("drift")
    if drift is not None:
        note = "settled" if drift < 0.2 else "STILL MOVING, run longer before trusting it"
        print(f"  intake drift, last 20% {drift:5.2f} K ({note})")


def compare(runs):
    rows = [(os.path.basename(os.path.normpath(r)), results(r)) for r in runs]
    print("\nscenario            intake avg  intake max  closet avg   vents in (CFM)")
    for name, r in rows:
        inflow = sum(-r[v] for v in ("lowVent", "highVent", "fan") if r[v] < 0)
        if r["intake"] is None:
            print(f"{name:<18}  no results")
            continue
        print(
            f"{name:<18}  {c(r['intake']):7.1f}°C  {c(r['intakeMax']):7.1f}°C"
            f"  {c(r['air']):7.1f}°C  {inflow:10.1f}"
        )


def read_raw(path):
    """A raw surface file: x y z then one column per component."""
    return np.loadtxt(path, comments="#", ndmin=2)


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

    # (horizontal axis index, label) for each cut; z is always vertical.
    views = {"side": (1, "y: door → back wall [m]"), "front": (0, "x: across closet [m]")}
    for surface, (axis, xlabel) in views.items():
        tfile = glob.glob(os.path.join(latest, f"T_{surface}.raw")) or glob.glob(
            os.path.join(latest, surface, "*", "T*")
        )
        ufile = glob.glob(os.path.join(latest, f"U_{surface}.raw")) or glob.glob(
            os.path.join(latest, surface, "*", "U*")
        )
        if not tfile:
            continue
        T = read_raw(tfile[0])
        h, z, temps = T[:, axis], T[:, 2], c(T[:, 3])

        fig, ax = plt.subplots(figsize=(5, 8))
        tri = mtri.Triangulation(h, z)
        # The cut has a hole where the rack is. Triangulation bridges it with
        # long thin triangles; drop anything much bigger than a cell.
        xy = np.stack([h, z], axis=1)[tri.triangles]
        edges = np.linalg.norm(xy - np.roll(xy, 1, axis=1), axis=2).max(axis=1)
        tri.set_mask(edges > 3 * np.median(edges))
        cs = ax.tricontourf(tri, temps, levels=40, cmap="inferno")
        fig.colorbar(cs, ax=ax, label="air temperature [°C]")

        if ufile:
            U = read_raw(ufile[0])
            # Thin the arrows out to roughly one per 10 cm.
            step = max(1, int(len(U) / 600))
            sel = U[::step]
            ax.quiver(
                sel[:, axis], sel[:, 2], sel[:, 3 + axis], sel[:, 5],
                color="white", alpha=0.6, scale=4, width=0.003,
            )

        ax.set_aspect("equal")
        ax.set_xlabel(xlabel)
        ax.set_ylabel("z: height [m]")
        ax.set_title(f"{os.path.basename(os.path.normpath(run))}: {surface} view")
        out = os.path.join(run, f"{surface}.png")
        fig.savefig(out, dpi=120, bbox_inches="tight")
        plt.close(fig)
        print(f"  wrote {out}")


def main(argv):
    if argv and argv[0] == "--compare":
        compare(argv[1:])
        return
    for run in argv:
        r = results(run)
        print_run(run, r)
        plot(run)


if __name__ == "__main__":
    main(sys.argv[1:])
