import concurrent.futures
import copy
import threading
import time
import unittest

from test_arena import prepared, finish
from arena import ArenaError, ArenaStore
from server import call_tool


class DecisionWaitTests(unittest.TestCase):
    def test_cursor_compact_state_and_private_hands(self):
        store, room, data = prepared()
        first = store.next_decision(data['seatIds'][0], timeout=0)
        self.assertEqual(first['status'], 'ready')
        self.assertNotIn('history', first['state']['game'])
        self.assertNotIn('events', first['state']['game'])
        self.assertNotIn('config', first['state'])
        self.assertEqual(['hand' in p for p in first['state']['game']['players']], [True, False, False, False])
        store.post_chat(room.id, None, {'gameNumber': 1, 'text': 'hello', 'requestId': 'c', 'visitorId': 'v'})
        second = store.next_decision(data['seatIds'][0], first['cursor'], timeout=0)
        self.assertEqual(len(second['state']['chat']['messages']), 1)
        third = store.next_decision(data['seatIds'][0], second['cursor'], timeout=0)
        self.assertEqual(third['state']['chat']['messages'], [])
        self.assertEqual(third['state']['game']['recentActions'], [])

    def test_action_retry_and_minimal_timeout(self):
        store, room, data = prepared()
        first = store.next_decision(data['seatIds'][0], timeout=0)
        d = first['state']['game']['decision']
        action = {'decisionId': d['decisionId'], 'actionId': d['legalActions'][0]['actionId'], 'requestId': 'wait-action'}
        result = store.act_and_wait(data['seatIds'][0], action, first['cursor'], timeout=0)
        self.assertEqual(result['status'], 'timeout')
        self.assertNotIn('state', result)
        self.assertEqual(result['cursor'], first['cursor'])
        commands = len(room.commands)
        retry = store.act_and_wait(data['seatIds'][0], action, first['cursor'], timeout=0)
        self.assertTrue(retry['submission']['duplicate'])
        self.assertEqual(len(room.commands), commands)
        with self.assertRaises(ArenaError):
            store.act_and_wait(data['seatIds'][0], action | {'actionId': 'a2'}, timeout=0)
        # Invalid cursors fail before an action can mutate the room.
        d = room.game.decision(1)
        before = copy.deepcopy(room.record())
        with self.assertRaises(ArenaError):
            store.act_and_wait(data['seatIds'][1], {'decisionId': d['decisionId'], 'actionId': 'a0', 'requestId': 'bad'}, 'wrong:1:0:0', timeout=0)
        self.assertEqual(before, room.record())

    def test_four_waiters_chat_does_not_wake_and_stop_wakes_all(self):
        store = ArenaStore()
        data = store.create({})
        room = store.room(data['roomId'])
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            waiting = [pool.submit(store.next_decision, token, timeout=2) for token in data['seatIds']]
            store.post_chat(room.id, None, {'gameNumber': 0, 'text': 'hello', 'requestId': 'c', 'visitorId': 'v'})
            time.sleep(0.03)
            self.assertTrue(all(not f.done() for f in waiting))
            with store.condition:
                store.commit(room, {'op': 'stop', 'at': time.time()})
            self.assertTrue(all(f.result(timeout=1)['status'] == 'terminal' for f in waiting))

    def test_cancel_and_terminal_and_cursor_game_rotation(self):
        store, room, data = prepared(games=2)
        initial = store.next_decision(data['seatIds'][0], timeout=0)
        finish(store, room, data)
        self.assertEqual(store.next_decision(data['seatIds'][0], initial['cursor'], timeout=0)['status'], 'timeout')
        cancelled = threading.Event()
        with concurrent.futures.ThreadPoolExecutor() as pool:
            waiting = pool.submit(store.next_decision, data['seatIds'][0], cancelled=cancelled)
            cancelled.set()
            with store.condition:store.condition.notify_all()
            self.assertIsNone(waiting.result(timeout=1))
        with store.condition:store.commit(room, {'op': 'start', 'at': time.time(), 'seed': 99})
        second = store.next_decision(data['seatIds'][0], initial['cursor'], timeout=0)
        self.assertEqual(second['status'], 'ready')
        self.assertEqual(second['state']['game']['number'], 2)
        self.assertEqual(second['state']['game']['recentActions'], [])
        finish(store, room, data)
        self.assertEqual(store.next_decision(data['seatIds'][0], second['cursor'], timeout=0)['status'], 'terminal')

    def test_shared_tool_routing_and_validation(self):
        store, room, data = prepared()
        for i in range(4):
            result = call_tool(store, 'next_decision', {'seatId': data['seatIds'][i], 'timeoutMs': 0})
            self.assertEqual(result['state']['participant'], i)
        for args in ({}, {'seatId': data['seatIds'][0], 'timeoutMs': 1800001}, {'seatId': data['seatIds'][0], 'cursor': 'bad'}):
            with self.assertRaises(ArenaError):call_tool(store, 'next_decision', args)
