# Makes cloud/ importable from the repo root so the .exe side can do
# `from cloud import sync_contract` (PyInstaller follows that import and
# bundles it). On Vercel, cloud/ is the deployment root and this file is
# inert. Keep it empty: importing the package must never pull in cloud-only
# dependencies like psycopg.
