# Shared code that crosses the exe<->cloud seam. HARD RULE: stdlib only --
# importing anything under `contract` must never drag app-side dependencies
# (psycopg, fastapi, pyserial) into the other app's build.
