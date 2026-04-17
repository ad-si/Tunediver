#!/bin/sh
# Wrapper for launchd / systemd / manual use.
# Waits for MUSIC_DIR to be populated (handles Dropbox-style sync delays),
# then execs the release binary.
#
# Environment:
#   MUSIC_DIR        Directory to scan (required)
#   ROCKET_ADDRESS   Bind address (default: 127.0.0.1)
#   ROCKET_PORT      Bind port (default: 7313)
#   WAIT_SECONDS     Max seconds to wait for MUSIC_DIR (default: 300)

set -eu

: "${MUSIC_DIR:?MUSIC_DIR must be set (path to your music directory)}"
: "${ROCKET_ADDRESS:=127.0.0.1}"
: "${ROCKET_PORT:=7313}"
: "${WAIT_SECONDS:=300}"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BINARY="$SCRIPT_DIR/../target/release/tunediver-api"

elapsed=0
while [ "$elapsed" -lt "$WAIT_SECONDS" ]; do
  if [ -d "$MUSIC_DIR" ] && [ -n "$(ls -A "$MUSIC_DIR" 2>/dev/null)" ]; then
    break
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done

export ROCKET_MUSIC_PATH="$MUSIC_DIR"
export ROCKET_ADDRESS
export ROCKET_PORT
exec "$BINARY"
