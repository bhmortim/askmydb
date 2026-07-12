#!/usr/bin/env bash
# askmydb launcher for macOS / Linux — double-click (or run ./start.sh) to start.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  askmydb needs Node.js, which isn't installed yet."
  echo "  1. Get it free at https://nodejs.org (install the LTS version)"
  echo "  2. Then run this again."
  echo
  exit 1
fi

if [ ! -d node_modules ]; then
  echo
  echo "  First-time setup: installing components (one minute)..."
  echo
  npm install || { echo "Setup failed."; exit 1; }
fi

echo
echo "  Starting askmydb. Opening http://localhost:3600 in your browser."
echo "  Leave this window open while you use it. Ctrl+C to quit."
echo
( sleep 3
  if command -v open >/dev/null 2>&1; then open http://localhost:3600
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:3600
  fi ) &
node server.js
