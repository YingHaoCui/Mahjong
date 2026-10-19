"""Rule-level regressions: failures found by the 2026-10 game-flow audit."""
import copy
from collections import Counter
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'webgame'))
from arena import ArenaGame, ArenaStore, ArenaError, Room
from game_core import Dealer, Player, Judger
from utils import xzscore
from utils.xzutils import init_deck


def inventory(game):
    tiles = list(game.dealer.deck)
    for p in game.players:
        tiles += p.hand
        for meld in p.pile: tiles += meld
    return Counter(map(tuple, tiles))


class RuleTests(unittest.TestCase):
    def test_exchange_atomic_conserves_tiles_and_keeps_choices_private(self):
        g = ArenaGame(42, 1, 0, 120)
        before = copy.deepcopy([p.hand for p in g.players])
        wall = copy.deepcopy(g.dealer.deck)
        counts = inventory(g)
        choices = {}
        for s in range(4):
            d = g.decision(s)
            self.assertEqual(d['phase'], 'exchange')
            for a in d['legalActions']:
                self.assertEqual(len(a['tiles']), 3)
                self.assertEqual(len({t[0] for t in a['tiles']}), 1)
                self.assertFalse(Counter(map(tuple, a['tiles'])) - Counter(map(tuple, before[s])))
            choices[s] = d['legalActions'][0]['tiles']
            g.apply(s, d['decisionId'], d['legalActions'][0]['actionId'], 1)
            if s < 3:
                self.assertEqual([p.hand for p in g.players], before)
                self.assertNotIn('exchangeDirection', g.view())
                self.assertNotIn('exchange', g.view(s))
        self.assertEqual(g.stage, 'daque')
        self.assertEqual([len(p.hand) for p in g.players], [14, 13, 13, 13])
        self.assertEqual(inventory(g), counts)
        self.assertEqual(g.dealer.deck, wall)
        self.assertEqual(g.dealer.act_history, [])
        self.assertNotIn('exchange', g.view())
        for s in range(4):
            own = g.view(s)['exchange']
            self.assertEqual(own['given'], choices[s])
            self.assertEqual(own['received'], choices[(s-g.exchange_direction)%4])
            self.assertEqual(g.decision(s)['phase'], 'daque')
        with self.assertRaises(ArenaError):g.apply(0, g.decision(0)['decisionId'], 'not-an-action', 2)

    def test_exchange_mid_window_persists_and_rules_version_is_frozen(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as directory:
            store = ArenaStore(directory)
            data = store.create({})
            for i, seat in enumerate(data['seatIds']):store.join(seat, f'AI {i}', 'ai')
            room = store.room(data['roomId'])
            d = room.game.decision(0)
            body = {'decisionId':d['decisionId'], 'actionId':d['legalActions'][0]['actionId'], 'requestId':'exchange'}
            store.submit(data['seatIds'][0], body)
            restored = ArenaStore(directory)
            recovered = restored.room(room.id)
            self.assertEqual(recovered.game.view(), room.game.view())
            self.assertEqual(recovered.game.responses, room.game.responses)
            self.assertTrue(restored.submit(data['seatIds'][0], body)['duplicate'])
            self.assertEqual(recovered.config['rulesVersion'], 'xuezhan-arena-v2')

    def test_legacy_record_without_version_restores_without_adding_exchange(self):
        room = Room({'name':'legacy','games':1,'turnSeconds':120,'timeoutPolicy':'forfeit'})
        for i, seat in enumerate(room.seats):room.join(seat['seatId'], f'AI {i}', 'ai')
        room.command({'op':'start','at':0,'seed':42})
        d = room.game.decision(0)
        self.assertEqual(d['phase'], 'daque')
        room.command({'op':'action','at':1,'participant':0,'decisionId':d['decisionId'],
                      'actionId':'a1','requestId':'legacy-first'})
        record = copy.deepcopy(room.record())
        self.assertNotIn('rulesVersion', record['config'])
        restored = Room.restore(record)
        self.assertEqual(restored.game.view(), room.game.view())
        self.assertEqual(restored.game.dealer.numWl, 54)
        self.assertEqual(restored.config['rulesVersion'], 'xuezhan-arena-v1')

    def test_unstarted_old_room_upgrades_before_dealing(self):
        room=Room({'name':'old lobby','games':1,'turnSeconds':120,'timeoutPolicy':'forfeit'})
        restored=Room.restore(room.record())
        self.assertEqual(restored.config['rulesVersion'],'xuezhan-arena-v2')
        for i,s in enumerate(restored.seats):restored.join(s['seatId'],f'AI {i}','ai')
        restored.command({'op':'start','at':0,'seed':42})
        self.assertEqual(restored.game.phase,'exchange')

    def test_wall_and_draw_records_match_actual_draws(self):
        g = ArenaGame(42, 1, 0, 120)
        self.assertEqual(len(g.dealer.deck), 55)
        self.assertEqual(g.dealer.numWl, 55)
        self.assertEqual(g.dealer.draw_times, [0]*4)
        self.assertEqual(g.dealer.act_history, [])
        g.dealer.deal_cards(g.players[1], 1)
        self.assertEqual(g.dealer.numWl, len(g.dealer.deck))
        self.assertEqual(g.dealer.draw_times, [0,1,0,0])
        self.assertEqual(g.dealer.drawn_cards[1], g.players[1].hand[-1])
        g.players[1].play_card(g.dealer, g.players[1].hand[-1])
        self.assertIsNone(g.dealer.drawn_cards[1])

    def test_opening_tianhu_and_earth_win_need_real_draw_history(self):
        hand = [[0,n] for n in [1,2,3,1,2,3,4,5,6,7,8,9,5,5]]
        g = ArenaGame(1,1,0,120)
        p = g.players[0];p.hand = copy.deepcopy(hand);p.daque_color = 2
        p.zimo(g.dealer,g.players)
        self.assertEqual(p.myscore,96)
        self.assertIn('tianhu',p.hu_way)
        g = ArenaGame(1,1,0,120)
        p = g.players[2];p.hand = copy.deepcopy(hand);p.daque_color = 2
        g.dealer.draw_times[2] = 1
        g.dealer.act_history = [[0,'discard',[1,9]],[1,'draw'],[1,'discard',[1,8]],[2,'draw']]
        p.zimo(g.dealer,g.players)
        self.assertEqual(p.myscore,96)
        self.assertIn('dihu',p.hu_way)
        for event in ([1,'pong',[1,7]], [2,'discard',[1,9]]):
            g = ArenaGame(1,1,0,120)
            p = g.players[2];p.hand = copy.deepcopy(hand);p.daque_color = 2
            g.dealer.draw_times[2] = 1;g.dealer.act_history = [event,[2,'draw']]
            p.zimo(g.dealer,g.players)
            self.assertNotIn('dihu',p.hu_way)
        g = ArenaGame(1,1,0,120)
        p = g.players[1];p.hand=copy.deepcopy(hand[:-1]);p.daque_color=2
        p.hu(hand[-1],g.dealer,g.players,g.players[0])
        self.assertNotIn('dihu',p.hu_way)
        self.assertEqual(g.players[2].myscore,0)
        self.assertEqual(g.players[3].myscore,0)

    def test_pong_does_not_create_fake_draw_and_must_discard_missing_suit(self):
        g = ArenaGame(1,1,0,120)
        for p in g.players:p.daque_color=2
        g.players[1].hand=[[0,9]]*2+[[0,n] for n in range(1,9)]+[[2,1],[1,2],[1,4]]
        g.dealer.table=[[0,9]];g.stage='play';g.round.current_player=1
        g.round.player_before_act=0;g.round.valid_act='pong';g.round.last_cards=[[0,9]]*3
        g.open_decisions([1],'pong',0)
        d=g.decision(1);g.apply(1,d['decisionId'],'a0',0)
        self.assertEqual(g.phase,'discard')
        self.assertNotIn('drawn',g.view(1)['players'][1])
        self.assertEqual(g.dealer.draw_times[1],0)
        self.assertEqual([a['tile'] for a in g.decision(1)['legalActions']],[[2,1]])

    def test_last_discard_can_be_ponged_with_two_or_three_copies_but_not_konged(self):
        dealer=Dealer();dealer.deck=[];dealer.table=[[0,9]]
        players=[Player(i) for i in range(4)]
        for p in players:p.daque_color=2
        for count in (2,3):
            players[1].hand=[[0,9]]*count
            action,p,cards=Judger.judge_pong_kong(dealer,players,0)
            self.assertEqual(action,'pong')
            self.assertEqual(p.player_id,1)
            self.assertEqual(len(cards),3)

    def robbed_chain(self):
        g=ArenaGame(42,1,0,120)
        hands={0:[[0,1],[0,2],[0,3],[1,2],[1,3],[1,4],[1,5],[0,5]],
               1:[[0,n] for n in [1,2,3,7,8,9,4,6]]+[[1,n] for n in [1,2,3,4,4]],
               2:[[0,n] for n in [1,2,3,7,8,9]]+[[1,n] for n in [1,2,3,5,6,7,9]]}
        pool=init_deck()
        for s,hand in hands.items():
            g.players[s].hand=copy.deepcopy(hand)
            for t in hand:pool.remove(t)
        g.players[0].pile=[[[1,8]]*4,[[0,5]]*3]
        for meld in g.players[0].pile:
            for t in meld:pool.remove(t)
        g.players[3].hand=[pool.pop() for _ in range(13)]
        pool.remove([1,9]);pool.append([1,9])
        g.dealer.table=pool[:-30];g.dealer.deck=pool[-30:];g.dealer.numWl=30
        for p in g.players:p.daque_color=2
        g.stage='play';g.round.valid_act='zikong';g.round.current_player=0
        g.round.kong_index=1;g.round.kong_list=[[1,8]]
        xzscore.compute_ankong_score(g.players[0],g.players,[1,8])
        g.open_decisions([0],'zikong',0)
        d=g.decision(0);a=next(a for a in d['legalActions'] if a['type']=='jiakong')
        g.apply(0,d['decisionId'],a['actionId'],0)
        return g

    def test_robbed_chained_kong_clears_bonus_before_next_players_zimo(self):
        g=self.robbed_chain()
        for s in list(g.pending):
            d=g.decision(s);a=next(a for a in d['legalActions'] if a['type']=='robkong')
            g.apply(s,d['decisionId'],a['actionId'],1)
        self.assertEqual(g.phase,'zimo')
        self.assertEqual(g.round.current_player,2)
        self.assertEqual(g.round.kong_index,0)
        d=g.decision(2);g.apply(2,d['decisionId'],'a0',2)
        self.assertNotIn('kongshanghua',g.players[2].hu_way)
        self.assertIn('zimo',g.players[2].hu_way)

    def test_robkong_last_responder_passes_and_all_pass_completes_kong(self):
        g=self.robbed_chain()
        g.round.Huers=[g.players[1],g.players[3]]
        g.open_decisions([1,3],'robkong',0)
        # Last engine-order responder passes after another accepts.
        for s,kind in ((3,'pass'),(1,'robkong')):
            d=g.decision(s);a=next(a for a in d['legalActions'] if a['type']==kind)
            g.apply(s,d['decisionId'],a['actionId'],1)
        self.assertEqual(g.round.kong_index,0)
        self.assertEqual(g.round.current_player,2)
        g=self.robbed_chain();wall=len(g.dealer.deck)
        for s in list(g.pending):
            d=g.decision(s);a=next(a for a in d['legalActions'] if a['type']=='pass')
            g.apply(s,d['decisionId'],a['actionId'],1)
        self.assertEqual(g.round.current_player,0)
        self.assertEqual(g.round.kong_index,1)
        self.assertEqual(len(g.dealer.deck),wall-1)
        self.assertEqual(g.dealer.numWl,len(g.dealer.deck))
        self.assertIsNotNone(g.dealer.drawn_cards[0])

    def test_flower_pig_refunds_kong_income_and_ledgers_stay_zero_sum(self):
        g=ArenaGame(42,1,0,120);pool=init_deck()
        g.players[0].pile=[[[0,1]]*4]
        g.players[0].hand=[[2,1],[1,2],[1,3],[1,4],[0,2],[0,3],[0,4],[1,7],[1,8],[1,9]]
        for t in g.players[0].hand+g.players[0].pile[0]:pool.remove(t)
        for p in g.players[1:]:
            p.hand=[]
            for _ in range(13):
                t=next(t for t in pool if t[0]!=2);pool.remove(t);p.hand.append(t)
        for p in g.players:p.daque_color=2
        g.dealer.deck=[];g.dealer.table=pool
        xzscore.compute_ankong_score(g.players[0],g.players,[0,1])
        xzscore.update_finalScore(g.dealer,g.players)
        self.assertTrue(all('beituishui' in r for r in g.players[0].kongScore))
        self.assertEqual(sum(p.myscore for p in g.players),0)


if __name__=='__main__':unittest.main()
