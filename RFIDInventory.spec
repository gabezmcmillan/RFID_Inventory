# -*- mode: python ; coding: utf-8 -*-
# PyInstaller build spec for the RFID Inventory app.
#
# Build (on the target OS -- PyInstaller does not cross-compile):
#   python -m PyInstaller RFIDInventory.spec --noconfirm
# or just run build-windows.bat on Windows.
#
# Output: dist/RFIDInventory/ -- a self-contained folder whose
# RFIDInventory.exe starts the server and opens the browser UI.

# uvicorn picks its event-loop / HTTP / websocket implementations via dynamic
# imports that static analysis can't see, and FastAPI imports the form-parsing
# module (python-multipart) lazily. "Hidden import not found" warnings for a
# few of these during the build are harmless: which ones exist depends on the
# installed uvicorn extras and python-multipart version.
HIDDEN = [
    "multipart",
    "python_multipart",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
]

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=[],
    # The browser UI is bundled read-only and served from sys._MEIPASS
    # (config.STATIC_DIR). Persistent data (inventory.db, scans/, settings.ini)
    # is NOT bundled; it lives next to the exe.
    datas=[("static", "static")],
    hiddenimports=HIDDEN,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name="RFIDInventory",
    # Keep the console window: it shows the server log, and closing it is how
    # the operator stops the app.
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="RFIDInventory",
)
