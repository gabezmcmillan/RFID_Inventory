#!/bin/sh
# App Service (Linux) startup command. Point the App Service configuration at
# this file, or paste the line below into "Startup Command" directly.
# Oryx installs cloud/requirements.txt during deployment.
exec python -m uvicorn app:app --host 0.0.0.0 --port "${PORT:-8000}"
