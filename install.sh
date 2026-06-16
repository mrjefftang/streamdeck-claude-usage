#!/usr/bin/env bash
# Installs the Claude Usage plugin into the local Stream Deck plugins folder and
# restarts the Stream Deck app so it picks up the change.
set -euo pipefail

PLUGIN="com.mrjefftang.claude-usage.sdPlugin"
SRC="$(cd "$(dirname "$0")" && pwd)/${PLUGIN}"

case "$(uname -s)" in
	Darwin) DEST="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins" ;;
	*) DEST="$APPDATA/Elgato/StreamDeck/Plugins" ;;
esac

if [ ! -d "$SRC/node_modules/ws" ]; then
	echo "Installing runtime dependency (ws)…"
	( cd "$SRC" && npm install --no-audit --no-fund )
fi

echo "Generating icons…"
node "$(dirname "$0")/tools/gen-icons.mjs"

echo "Installing to: $DEST/$PLUGIN"
mkdir -p "$DEST"
rm -rf "$DEST/$PLUGIN"
cp -R "$SRC" "$DEST/$PLUGIN"

if [ "$(uname -s)" = "Darwin" ]; then
	echo "Restarting Stream Deck…"
	osascript -e 'quit app "Elgato Stream Deck"' 2>/dev/null || true
	sleep 1
	open -a "Elgato Stream Deck" 2>/dev/null || true
fi

echo "Done. Add the 'Claude Usage → Usage Limit' action to a key and sign in."
