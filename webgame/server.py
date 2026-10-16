#!/usr/bin/env python3
"""Multi-room HTTP + stateless Streamable HTTP MCP. No model keys or agent loop."""
import json
import logging
import mimetypes
import os
from pathlib import Path
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from arena import ArenaStore, ArenaError, RULES, require, integer
# Compatibility for offline research scripts, never exposed as HTTP actions.
from game_core import GameSession, STRATEGIES, compute_daily_par

HERE = Path(sys._MEIPASS) / 'webgame' if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent
ASSETS = {'/': 'index.html', '/webgame/index.html': 'index.html',
          '/webgame/arena.js': 'arena.js', '/webgame/arena.css': 'arena.css'}
PROTOCOLS = ('2025-11-25', '2025-06-18', '2025-03-26')


def schema(properties=None, required=None):
    return {'type': 'object', 'properties': properties or {}, 'required': required or [], 'additionalProperties': False}


STRING = {'type': 'string', 'minLength': 1, 'maxLength': 128}
TOOLS = [
    {'name': 'list_tables', 'description': 'List public rooms; never lists seat IDs.', 'inputSchema': schema()},
    {'name': 'join_seat', 'description': 'Join your seat using its unique seat ID as Authorization Bearer. Cannot select another seat.',
     'inputSchema': schema({'name': {'type': 'string', 'minLength': 1, 'maxLength': 80}}, ['name'])},
    {'name': 'get_rules', 'description': 'Actual rules, scoring and visibility.', 'inputSchema': schema()},
    {'name': 'get_observation', 'description': 'Your private hand, public table and exhaustive legalActions. No hidden opponent hands or live seed.', 'inputSchema': schema()},
    {'name': 'wait_for_decision', 'description': 'Wait for your decision or game end. Inspect state even on timeout. Max 25 seconds.',
     'inputSchema': schema({'timeoutMs': {'type': 'integer', 'minimum': 0, 'maximum': 25000}})},
    {'name': 'submit_action', 'description': 'Submit a legal actionId for decisionId. Reuse requestId only to retry the identical action.',
     'inputSchema': schema({'decisionId': STRING, 'actionId': STRING, 'requestId': STRING}, ['decisionId', 'actionId', 'requestId'])},
]


def validate_arguments(tool, args):
    require(isinstance(args, dict), 'invalid_arguments', 'arguments must be an object')
    spec = tool['inputSchema']
    require(not (set(args) - set(spec['properties'])), 'invalid_arguments', 'Unknown argument')
    require(all(k in args for k in spec['required']), 'invalid_arguments', 'Required argument missing')
    for k, v in args.items():
        s = spec['properties'][k]
        if s['type'] == 'integer':
            integer(v, k, s.get('minimum', 0), s.get('maximum', 25000))
        else:
            require(isinstance(v, str) and s.get('minLength', 0) <= len(v) <= s.get('maxLength', 128),
                    'invalid_arguments', f'Invalid {k}')


def call_tool(store, token, name, args):
    tool = next((t for t in TOOLS if t['name'] == name), None)
    require(tool is not None, 'unknown_tool', 'Unknown MCP tool')
    validate_arguments(tool, args)
    if name == 'get_rules':
        return RULES
    if name == 'list_tables':
        with store.condition:
            return {'rooms': [r.summary() for r in store.rooms.values()]}
    if name == 'submit_action':
        return store.submit(token, args)
    if name == 'wait_for_decision':
        return store.wait(token, timeout=args.get('timeoutMs', 25000)/1000, decision_only=True)
    with store.condition:
        room, _ = store.seat_room(token)
        if name == 'join_seat':
            store.join(token, args['name'], 'ai')
        store.expire_room(room, time.time())
        return room.view(token)


class ArenaHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def __init__(self, address, store):
        self.store = store
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = 'MahjongArena/1'

    def log_message(self, fmt, *args):
        pass  # Never log seat credentials or bodies.

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    @property
    def store(self):
        return self.server.store

    def send(self, status, body=None, ctype='application/json; charset=utf-8'):
        data = body if isinstance(body, bytes) else (json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else b'')
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        if data:
            self.wfile.write(data)

    def token(self):
        auth = self.headers.get('Authorization', '')
        return auth[7:] if auth.startswith('Bearer ') else None

    def body(self):
        require(self.headers.get('Content-Type', '').split(';')[0] == 'application/json',
                'invalid_arguments', 'Content-Type must be application/json', 415)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            require(0 < size <= 65536, 'invalid_arguments', 'Body must be 1..65536 bytes', 413)
            body = json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError):
            raise ArenaError('invalid_json', 'Invalid JSON')
        require(isinstance(body, dict), 'invalid_arguments', 'JSON object required')
        return body

    def check_origin(self):
        origin = self.headers.get('Origin')
        if origin:
            parsed = urlsplit(origin)
            allowed = set(filter(None, os.environ.get('ALLOWED_ORIGINS', '').split(',')))
            require(origin in allowed or (parsed.scheme in ('http', 'https') and parsed.netloc == self.headers.get('Host', '') and parsed.path in ('', '/')),
                    'forbidden_origin', 'Origin is not allowed', 403)

    def do_GET(self):
        self.handle_request('GET')

    def do_POST(self):
        self.handle_request('POST')

    def do_DELETE(self):
        self.handle_request('DELETE')

    def handle_request(self, method):
        try:
            self.check_origin()
            url = urlsplit(self.path)
            path, q = url.path, parse_qs(url.query)
            payload = self.body() if method == 'POST' else None
            if path == '/mcp':
                require(method == 'POST', 'method_not_allowed', 'Stateless MCP uses POST', 405)
                protocol = self.headers.get('MCP-Protocol-Version')
                require(protocol is None or protocol in PROTOCOLS, 'unsupported_protocol', 'Unsupported MCP protocol')
                self.mcp(payload)
                return
            if method == 'GET' and path in ASSETS:
                asset = HERE / ASSETS[path]
                self.send(200, asset.read_bytes(), (mimetypes.guess_type(asset.name)[0] or 'application/octet-stream') + '; charset=utf-8')
                return
            if method == 'GET' and path == '/healthz':
                self.send(200, {'ok': True, 'rooms': len(self.store.rooms)})
                return
            if method == 'GET' and path == '/api/rules':
                self.send(200, RULES)
                return
            if path == '/api/rooms':
                if method == 'GET':
                    with self.store.condition:
                        result = {'rooms': [r.summary() for r in self.store.rooms.values()]}
                else:
                    require(method == 'POST', 'method_not_allowed', 'Use GET or POST', 405)
                    result = self.store.create(payload)
                self.send(200, result)
                return
            parts = path.strip('/').split('/')
            require(len(parts) in (3, 4) and parts[:2] == ['api', 'rooms'], 'not_found', 'Not found', 404)
            room_id = parts[2]
            op = parts[3] if len(parts) == 4 else 'state'
            token = self.token()
            if op in ('action', 'wait'):
                with self.store.condition:
                    room, _ = self.store.seat_room(token)
                    require(room.id == room_id, 'unauthorized', 'Credential belongs to a different room', 403)
                if op == 'action' and method == 'POST':
                    result = self.store.submit(token, payload)
                elif op == 'wait' and method == 'GET':
                    try:
                        after = int(q.get('afterRevision', ['-1'])[0])
                    except ValueError:
                        raise ArenaError('invalid_arguments', 'Invalid afterRevision')
                    result = self.store.wait(token, after)
                else:
                    raise ArenaError('method_not_allowed', 'Invalid method', 405)
                self.send(200, result)
                return
            with self.store.condition:
                room = self.store.room(room_id)
                role, _ = room.identity(token)
                require(token is None or role != 'public', 'unauthorized', 'Invalid room credential', 401)
                if op == 'state' and method == 'GET':
                    self.store.expire_room(room, time.time())
                    result = room.view(token)
                elif op == 'join' and method == 'POST':
                    result = self.store.join(token, payload.get('name'), payload.get('kind', 'human'))
                elif op in ('start', 'stop') and method == 'POST':
                    require(role == 'owner', 'unauthorized', 'Room owner credential required', 403)
                    self.store.commit(room, {'op': op, 'at': time.time(), 'seed': secrets.randbits(64)})
                    result = room.view(token)
                elif op == 'credentials' and method == 'GET':
                    require(role == 'owner', 'unauthorized', 'Room owner credential required', 403)
                    result = {'seatIds': [s['seatId'] for s in room.seats]}
                elif op == 'replay' and method == 'GET':
                    try:
                        number = int(q.get('game', [str(len(room.games))])[0])
                    except ValueError:
                        raise ArenaError('invalid_arguments', 'Invalid game number')
                    result = self.store.replay(room, number)
                else:
                    raise ArenaError('not_found', 'Not found', 404)
            self.send(200, result)
        except ArenaError as e:
            self.send(e.status, {'ok': False, 'error': {'code': e.code, 'message': str(e)}})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            logging.exception('Arena request failed')
            self.send(500, {'ok': False, 'error': {'code': 'internal_error', 'message': 'Internal server error'}})

    def mcp(self, message):
        request_id, method = message.get('id'), message.get('method')
        if message.get('jsonrpc') != '2.0' or not isinstance(method, str):
            self.send(200, {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32600, 'message': 'Invalid Request'}})
            return
        if 'id' not in message:
            self.send(202)
            return
        params = message.get('params', {})
        if not isinstance(params, dict):
            self.send(200, {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32602, 'message': 'Invalid params'}})
            return
        if method == 'initialize':
            requested = params.get('protocolVersion')
            result = {'protocolVersion': requested if requested in PROTOCOLS else PROTOCOLS[0],
                      'capabilities': {'tools': {}}, 'serverInfo': {'name': 'mahjong-arena', 'version': '1.0.0'},
                      'instructions': 'Use your seat ID as Bearer credential. join_seat, get_rules, wait_for_decision; submit legalActions with unique requestId. Stop at terminal room status.'}
        elif method == 'ping':
            result = {}
        elif method == 'tools/list':
            result = {'tools': TOOLS}
        elif method == 'tools/call':
            try:
                data = call_tool(self.store, self.token(), params.get('name'), params.get('arguments', {}))
                result = {'content': [{'type': 'text', 'text': json.dumps(data, ensure_ascii=False)}], 'structuredContent': data}
            except ArenaError as e:
                data = {'ok': False, 'error': {'code': e.code, 'message': str(e)}}
                result = {'isError': True, 'content': [{'type': 'text', 'text': json.dumps(data)}], 'structuredContent': data}
        else:
            self.send(200, {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32601, 'message': 'Method not found'}})
            return
        self.send(200, {'jsonrpc': '2.0', 'id': request_id, 'result': result})


def start_timer(store):
    stop = threading.Event()
    def timer():
        while not stop.wait(0.5):
            try:
                store.tick()
            except Exception:
                logging.exception('Arena timer failed')

    threading.Thread(target=timer, daemon=True).start()
    return stop


def main():
    os.umask(0o077)
    store = ArenaStore(os.environ.get('ARENA_DATA_DIR', str(HERE.parent / 'arena-data')))
    host = os.environ.get('HOST', '127.0.0.1')
    port = int(sys.argv[1] if len(sys.argv) > 1 else os.environ.get('PORT', '8765'))
    server = ArenaHTTPServer((host, port), store)
    stop = start_timer(store)
    print(f'Mahjong Arena http://{host}:{server.server_port}/  MCP /mcp', flush=True)
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()


if __name__ == '__main__':
    main()
