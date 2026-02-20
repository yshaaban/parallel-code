#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

cd "$SCRIPT_DIR"

case "$OS" in
    Darwin)
        echo "Building release for macOS..."
        npm run build

        DMG_FILE=$(find "$SCRIPT_DIR/release" -name '*.dmg' -type f | head -1)

        if [ -z "$DMG_FILE" ]; then
            echo "Error: no .dmg found in release/"
            exit 1
        fi

        echo "Mounting $DMG_FILE..."
        MOUNT_DIR=$(hdiutil attach "$DMG_FILE" -nobrowse | tail -1 | sed 's/.*[[:space:]]\/Volumes/\/Volumes/')
        APP_FILE=$(find "$MOUNT_DIR" -name '*.app' -maxdepth 1 | head -1)

        if [ -z "$APP_FILE" ]; then
            echo "Error: no .app found in mounted DMG"
            hdiutil detach "$MOUNT_DIR"
            exit 1
        fi

        echo "Installing to /Applications..."
        cp -R "$APP_FILE" /Applications/
        hdiutil detach "$MOUNT_DIR"

        echo "Installed successfully to /Applications/"
        ;;

    Linux)
        echo "Building release for Linux..."
        npm run build

        APPIMAGE_FILE=$(find "$SCRIPT_DIR/release" -name '*.AppImage' -type f | head -1)

        if [ -z "$APPIMAGE_FILE" ]; then
            echo "Error: no .AppImage found in release/"
            exit 1
        fi

        echo "Installing $APPIMAGE_FILE..."
        INSTALL_DIR="${HOME}/.local/bin"
        mkdir -p "$INSTALL_DIR"
        cp "$APPIMAGE_FILE" "$INSTALL_DIR/parallel-code"
        chmod +x "$INSTALL_DIR/parallel-code"

        echo "Installed to $INSTALL_DIR/parallel-code"
        ;;

    *)
        echo "Error: unsupported OS '$OS'"
        exit 1
        ;;
esac
