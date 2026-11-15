#!/usr/bin/env bash
# Standalone runtime installer for Audiobook Studio (Linux x86_64).
# Downloads the pinned, checksummed audio.cpp Vulkan runtime + OmniVoice model
# from versions.json into runtime/ — the studio manages the TTS server itself.
#
#   ./setup.sh               # full install
#   ./setup.sh --skip-model  # runtime only
#   ./setup.sh --force       # re-download
#
# Requires: bash, curl, tar, sha256sum, python3. ~4 GB free disk.

set -euo pipefail
cd "$(dirname "$0")"

SKIP_MODEL=0
FORCE=0
CACHE="runtime/downloads"
STAMP="runtime/.setup-stamp.json"

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-model) SKIP_MODEL=1 ;;
        --force) FORCE=1 ;;
        -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done

for tool in curl tar sha256sum python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "required tool missing: $tool" >&2; exit 1; }
done

mkdir -p "$CACHE" runtime/bin

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

fetch() { # <dest> <url> <sha256> <label>
    local dest="$1"
    if [ "$FORCE" -ne 1 ] && [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$3" ]; then
        echo "[ok] $4 already cached (checksum matches)"
        return 0
    fi
    echo "[..] downloading $4"
    curl -sSL --fail -o "$dest" "$2"
    local actual
    actual="$(sha256_of "$dest")"
    if [ "$actual" != "$3" ]; then
        echo "Checksum mismatch for $4:" >&2
        echo "  expected: $3" >&2
        echo "  actual:   $actual" >&2
        exit 1
    fi
    echo "[ok] $4 downloaded (checksum matches)"
}

read_asset() {
python3 - "$1" <<'PY'
import json, shlex, sys
versions = json.load(open("versions.json"))
spec = eval(sys.argv[1], {"versions": versions})
for key in ("filename", "url", "sha256"):
    print(f"{key.upper()}={shlex.quote(spec[key])}")
PY
}

echo "=== Audiobook Studio - TTS runtime setup ==="

# --- 1. runtime ---
eval "$(read_spec "versions['audio_cpp']['assets']['linux-x64']")"
RUNTIME_OK=0
if [ "$FORCE" -ne 1 ] && [ -f "$STAMP" ]; then
    stamp_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("runtime_sha256",""))' "$STAMP" 2>/dev/null || true)"
    [ "$stamp_sha" = "$SHA256" ] && { echo "[ok] runtime already installed"; RUNTIME_OK=1; }
fi
if [ "$RUNTIME_OK" -ne 1 ]; then
    fetch "$CACHE/$FILENAME" "$URL" "$SHA256" "audio.cpp runtime (linux-x64)"
    echo "[..] extracting runtime -> runtime/bin/"
    tmp="$CACHE/extract-runtime"
    rm -rf "$tmp" && mkdir -p "$tmp"
    tar -xzf "$CACHE/$FILENAME" -C "$tmp"
    if [ -f "$tmp/audiocpp_server" ]; then
        cp -a "$tmp/." runtime/bin/
    else
        inner="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)"
        [ -n "$inner" ] || { echo "unexpected tarball layout" >&2; exit 1; }
        cp -a "$inner/." runtime/bin/
    fi
    rm -rf "$tmp"
    python3 - "$SHA256" >"$STAMP" <<'PY'
import datetime, json, sys
print(json.dumps({
    "runtime_sha256": sys.argv[1],
    "installed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}))
PY
    echo "[ok] runtime installed"
fi

# --- 2. model ---
if [ "$SKIP_MODEL" -ne 1 ]; then
    eval "$(read_spec "versions['omnivoice_gguf']['precision']['q8_0']")"
    MODEL_DIR="runtime/models/$(python3 -c 'import json; print(json.load(open("versions.json"))["omnivoice_gguf"]["dir"])')"
    mkdir -p "$MODEL_DIR"
    MODEL_DEST="$MODEL_DIR/$FILENAME"
    MODEL_OK=0
    if [ "$FORCE" -ne 1 ] && [ -f "$MODEL_DEST" ] && [ "$(sha256_of "$MODEL_DEST")" = "$SHA256" ]; then
        echo "[ok] model already installed (checksum matches)"
        MODEL_OK=1
    fi
    if [ "$MODEL_OK" -ne 1 ]; then
        fetch "$CACHE/$FILENAME" "$URL" "$SHA256" "OmniVoice q8_0 model"
        mv "$CACHE/$FILENAME" "$MODEL_DEST"
        [ "$(sha256_of "$MODEL_DEST")" = "$SHA256" ] || { echo "Model install failed final checksum" >&2; exit 1; }
        echo "[ok] model installed -> $MODEL_DEST"
    fi

    # --- 3. ASR model (auto-transcript for voice preparation) ---
    eval "$(read_spec "versions['asr_gguf']['q8_0']")"
    ASR_DIR="runtime/models/$(python3 -c 'import json; print(json.load(open("versions.json"))["asr_gguf"]["dir"])')"
    mkdir -p "$ASR_DIR"
    ASR_DEST="$ASR_DIR/$FILENAME"
    ASR_OK=0
    if [ "$FORCE" -ne 1 ] && [ -f "$ASR_DEST" ] && [ "$(sha256_of "$ASR_DEST")" = "$SHA256" ]; then
        echo "[ok] ASR model already installed (checksum matches)"
        ASR_OK=1
    fi
    if [ "$ASR_OK" -ne 1 ]; then
        fetch "$CACHE/$FILENAME" "$URL" "$SHA256" "CrisperWhisper ASR model"
        mv "$CACHE/$FILENAME" "$ASR_DEST"
        [ "$(sha256_of "$ASR_DEST")" = "$SHA256" ] || { echo "ASR model install failed final checksum" >&2; exit 1; }
        echo "[ok] ASR model installed -> $ASR_DEST"
    fi

    # --- 4. Forced aligner (word-level transcript verification for cloning) ---
    eval "$(read_spec "versions['aligner_gguf']['f16']")"
    ALIGN_DIR="runtime/models/$(python3 -c 'import json; print(json.load(open("versions.json"))["aligner_gguf"]["dir"])')"
    mkdir -p "$ALIGN_DIR"
    ALIGN_DEST="$ALIGN_DIR/$FILENAME"
    ALIGN_OK=0
    if [ "$FORCE" -ne 1 ] && [ -f "$ALIGN_DEST" ] && [ "$(sha256_of "$ALIGN_DEST")" = "$SHA256" ]; then
        echo "[ok] forced aligner already installed (checksum matches)"
        ALIGN_OK=1
    fi
    if [ "$ALIGN_OK" -ne 1 ]; then
        fetch "$CACHE/$FILENAME" "$URL" "$SHA256" "MMS forced aligner model"
        mv "$CACHE/$FILENAME" "$ALIGN_DEST"
        [ "$(sha256_of "$ALIGN_DEST")" = "$SHA256" ] || { echo "Forced aligner install failed final checksum" >&2; exit 1; }
        echo "[ok] forced aligner installed -> $ALIGN_DEST"
    fi
fi

echo "=== done — the studio will start this runtime automatically ==="
