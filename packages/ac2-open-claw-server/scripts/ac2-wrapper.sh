#!/bin/sh
# `ac2` on PATH → the @algorandfoundation/ac2-cli bundled inside the installed
# AC2 plugin (self-contained tarball, see the Dockerfile). Using the plugin's
# own copy guarantees the service and the plugin never run different builds.
#
# ~/.openclaw is a named volume seeded from the image on first run, so this
# path is valid both at image build time and at runtime.
AC2_CLI_ENTRY="${AC2_CLI_ENTRY:-$HOME/.openclaw/extensions/ac2/node_modules/@algorandfoundation/ac2-cli/dist/cli.js}"
exec node "$AC2_CLI_ENTRY" "$@"
