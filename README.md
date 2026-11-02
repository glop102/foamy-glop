# foamy-glop

An example [OpenFOAM](https://www.openfoam.com/) project packaged with Nix
flakes: OpenFOAM v2606 built from source as a derivation, plus cases you can
actually run:

- `cases/closet`: cooling a server rack in a closet, with scenarios for door
  vents and an exhaust fan. See [its README](cases/closet/README.md).
- `cases/cavity`: the classic lid-driven cavity, as a smoke test.

## Quick start

```sh
nix develop          # first run builds OpenFOAM — see "Build time" below
cd cases/cavity
./Allrun
```

`Allrun` meshes the domain, checks the mesh, runs `icoFoam` and post-processes
the result, writing a `log.<application>` file per step. `./Allclean` puts the
case back the way it was.

### A solver needs a mesh first

`nix run .#` runs `icoFoam`, because that is the package's `mainProgram`. Run
on a fresh checkout it fails with:

```
--> FOAM FATAL ERROR: Cannot find file "points" in directory "polyMesh"
```

That is OpenFOAM behaving correctly, not a packaging fault: `cases/cavity`
ships a `blockMeshDict`, not a mesh, and the mesh is a build product. Generate
it first and the solver has something to solve on.

`nix run` only ever reaches `mainProgram`. To get at any other utility, put the
whole toolbox on `PATH` with `nix shell` or `nix develop`:

```sh
nix shell .# -c blockMesh -case cases/cavity
nix shell .# -c icoFoam   -case cases/cavity
```

`Allrun` exists to sequence exactly that, so the shorter route is:

```sh
nix develop
cd cases/cavity && ./Allrun
```

To look at the result, open the case in ParaView (`nix shell nixpkgs#paraview`)
— OpenFOAM cases are read directly if you create an empty `.foam` file:

```sh
touch cases/cavity/cavity.foam
paraview cases/cavity/cavity.foam
```

## Build time

OpenFOAM is not in nixpkgs, so this flake builds the whole toolbox from ESI's
source release. That is roughly **1–2 hours on a 32-core machine and ~10 GB of
scratch space**, and it happens once — after that it is a cache hit.

If you have a binary cache with it, or you just want the environment:

```sh
nix build .#openfoam    # build only, leaves ./result
```

## What's here

| Path | What it is |
| --- | --- |
| `flake.nix` | Package and dev shell outputs |
| `nix/openfoam.nix` | The OpenFOAM derivation |
| `cases/closet/` | Server closet cooling, `buoyantSimpleFoam` |
| `cases/cavity/` | Lid-driven cavity, `icoFoam` |

### Flake outputs

- `packages.default` / `packages.openfoam` — the OpenFOAM installation. Every
  solver and utility is wrapped in `$out/bin`, so `nix run .#openfoam -- -help`
  works without any environment setup.
- `devShells.default` — sources `etc/bashrc`, so `wmake`, `blockMesh`,
  `foamNewApp` and the rest behave exactly as in a conventional OpenFOAM
  install, and `$WM_PROJECT_DIR`, `$FOAM_TUTORIALS` etc. are set.
- `formatter` — `nixfmt-tree`, so `nix fmt` formats the Nix files.

## Which OpenFOAM is this?

The **ESI / openfoam.com** line (`v2606`), not the OpenFOAM Foundation's
`openfoam.org` line (`v14`). They are two forks of the same 2004 codebase that
diverged in 2014; cases and solvers are generally not portable between them.
ESI was the practical choice here because its build system takes
`SCOTCH_ARCH_PATH`-style prefixes for third-party libraries, which is exactly
what a Nix build needs — see the comments in `nix/openfoam.nix`.

## Building your own solver

Inside `nix develop`, the usual workflow works unchanged:

```sh
foamNewApp myFoam       # scaffolds Make/files and Make/options
cd myFoam
wmake
```

Binaries land in `$FOAM_USER_APPBIN` (under `$HOME/OpenFOAM/`), because
`$WM_PROJECT_DIR` itself is a read-only store path.

## Third-party components

The derivation takes flags for the optional pieces, all on by default:

```nix
pkgs.callPackage ./nix/openfoam.nix { withCGAL = false; }
```

| Flag | Provides |
| --- | --- |
| `withScotch` | `scotch` / `ptscotch` decomposition methods |
| `withMetis` | `metis` decomposition method |
| `withFFTW` | FFT-based function objects (noise, spectra) |
| `withCGAL` | `foamyHexMesh`, `surfaceBooleanFeatures` |

ParaView's reader module, ADIOS2, PETSc, HYPRE and friends are not built.

The bundled community modules and plugins under `modules/` and `plugins/`
(OpenQBMM, `runTimePostProcessing`, cfMesh, avalanche, ...) are skipped via
`FOAM_MODULE_PREFIX=none`. `visualization` needs the VTK/ParaView stack that is
deliberately absent, and OpenQBMM miscomputes its object directory and fails to
link. They are not part of OpenFOAM proper and can be built separately against
this installation with `./Allwmake-modules -prefix=...`.

Because `Allwmake` exits 0 even when individual targets fail to link, the
derivation scans its output for `collect2: error` / `make: ***` and fails the
build if either appears, then checks that a representative set of solvers and
utilities really landed in `$out/bin`.
