import concurrent.futures
import copy
import json
from pathlib import Path
import random
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'webgame'))
from arena import ArenaStore, ArenaGame, ArenaError, Room
from game_core import GameSession
from server import ArenaHTTPServer


def prepared(store=None, seed=42, policy='forfeit', games=1):
    store = store or ArenaStore()
    data = store.create({'games': games, 'timeoutPolicy': policy})
    with store.condition:
        room = store.room(data['roomId'])
        for i, token in enumerate(data['seatIds']):
            room.join(token, f'AI {i}', 'ai')
        store.commit(room, {'op': 'start', 'at': time.time(), 'seed': seed})
    return store, room, data


def finish(store, room, data):
    count = 0
    while room.status == 'playing':
        game = room.game
        pending = [s for s in game.pending if s not in game.responses]
        for seat in pending:
            d = game.decision(seat)
            actions = d['legalActions']
            a = next((a for a in actions if a['type'] in ('hu', 'zimo', 'robkong')), None)
            a = a or next((a for a in actions if a['type'] == 'pass'), actions[-1])
            p = game.participant(seat)
            store.submit(data['seatIds'][p], {'decisionId': d['decisionId'], 'actionId': a['actionId'], 'requestId': d['decisionId']})
            count += 1
        if count > 1500:
            raise AssertionError('Game did not terminate')
    return count


class ArenaTests(unittest.TestCase):
    def test_secrets_and_room_isolation(self):
        store, room, data = prepared()
        _, other, other_data = prepared(store, seed=43)
        ids = data['seatIds'] + other_data['seatIds']
        self.assertEqual(len(set(ids)), 8)
        public = room.view()
        self.assertNotIn('seed', public['game'])
        self.assertTrue(all('hand' not in p for p in public['game']['players']))
        encoded = json.dumps(public)
        for secret in ids + [data['ownerToken']]:
            self.assertNotIn(secret, encoded)
        for i, token in enumerate(data['seatIds']):
            view = room.view(token)['game']
            self.assertEqual(view['yourSeat'], i)
            self.assertEqual(['hand' in p for p in view['players']], [s == i for s in range(4)])
            self.assertIsNone(other.view(token)['participant'])
        with self.assertRaises(ArenaError):
            store.submit('bad', {})

    def test_daque_is_sealed_and_idempotent(self):
        store, room, data = prepared()
        d = room.game.decision(0)
        payload = {'decisionId': d['decisionId'], 'actionId': 'a1', 'requestId': 'retry'}
        first = store.submit(data['seatIds'][0], payload)
        self.assertFalse(first['duplicate'])
        self.assertIsNone(room.game.decision(0))
        self.assertTrue(all(p['daque'] is None for p in room.view()['game']['players']))
        self.assertTrue(store.submit(data['seatIds'][0], payload)['duplicate'])
        with self.assertRaises(ArenaError) as ctx:
            store.submit(data['seatIds'][0], payload | {'actionId': 'a0'})
        self.assertEqual(ctx.exception.code, 'request_conflict')
        with self.assertRaises(ArenaError):
            store.submit(data['seatIds'][1], payload | {'requestId': 'other'})
        for s in (1, 2, 3):
            d = room.game.decision(s)
            store.submit(data['seatIds'][s], {'decisionId': d['decisionId'], 'actionId': 'a2', 'requestId': f'daque{s}'})
        self.assertEqual([p.daque_color for p in room.game.players], [1, 2, 2, 2])
        self.assertEqual(room.game.phase, 'discard')

    def test_multi_hu_arrival_order_and_secrecy(self):
        def make():
            game = ArenaGame(42, 1, time.time(), 120)
            # Two legal hands waiting for the same discard. Real judger/engine/settlement.
            hand = [[0,1]]*3 + [[0,2]]*3 + [[0,3]]*3 + [[0,4]]*3 + [[0,5]]
            for s, p in enumerate(game.players):
                p.daque_color = 2
                if s in (1,2):
                    p.hand = copy.deepcopy(hand)
            game.players[0].hand = [[1,1]]*13 + [[0,5]]
            game.players[3].hand = [[2,1]]*13
            game.dealer.numWl = 30
            game.stage = 'play'
            game.round.valid_act = 'discard'
            game.round.proceed_round(game.players, [0,5])
            game.advance(time.time())
            self.assertEqual(set(game.pending), {1,2})
            return game
        a, b = make(), make()
        original = a.view()
        def submit(game, s):
            d=game.decision(s)
            o=next(o for o in d['legalActions'] if o['type']=='hu')
            game.apply(s,d['decisionId'],o['actionId'],time.time())
        submit(a,2)
        self.assertEqual(a.view(), original)
        self.assertIsNotNone(a.decision(1))
        submit(a,1)
        submit(b,1)
        submit(b,2)
        self.assertEqual([p.player_id for p in a.round.winners], [1,2])
        self.assertEqual([p.myscore for p in a.players], [p.myscore for p in b.players])
        self.assertEqual(a.dealer.act_history,b.dealer.act_history)

    def test_determinism_no_global_rng(self):
        random.seed(99)
        before=random.getstate()
        a=ArenaGame(10,1,0,120)
        ArenaGame(11,1,0,120)
        b=ArenaGame(10,1,0,120)
        self.assertEqual(a.initial,b.initial)
        self.assertEqual(random.getstate(),before)

    def test_original_strategy_engine_parity(self):
        # A real baseline chooses actions only in this test; the arena itself
        # never invokes a strategy. Compare full traces, wall, hands and ledgers.
        for seed in (3, 17, 24):
            old=GameSession(seed=seed,human=None)
            game=ArenaGame(seed,1,time.time(),120)
            for s in range(4):
                d=game.decision(s)
                game.apply(s,d['decisionId'],f'a{old.players[s].daque_color}',time.time())
            guard=0
            while game.stage!='over':
                while old.round.valid_act=='self_check':old.step_once()
                self.assertEqual(old.round.valid_act,game.phase)
                choices={s:old._auto_action(game.phase,s) for s in game.pending}
                pending=copy.deepcopy(game.pending)
                for s in reversed(list(pending)):
                    o=next(o for o in pending[s]['options'] if o['_engine']==choices[s])
                    game.apply(s,pending[s]['decisionId'],o['actionId'],time.time())
                for _ in choices:
                    old.round.proceed_round(old.players,choices[old.round.current_player])
                if old.round.is_over:old._finalize()
                self.assertEqual(game.dealer.act_history,old.dealer.act_history)
                self.assertEqual(game.dealer.deck,old.dealer.deck)
                self.assertEqual([p.hand for p in game.players],[p.hand for p in old.players])
                self.assertEqual([p.myscore for p in game.players],[p.myscore for p in old.players])
                guard+=1
                self.assertLess(guard,1000)

    def test_full_games_rotation_and_replay(self):
        for seed in range(12):
            store,room,data=prepared(seed=seed,games=2)
            self.assertGreater(finish(store,room,data),20)
            self.assertEqual(room.status,'between_games')
            self.assertEqual(sum(p.myscore for p in room.game.players),0)
            replay=store.replay(room,1)
            self.assertEqual(replay['frames'][-1]['stage'],'over')
            self.assertEqual(replay['frames'][-1]['players'],room.game.view(reveal=True)['players'])
            with store.condition:
                store.commit(room,{'op':'start','at':time.time(),'seed':seed+100})
            self.assertEqual(room.game.seat_for(0),3)
            self.assertEqual(room.game.seed,seed+100)
            self.assertEqual(room.view(data['seatIds'][0])['game']['yourSeat'],3)
            finish(store,room,data)
            self.assertEqual(room.status,'complete')
            self.assertEqual(sum(p['score'] for p in room.view()['seats']),0)

    def test_persistence_mid_window_and_duplicate(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as directory:
            store,room,data=prepared(ArenaStore(directory))
            d=room.game.decision(2)
            payload={'decisionId':d['decisionId'],'actionId':'a1','requestId':'persist'}
            store.submit(data['seatIds'][2],payload)
            restored=ArenaStore(directory)
            other=restored.room(room.id)
            self.assertEqual(room.game.view(),other.game.view())
            self.assertEqual(room.game.responses,other.game.responses)
            self.assertTrue(restored.submit(data['seatIds'][2],payload)['duplicate'])
            finish(restored,other,data)
            final=ArenaStore(directory).room(room.id)
            self.assertEqual(final.game.view(),other.game.view())

    def test_timeout_forfeit_and_legal(self):
        store,room,data=prepared(policy='forfeit')
        with store.condition:
            store.expire_room(room,time.time()+121)
        self.assertEqual(room.status,'forfeit')
        self.assertEqual(room.view()['seats'][0]['games'],0)
        store,room,data=prepared(policy='legal')
        with store.condition:
            store.expire_room(room,time.time()+121)
        self.assertTrue(room.game.assisted)
        self.assertEqual(room.game.stage,'play')

    def test_concurrent_retry_and_wait(self):
        store,room,data=prepared()
        d=room.game.decision(0)
        payload={'decisionId':d['decisionId'],'actionId':'a0','requestId':'parallel'}
        with concurrent.futures.ThreadPoolExecutor() as pool:
            results=list(pool.map(lambda _:store.submit(data['seatIds'][0],payload),range(8)))
        self.assertEqual(sum(not r['duplicate'] for r in results),1)
        result=store.wait(data['seatIds'][0],timeout=0,decision_only=True)
        self.assertEqual(result['status'],'timeout')

    def test_invalid_engine_and_storage_rollback(self):
        store,room,data=prepared()
        d=room.game.decision(0)
        payload={'decisionId':d['decisionId'],'actionId':'a0','requestId':'failure'}
        before=copy.deepcopy(room.game.view())
        with patch.object(store,'save',side_effect=OSError('disk full')):
            with self.assertRaises(OSError):store.submit(data['seatIds'][0],payload)
        self.assertEqual(room.game.view(),before)
        self.assertNotIn((0,'failure'),room.requests)
        with patch.object(ArenaGame,'apply',side_effect=RuntimeError('engine broke')):
            with self.assertRaises(ArenaError) as ctx:store.submit(data['seatIds'][0],payload)
        self.assertEqual(ctx.exception.code,'engine_error')
        self.assertEqual(room.status,'invalid')
        self.assertEqual(room.game.view(),before)
        self.assertEqual(Room.restore(room.record()).status,'invalid')

    def test_stop_is_terminal(self):
        store,room,data=prepared(games=2)
        finish(store,room,data)
        with store.condition:
            store.commit(room,{'op':'stop','at':time.time()})
            with self.assertRaises(ArenaError):
                store.commit(room,{'op':'start','at':time.time(),'seed':10})
        self.assertEqual(room.status,'stopped')


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store=ArenaStore()
        cls.server=ArenaHTTPServer(('127.0.0.1',0),cls.store)
        cls.base=f'http://127.0.0.1:{cls.server.server_port}'
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self,path,body=None,token=None,headers=None):
        h=headers or {}
        if body is not None:h['Content-Type']='application/json'
        if token:h['Authorization']='Bearer '+token
        req=Request(self.base+path,data=json.dumps(body).encode() if body is not None else None,headers=h)
        with urlopen(req,timeout=5) as response:
            raw=response.read()
            return response.status,json.loads(raw) if raw else None

    def mcp(self,name,args=None,token=None):
        return self.request('/mcp',{'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':args or {}}},token)[1]['result']

    def test_mcp_and_browser_share_room(self):
        _,data=self.request('/api/rooms',{'games':1})
        rid=data['roomId'];tokens=data['seatIds']
        init=self.request('/mcp',{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'test','version':'1'}}})[1]
        self.assertEqual(init['result']['protocolVersion'],'2025-06-18')
        for i,token in enumerate(tokens):
            result=self.mcp('join_seat',{'name':f'Bot{i}'},token)
            self.assertEqual(result['structuredContent']['participant'],i)
        self.request(f'/api/rooms/{rid}/start',{},data['ownerToken'])
        obs=self.mcp('get_observation',token=tokens[0])['structuredContent']
        self.assertEqual(obs['game']['decision']['phase'],'daque')
        d=obs['game']['decision']
        self.assertFalse(self.mcp('submit_action',{'decisionId':d['decisionId'],'actionId':'a0','requestId':'http'},tokens[0]).get('isError',False))
        self.assertTrue(self.mcp('get_observation',token='bad')['isError'])
        self.assertTrue(self.mcp('submit_action',{'decisionId':'x','actionId':'x','requestId':True},tokens[0])['isError'])
        self.assertTrue(self.mcp('get_observation',{'seat':1},tokens[0])['isError'])
        with self.assertRaises(HTTPError) as error:
            self.request(f'/api/rooms/{rid}/credentials',token=tokens[0])
        self.assertEqual(error.exception.code,403)

    def test_assets_and_origin(self):
        for path in ('/arena-data/a.json','/.git/config','/webgame/game_core.py','/webgame/app.html','/api/state'):
            with self.assertRaises(HTTPError) as e:self.request(path)
            self.assertEqual(e.exception.code,404)
        with self.assertRaises(HTTPError) as e:
            self.request('/api/rooms',headers={'Origin':'https://evil.test'})
        self.assertEqual(e.exception.code,403)
        self.assertEqual(self.request('/healthz')[0],200)


if __name__=='__main__':
    unittest.main()
