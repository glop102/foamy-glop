#!/usr/bin/env python3
"""Summarise closet scenario runs.

    report.py runs/<scenario>              print results, write side/front/top.png
    report.py --compare runs/a runs/b ...  one table across scenarios

All numbers come from the function objects in system/controlDict, so this
needs nothing but the run directory.
"""

import glob
import os
import sys

import numpy as np

KG_S_TO_CFM = 1.0 / (0.00047194745 * 1.2)
M_TO_IN = 1 / 0.0254
DEVICES = ("dev", "gaming", "nas")  # top to bottom, as they sit in the rack
OPENINGS = ("doorGap", "highVent", "officeRegister", "fan")


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


def results(run):
    r = {"devices": {}, "openings": {}}
    for d in DEVICES:
        r["devices"][d] = (
            last(run, d + "Intake"),
            last(run, d + "IntakeMax"),
            last(run, d + "Exhaust"),
        )
    for o in OPENINGS:
        v = last(run, o + "Flow")
        r["openings"][o] = 0.0 if v is None else v * KG_S_TO_CFM
    r["air"] = last(run, "air")
    r["airMax"] = last(run, "airMax")
    r["walls"] = wall_heat(run)

    # How much the gaming machine's intake still moved over the last 20% of
    # the run. A settled answer barely moves.
    s = series(run, "gamingIntake")
    if s is not None:
        tail = s[1][int(len(s[1]) * 0.8):]
        r["drift"] = tail.max() - tail.min()
    return r


def temp(k):
    return "      n/a      " if k is None else f"{f(k):5.1f}°F ({c(k):4.1f}°C)"


def print_run(run, r):
    name = os.path.basename(os.path.normpath(run))
    print(f"\n{name}")
    print("  machine   intake avg         intake hottest     exhaust")
    for d, (avg, hot, out) in r["devices"].items():
        print(f"  {d:<8}  {temp(avg)}  {temp(hot)}  {temp(out)}")
    print(f"  closet air average   {temp(r['air'])}")
    print(f"  closet air hottest   {temp(r['airMax'])}")

    for o, cfm in r["openings"].items():
        if abs(cfm) >= 0.05:
            print(f"  {o:<9} net {abs(cfm):5.1f} CFM {'out' if cfm > 0 else 'in'}")
    print("  (a single opening like the door gap can carry air both ways at once;")
    print("   net flow near zero does not mean no exchange)")

    if r["walls"]:
        total = sum(r["walls"].values())
        parts = ", ".join(f"{k} {v:.0f}" for k, v in sorted(r["walls"].items(), key=lambda kv: -kv[1]))
        print(f"  heat out through walls  {total:5.0f} W  ({parts})")

    drift = r.get("drift")
    if drift is not None:
        note = "settled" if drift < 0.2 else "STILL MOVING, run longer before trusting it"
        print(f"  gaming intake drift, last 20%  {drift * 1.8:4.2f}°F ({note})")


def compare(runs):
    print("\nscenario            gaming intake  gaming hottest  closet avg")
    for run in runs:
        name = os.path.basename(os.path.normpath(run))
        r = results(run)
        avg, hot, _ = r["devices"]["gaming"]
        if avg is None:
            print(f"{name:<18}  no results")
            continue
        print(f"{name:<18}  {f(avg):9.1f}°F  {f(hot):11.1f}°F  {f(r['air']):8.1f}°F")


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
        "side": (1, 2, "door → back wall [in]", "height [in]", (5, 8)),
        "front": (0, 2, "left wall → window wall [in]", "height [in]", (5, 8)),
        "top": (0, 1, "left wall → window wall [in]", "door → back wall [in]", (5, 6)),
        "duct": (1, 2, "office ← door wall → back wall [in]", "height [in]", (9, 6)),
    }
    for surface, (a, b, xlabel, ylabel, size) in views.items():
        tfile = os.path.join(latest, f"T_{surface}.raw")
        ufile = os.path.join(latest, f"U_{surface}.raw")
        if not os.path.exists(tfile):
            continue
        T = np.loadtxt(tfile, comments="#", ndmin=2)
        h, v, temps = T[:, a] * M_TO_IN, T[:, b] * M_TO_IN, f(T[:, 3])

        fig, ax = plt.subplots(figsize=size)
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
        print_run(run, results(run))
        plot(run)


if __name__ == "__main__":
    main(sys.argv[1:])
