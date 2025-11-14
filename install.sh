#!/bin/bash

set -e

EXTENSION_UUID="maximize-to-workspace@wroyca"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

glib-compile-schemas schemas/

mkdir -p "$INSTALL_DIR"

cp extension.js "$INSTALL_DIR/"
cp prefs.js "$INSTALL_DIR/"
cp metadata.json "$INSTALL_DIR/"
cp stylesheet.css "$INSTALL_DIR/"
cp -r schemas "$INSTALL_DIR/"

gnome-extensions enable "$EXTENSION_UUID"

echo ""
echo "Installation complete!"
echo ""
echo "Please restart GNOME Shell to activate the extension:"
echo "  - On X11: Press Alt+F2, type 'r', and press Enter"
echo "  - On Wayland: Log out and log back in"
echo ""
echo "After restarting, you'll find the 'Maximize to Workspace' toggle"
echo "in the Quick Settings panel (top-right corner of the screen)."
