# OpenFOAM (ESI / openfoam.com) built from source.
#
# OpenFOAM does not use autotools or CMake; it has its own build system, wmake,
# driven entirely by environment variables that `etc/bashrc` sets up. Two
# consequences shape this derivation:
#
#   1. It builds *in-tree*: libraries and executables land under
#      `$WM_PROJECT_DIR/platforms/`. So we copy the source into $out up front
#      and build there, which also means every baked-in path is already final.
#
#   2. It expects its dependencies in a sibling "ThirdParty" checkout. ESI's
#      `wmake/scripts/have_*` helpers will however accept any prefix with the
#      usual include/ + lib/ layout, so we point them at nixpkgs store paths
#      and skip ThirdParty entirely.
{
  lib,
  stdenv,
  fetchurl,
  makeWrapper,
  symlinkJoin,

  bison,
  boost,
  cgal_5,
  fftw,
  flex,
  gmp,
  gnumake,
  m4,
  metis,
  mpfr,
  ncurses,
  openmpi,
  readline,
  scotch,
  which,
  zlib,

  # Optional third-party components. Turning one off drops the applications
  # that need it but makes the build smaller and faster.
  withScotch ? true, # scotch/ptscotch decomposition methods
  withMetis ? true, # metis decomposition method
  withFFTW ? true, # FFT-based function objects (noise, spectra)
  withCGAL ? true, # foamyHexMesh, surfaceBooleanFeatures
}:

let
  version = "2606";

  # nixpkgs builds scotch without its MPI half by default, which costs us the
  # `ptscotch` decomposition method and redistributePar.
  scotchMpi = scotch.override { withPtScotch = true; };

  # nixpkgs splits headers and shared libraries into separate outputs, but
  # OpenFOAM's `have_*` probes look for include/ and lib/ under a single
  # prefix. Glue the relevant outputs back together for the ones it probes.
  prefixOf =
    pkg:
    symlinkJoin {
      name = "openfoam-prefix-${pkg.pname or pkg.name}";
      paths = lib.unique [
        (lib.getDev pkg)
        (lib.getLib pkg)
      ];
    };

  # WM_OPTIONS: <arch><compiler><precision><label><compileOption>
  wmArch =
    {
      x86_64-linux = "linux64";
      aarch64-linux = "linuxARM64";
    }
    .${stdenv.hostPlatform.system}
      or (throw "openfoam: unsupported system ${stdenv.hostPlatform.system}");

  wmOptions = "${wmArch}GccDPInt32Opt";

  # Where the OpenFOAM tree itself lives. Kept out of $out/bin so the wrappers
  # we generate are the only thing on PATH.
  projectDir = "opt/OpenFOAM-v${version}";
in
stdenv.mkDerivation {
  pname = "openfoam";
  inherit version;

  src = fetchurl {
    url = "https://dl.openfoam.com/source/v${version}/OpenFOAM-v${version}.tgz";
    hash = "sha256-KhMQ4+0ZLMTFIeHSLcwXb1e+xhFgyHjcQ0jyHWZyKU0=";
  };

  nativeBuildInputs = [
    makeWrapper
    bison
    flex
    gnumake
    m4
    openmpi
    which
  ];

  buildInputs = [
    ncurses
    openmpi
    readline
    zlib
  ]
  ++ lib.optional withScotch scotchMpi
  ++ lib.optional withMetis metis
  ++ lib.optional withFFTW fftw
  ++ lib.optionals withCGAL [
    boost
    cgal_5
    gmp
    mpfr
  ];

  # Rewrite the ThirdParty config files to point at the store. Each of these is
  # sourced by wmake; `<pkg>-none` is the documented way to disable one.
  postPatch =
    let
      pathOr =
        cond: pkg: fallback:
        if cond then "${pkg}" else fallback;
    in
    ''
      cat > etc/config.sh/scotch <<EOF
      export SCOTCH_ARCH_PATH=${pathOr withScotch (prefixOf scotchMpi) "scotch-none"}
      export PTSCOTCH_ARCH_PATH=${pathOr withScotch (prefixOf scotchMpi) "scotch-none"}
      EOF

      cat > etc/config.sh/metis <<EOF
      export METIS_ARCH_PATH=${pathOr withMetis (prefixOf metis) "metis-none"}
      EOF

      cat > etc/config.sh/FFTW <<EOF
      export FFTW_ARCH_PATH=${pathOr withFFTW (prefixOf fftw) "fftw-none"}
      EOF

      cat > etc/config.sh/CGAL <<EOF
      export BOOST_ARCH_PATH=${pathOr withCGAL (prefixOf boost) "boost-none"}
      export CGAL_ARCH_PATH=${pathOr withCGAL (prefixOf cgal_5) "cgal-none"}
      export GMP_ARCH_PATH=${pathOr withCGAL (prefixOf gmp) "gmp-none"}
      export MPFR_ARCH_PATH=${pathOr withCGAL (prefixOf mpfr) "mpfr-none"}
      EOF

      # Components we deliberately do not build. Leaving the originals in place
      # would send wmake looking for a ThirdParty tree that does not exist.
      for unused in kahip adios2 hypre petsc mgridgen ccmio hdf5 gperftools; do
        : > "etc/config.sh/$unused"
      done

      # ParaView is a separate package; do not build the reader module.
      : > etc/config.sh/paraview
      : > etc/config.sh/vtk

      # etc/bashrc sources prefs.sh before anything else and it survives an
      # upgrade of the config files, so it is the intended place for site
      # settings. Pinning MPI here avoids a PATH-order-dependent `mpicc` probe.
      cat > etc/prefs.sh <<EOF
      export MPI_ARCH_PATH=${prefixOf openmpi}
      EOF

      patchShebangs --build Allwmake bin wmake tutorials
    '';

  dontConfigure = true;

  # `enableParallelBuilding` has no effect: wmake reads WM_NCOMPPROCS, not -j.
  buildPhase = ''
    runHook preBuild

    mkdir -p "$out/${projectDir}"
    cp -a . "$out/${projectDir}"
    cd "$out/${projectDir}"

    # etc/bashrc is written for interactive shells and reads unset variables
    # freely, so relax the strict mode nix's builder turns on.
    set +u
    source ./etc/bashrc
    set -u

    [ "$WM_OPTIONS" = "${wmOptions}" ] || {
      echo "expected WM_OPTIONS=${wmOptions}, got '$WM_OPTIONS'" >&2
      exit 1
    }

    # Keep the ~10GB of object files out of the output. wmake only honours
    # FOAM_BUILDROOT when the directory already exists and is writable.
    export FOAM_BUILDROOT="$NIX_BUILD_TOP/wmake-objects"
    mkdir -p "$FOAM_BUILDROOT"
    export WM_NCOMPPROCS="''${NIX_BUILD_CORES:-1}"

    # Skip the bundled community modules and plugins. `visualization` needs the
    # VTK/ParaView stack this package deliberately leaves out, and OpenQBMM
    # miscomputes its object directory and fails to link. Neither is part of
    # OpenFOAM proper; both can be built separately against this installation
    # with ./Allwmake-modules -prefix=... if you need them.
    export FOAM_MODULE_PREFIX=none

    ./Allwmake -s -q 2>&1 | tee "$NIX_BUILD_TOP/allwmake.log"

    # Allwmake returns 0 even when individual targets fail to compile or link,
    # which would leave a half-built toolbox looking like a success.
    if grep -qE 'collect2: error|^make: \*\*\*' "$NIX_BUILD_TOP/allwmake.log"; then
      echo "Allwmake reported build failures:" >&2
      grep -nE 'collect2: error|^make: \*\*\*' "$NIX_BUILD_TOP/allwmake.log" >&2
      exit 1
    fi

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Belt and braces: if FOAM_BUILDROOT were ever ignored, the object files
    # would be sitting in the output.
    rm -rf "$out/${projectDir}/build"

    appbin="$out/${projectDir}/platforms/${wmOptions}/bin"
    libbin="$out/${projectDir}/platforms/${wmOptions}/lib"

    # Second guard, on the result rather than the log: confirm a representative
    # spread of solvers and utilities actually landed.
    for required in \
      blockMesh snappyHexMesh checkMesh \
      icoFoam simpleFoam pimpleFoam interFoam potentialFoam \
      decomposePar reconstructPar redistributePar \
      postProcess foamToVTK; do
      [ -x "$appbin/$required" ] || {
        echo "build incomplete: $required was not produced" >&2
        exit 1
      }
    done

    mkdir -p "$out/bin"
    for exe in "$appbin"/*; do
      makeWrapper "$exe" "$out/bin/$(basename "$exe")" \
        --set WM_PROJECT OpenFOAM \
        --set WM_PROJECT_VERSION "v${version}" \
        --set WM_PROJECT_DIR "$out/${projectDir}" \
        --set WM_OPTIONS "${wmOptions}" \
        --set FOAM_ETC "$out/${projectDir}/etc" \
        --set FOAM_APPBIN "$appbin" \
        --set FOAM_LIBBIN "$libbin" \
        --set FOAM_MPI "$FOAM_MPI" \
        --prefix LD_LIBRARY_PATH : "$libbin:$libbin/$FOAM_MPI:$libbin/dummy"
    done

    runHook postInstall
  '';

  # The tree contains ~15k lnInclude symlinks and the full source, both of
  # which user solvers need at wmake time. Stripping walks all of it and buys
  # very little, so skip the slowest fixup steps.
  dontPatchELF = true;

  passthru = {
    inherit wmOptions;
    # Consumers (the devShell, case runners) need WM_PROJECT_DIR, which is a
    # subdirectory of $out rather than $out itself.
    foamProjectSubdir = projectDir;
  };

  meta = {
    description = "Free, open source CFD toolbox (ESI/OpenCFD release)";
    homepage = "https://www.openfoam.com/";
    license = lib.licenses.gpl3Plus;
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    mainProgram = "icoFoam";
  };
}
