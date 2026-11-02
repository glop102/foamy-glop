{
  description = "Example OpenFOAM project: OpenFOAM v2606 built from source, plus a lid-driven cavity case";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        openfoam = pkgs.callPackage ./nix/openfoam.nix { };
        default = openfoam;
      });

      devShells = forAllSystems (
        pkgs:
        let
          openfoam = self.packages.${pkgs.stdenv.hostPlatform.system}.openfoam;
          projectDir = "${openfoam}/${openfoam.foamProjectSubdir}";
        in
        {
          default = pkgs.mkShell {
            packages = [
              openfoam
              pkgs.openmpi

              # wmake needs a full toolchain available to build your own
              # solvers and function objects against the installed tree.
              pkgs.bison
              pkgs.flex
              pkgs.gnumake
              pkgs.m4
              pkgs.which

              # cases/closet/report.py: result summary and plots.
              (pkgs.python3.withPackages (ps: [
                ps.numpy
                ps.matplotlib
              ]))
            ];

            # Sourcing etc/bashrc is what makes an OpenFOAM shell an OpenFOAM
            # shell: it defines WM_*/FOAM_* and puts wmake on PATH. It is
            # written for interactive use and reads unset variables freely, so
            # nounset has to come off around it -- and go back exactly as it
            # was, since this ends up in the caller's interactive shell.
            shellHook = ''
              __foamNounset="$(shopt -po nounset)"
              set +u
              source ${projectDir}/etc/bashrc
              eval "$__foamNounset"
              unset __foamNounset

              echo "OpenFOAM $WM_PROJECT_VERSION ($WM_OPTIONS)"
              echo "  WM_PROJECT_DIR = $WM_PROJECT_DIR"
              echo "  example case   = cases/cavity  (cd cases/cavity && ./Allrun)"
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
