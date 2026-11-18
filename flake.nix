{
  description = "Audiobook Studio — local-first EPUB/TXT to audiobook studio with a bundled audio.cpp (Vulkan) TTS runtime";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;

      perSystem =
        system:
        let
          inherit (nixpkgs) lib;
          pkgs = nixpkgs.legacyPackages.${system};

          pkgJson = builtins.fromJSON (builtins.readFile ./package.json);
          versions = builtins.fromJSON (builtins.readFile ./versions.json);
          # Only Linux x64 is published upstream; setup.ps1 covers Windows.
          audioCppAsset = versions.audio_cpp.assets."linux-x64";

          # `engines` asks for Node >= 22.13 (built-in node:sqlite).
          nodejs = pkgs.nodejs_22;

          # audio.cpp is built against Vulkan + libstdc++/libgomp; libvulkan.so.1
          # is dlopen'd, so it must be on LD_LIBRARY_PATH, not just RPATH.
          runtimeLibs = [
            pkgs.vulkan-loader
            pkgs.stdenv.cc.cc.lib
          ];

          # Source of truth for `npm run build`; runtime/, data/ and dist/ are
          # gitignored state and must never end up in the store.
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./LICENSE
              ./package.json
              ./package-lock.json
              ./scripts
              ./src
              ./tests
              ./tsconfig.json
              ./tsconfig.web.json
              ./versions.json
              ./vite.config.ts
              ./vitest.config.ts
              ./web
            ];
          };

          # --- pinned audio.cpp Vulkan runtime (versions.json) ---------------
          audio-cpp = pkgs.stdenvNoCC.mkDerivation {
            pname = "audio-cpp";
            version = versions.audio_cpp.version;

            src = pkgs.fetchurl {
              name = audioCppAsset.filename;
              inherit (audioCppAsset) url;
              hash = audioCppAsset.sri;
            };

            nativeBuildInputs = [
              pkgs.autoPatchelfHook
              pkgs.makeWrapper
            ];
            buildInputs = runtimeLibs;

            dontConfigure = true;
            dontBuild = true;
            dontStrip = true;
            # Bundled sibling libraries are dlopen'd with $ORIGIN-relative names.
            appendRunpaths = [ "$ORIGIN" ];

            installPhase = ''
              runHook preInstall
              # Tarballs ship either flat or wrapped in one directory.
              serverDir=.
              if [ ! -f ./audiocpp_server ]; then
                found="$(find . -mindepth 1 -maxdepth 2 -type f -name audiocpp_server -print -quit)"
                if [ -n "$found" ]; then
                  serverDir="$(dirname "$found")"
                fi
              fi
              mkdir -p "$out/lib/audiobook-studio/runtime/bin"
              cp -a "$serverDir/." "$out/lib/audiobook-studio/runtime/bin/"
              find "$out/lib/audiobook-studio/runtime/bin" -maxdepth 1 -type f -name 'audiocpp_*' -exec chmod +x {} +
              runHook postInstall
            '';

            postFixup = ''
              mkdir -p $out/bin
              makeWrapper $out/lib/audiobook-studio/runtime/bin/audiocpp_server $out/bin/audiocpp_server \
                --prefix LD_LIBRARY_PATH : "$out/lib/audiobook-studio/runtime/bin:${lib.makeLibraryPath runtimeLibs}"
            '';

            meta = {
              description = "audio.cpp ${versions.audio_cpp.version} Vulkan server (portable Linux x86_64 build)";
              homepage = "https://github.com/${versions.audio_cpp.repo}";
              license = lib.licenses.asl20;
              platforms = [ "x86_64-linux" ];
              mainProgram = "audiocpp_server";
            };
          };

          # --- pinned GGUF weights (versions.json) ---------------------------
          # Store symlinks instead of copies: the weights are 3.7 GB together
          # and must not be duplicated in the store.
          fetchModel =
            { pname, revision, dir, file }:
            pkgs.runCommand "${pname}-${builtins.substring 0 7 revision}" {
              src = pkgs.fetchurl {
                name = file.filename;
                inherit (file) url;
                hash = file.sri;
              };
            } ''
              mkdir -p "$out/${dir}"
              ln -s "$src" "$out/${dir}/${file.filename}"
            '';

          modelSpecs = [
            {
              pname = "omnivoice-gguf";
              revision = versions.omnivoice_gguf.revision;
              dir = versions.omnivoice_gguf.dir;
              file = versions.omnivoice_gguf.precision.q8_0;
            }
            {
              pname = "crisperwhisper-gguf";
              revision = versions.asr_gguf.revision;
              dir = versions.asr_gguf.dir;
              file = versions.asr_gguf.q8_0;
            }
            {
              pname = "mms-forced-aligner-gguf";
              revision = versions.aligner_gguf.revision;
              dir = versions.aligner_gguf.dir;
              file = versions.aligner_gguf.f16;
            }
          ];

          models = pkgs.symlinkJoin {
            name = "audiobook-studio-models";
            paths = map fetchModel modelSpecs;
          };
          modelDirs = map (spec: spec.dir) modelSpecs;

          # --- the studio itself ---------------------------------------------
          # importNpmLock derives the offline npm cache from package-lock.json,
          # so no npmDepsHash needs to be maintained by hand.
          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };

          studio = pkgs.buildNpmPackage {
            pname = "audiobook-studio";
            version = pkgJson.version;
            inherit src npmDeps nodejs;

            npmRebuild = false;

            installPhase = ''
              runHook preInstall
              # dist/src (server), dist/web (SPA) + production node_modules only.
              npm prune --omit=dev --offline --no-audit --no-fund
              mkdir -p "$out/share/audiobook-studio"
              cp -a dist package.json versions.json LICENSE "$out/share/audiobook-studio/"
              cp -a node_modules "$out/share/audiobook-studio/node_modules"
              runHook postInstall
            '';

            meta = {
              inherit (pkgJson) description;
              license = lib.licenses.mit;
              platforms = [ "x86_64-linux" ];
              mainProgram = "audiobook-studio";
            };
          };

          # The app resolves data/, runtime/ and versions.json from the project
          # root, which is read-only in the store — so the launcher points
          # AUDIOBOOK_STUDIO_HOME at a writable dir and links the Nix assets in.
          mkStudio =
            { models ? null }:
            let
              modelLinks = lib.optionalString (models != null) (
                lib.concatMapStringsSep "\n"
                  (dir: ''link "${models}/${dir}" "$dataHome/runtime/models/${dir}"'')
                  modelDirs
              );
            in
            pkgs.writeShellApplication {
              name = "audiobook-studio";
              runtimeInputs = [
                pkgs.coreutils
                nodejs
                pkgs.ffmpeg
              ];
              text = ''
                dataHome="''${AUDIOBOOK_STUDIO_HOME:-''${XDG_DATA_HOME:-$HOME/.local/share}/audiobook-studio}"
                mkdir -p "$dataHome/data" "$dataHome/runtime/models"

                # Link read-only store assets into the state dir. Whatever the
                # user already put there (a real dir/file from setup.sh, another
                # checkout) is never overwritten.
                link() {
                  if [ -L "$2" ] || [ ! -e "$2" ]; then
                    ln -sfn "$1" "$2"
                  fi
                }

                link ${studio}/share/audiobook-studio/versions.json "$dataHome/versions.json"
                link ${audio-cpp}/lib/audiobook-studio/runtime/bin "$dataHome/runtime/bin"
                ${modelLinks}

                export AUDIOBOOK_STUDIO_HOME="$dataHome"
                export LD_LIBRARY_PATH="${lib.makeLibraryPath runtimeLibs}:${audio-cpp}/lib/audiobook-studio/runtime/bin''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

                # The SPA is located as "dist/web" relative to the CWD.
                cd ${studio}/share/audiobook-studio
                exec ${nodejs}/bin/node dist/src/index.js "$@"
              '';
              meta = studio.meta;
            };

          packages = {
            default = mkStudio { inherit models; };
            audiobook-studio = mkStudio { inherit models; };
            # Runtime only: bring your own runtime/models (setup.sh, external mode).
            audiobook-studio-lite = mkStudio { };
            inherit models audio-cpp;
          };
        in
        {
          inherit packages;

          apps.default = {
            type = "app";
            program = "${packages.default}/bin/audiobook-studio";
            meta = packages.default.meta;
          };

          checks = {
            typecheck-and-tests = pkgs.buildNpmPackage {
              pname = "audiobook-studio-checks";
              version = pkgJson.version;
              inherit src npmDeps nodejs;

              npmRebuild = false;
              includeDevDeps = true;
              dontNpmBuild = true;
              doCheck = true;
              checkPhase = ''
                runHook preCheck
                npm run typecheck
                npm test
                runHook postCheck
              '';
              installPhase = ''
                mkdir -p "$out"
              '';
            };
          };

          devShells.default = pkgs.mkShell {
            packages = [
              nodejs
              pkgs.ffmpeg
              pkgs.git
              pkgs.curl
              pkgs.python3
              pkgs.cacert
            ];
            shellHook = ''
              export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
              echo "audiobook-studio dev shell — npm install && npm run dev (API :8090, UI :5173)"
            '';
          };

          formatter = pkgs.nixfmt-rfc-style;
        };

      all = eachSystem perSystem;
    in
    {
      packages = builtins.mapAttrs (_: v: v.packages) all;
      apps = builtins.mapAttrs (_: v: v.apps) all;
      checks = builtins.mapAttrs (_: v: v.checks) all;
      devShells = builtins.mapAttrs (_: v: v.devShells) all;
      formatter = builtins.mapAttrs (_: v: v.formatter) all;
    };
}
