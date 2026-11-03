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

      # VTK (pyvista) is built against Nix's libglvnd, which cannot see the
      # host's GL drivers outside NixOS. Hand it Nix's own Mesa, which still
      # drives the real GPU (or falls back to llvmpipe).
      glEnv = pkgs: {
        __EGL_VENDOR_LIBRARY_DIRS = "${pkgs.mesa}/share/glvnd/egl_vendor.d";
        LIBGL_DRIVERS_PATH = "${pkgs.mesa}/lib/dri";
        LD_LIBRARY_PATH = "${pkgs.mesa}/lib";
      };

      tools = pkgs: openfoam: rec {
        python = pkgs.python3.withPackages (ps: [
          ps.numpy
          ps.matplotlib
          ps.pyvista
        ]);

        # Result summary, slice plots and 3D renders for a finished run.
        foamy-report = pkgs.writeShellScriptBin "foamy-report" ''
          ${pkgs.lib.concatStrings (pkgs.lib.mapAttrsToList (k: v: "export ${k}=${v}\n") (glEnv pkgs))}
          exec ${python}/bin/python3 ${./tools/report.py} "$@"
        '';

        # Scenario JSON -> OpenFOAM case directory, as the editor exports it.
        foamy-export = pkgs.writeShellScriptBin "foamy-export" ''
          exec ${pkgs.nodejs}/bin/node ${./editor}/cli.mjs "$@"
        '';

        # The editor plus a local job runner. Brings its own OpenFOAM
        # environment, so `nix run .#studio` works outside `nix develop`.
        # Inside the dev shell, `foamy-studio --editor editor` serves your
        # working copy instead of the flake's snapshot.
        foamy-studio = pkgs.writeShellScriptBin "foamy-studio" ''
          if [ -z "''${WM_PROJECT_DIR:-}" ]
          then
              set +u
              . ${openfoam}/${openfoam.foamProjectSubdir}/etc/bashrc
          fi
          export PATH="${
            pkgs.lib.makeBinPath [
              pkgs.openmpi
              foamy-export
              foamy-report
            ]
          }:$PATH"
          exec ${pkgs.python3}/bin/python3 ${./tools/studio.py} --editor ${./editor} "$@"
        '';
      };
    in
    {
      packages = forAllSystems (pkgs: rec {
        openfoam = pkgs.callPackage ./nix/openfoam.nix { };
        default = openfoam;
        inherit (tools pkgs openfoam) foamy-report foamy-export foamy-studio;
      });

      apps = forAllSystems (pkgs: {
        studio = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.foamy-studio}/bin/foamy-studio";
        };
      });

      devShells = forAllSystems (
        pkgs:
        let
          openfoam = self.packages.${pkgs.stdenv.hostPlatform.system}.openfoam;
          projectDir = "${openfoam}/${openfoam.foamProjectSubdir}";
          t = tools pkgs openfoam;
        in
        {
          default = pkgs.mkShell (
            (glEnv pkgs)
            // {
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

                # tools/report.py, the editor's exporter and the studio.
                t.python
                pkgs.nodejs
                t.foamy-report
                t.foamy-export
                t.foamy-studio
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
                echo "  studio         = foamy-studio --editor editor   (see editor/README.md)"
              '';
            }
          );
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
