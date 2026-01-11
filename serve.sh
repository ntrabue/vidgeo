#!/bin/bash
# Simple server for Vidgeo
# Requires Python 3

PORT=${1:-8080}
echo "Starting Vidgeo at http://localhost:$PORT"
echo "Press Ctrl+C to stop"
python3 -m http.server $PORT
