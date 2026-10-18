#!/bin/sh
# Rebuild only the patched native payloads from the verified official source.
set -eu
PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE_ARCHIVE=${1:?Pass the official v0.2.7 source archive (see VENDOR-REVIEW.md)}
EXPECTED_SHA=c7a3003515af13c752af5cdbb8846cbf6dc0b819c3645f6b98e17951a4927771
ACTUAL_SHA=$(shasum -a 256 "$SOURCE_ARCHIVE" | cut -d ' ' -f 1)
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || { echo 'Source archive hash mismatch' >&2; exit 1; }
BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/baguette-native.XXXXXX")
trap 'rm -rf "$BUILD_DIR"' EXIT
/usr/bin/tar -xzf "$SOURCE_ARCHIVE" -C "$BUILD_DIR" --strip-components=1
cd "$BUILD_DIR"
/usr/bin/patch -p1 < "$PLUGIN_DIR/vendor-native.patch"
BAGUETTE_INJECTED_ARCHS=arm64 /bin/bash Injected/HingeControl/build.sh
# Whole-program LTO keeps the host binary within the repository binary budget.
swift build -c release -j 6 --force-resolved-versions --experimental-lto-mode=full -Xswiftc -Osize
/usr/bin/strip .build/release/Baguette
/usr/bin/codesign --force --sign - --timestamp=none .build/release/Baguette
DEST="$PLUGIN_DIR/vendor/baguette"
cp .build/release/Baguette "$DEST/Baguette"
cp Injected/HingeControl/HingeControl "$DEST/Baguette_Baguette.bundle/HingeControl/HingeControl"
cp Injected/HingeControl/Sources/LICENSE.idb "$DEST/Baguette_Baguette.bundle/HingeControl/LICENSE.idb"
echo 'Rebuilt Baguette and HingeControl; regenerate vendor-inventory.json before packaging.'
