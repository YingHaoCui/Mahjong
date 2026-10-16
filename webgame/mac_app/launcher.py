#!/usr/bin/env python3
'''Native Mac app entry point: runs webgame/server.py's HTTP server on a
   background thread bound to an OS-assigned localhost port, then opens it
   in a pywebview window (WKWebView on macOS — no browser chrome, full
   native speed since this is the same real-Python engine server.py uses
   for local dev, not the WASM/Pyodide build in webgame/app.html).

   Run for local testing:  python3 webgame/mac_app/launcher.py
   Build the .app:          see webgame/mac_app/README.md
'''
import os
import sys
import threading

_HERE = os.path.dirname(os.path.abspath(__file__))
_WEBGAME = os.path.dirname(_HERE)
if not getattr(sys, 'frozen', False):
    sys.path.insert(0, _WEBGAME)

import webview
from pathlib import Path
from server import ArenaHTTPServer, start_timer
from arena import ArenaStore


def main():
    os.umask(0o077)
    data_dir = os.environ.get('ARENA_DATA_DIR', str(Path.home() / 'Library' / 'Application Support' / 'MahjongArena'))
    store = ArenaStore(data_dir)
    httpd = ArenaHTTPServer(('127.0.0.1', 0), store)
    timer_stop = start_timer(store)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    webview.create_window('血战到底 XueZhan Mahjong',
                          f'http://127.0.0.1:{port}/webgame/index.html',
                          width=1280, height=860, min_size=(900, 650))
    webview.start()
    httpd.shutdown()
    timer_stop.set()
    httpd.server_close()


if __name__ == '__main__':
    main()
