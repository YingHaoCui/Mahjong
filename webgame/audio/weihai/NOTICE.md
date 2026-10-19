# WeiHai Mahjong audio

These 63 MP3 files are redistributed unchanged from
[hjj2017/whmj.cocos2d_client](https://github.com/hjj2017/whmj.cocos2d_client),
revision `7a1bc252edcd94b13ad8b41d210a5552d9cceed1`, directory
`assets/game/MJ_weihai_/res/1/audio/`.

The upstream repository distributes this material alongside its Apache License
2.0; the original LICENSE is included here. Upstream does not provide a separate
recording-author credit or audio-specific license statement. This notice records
the repository's stated license and does not assert independent ownership of the
recordings. Original file names and MP3 bytes are preserved. `manifest.json`
records upstream paths, sizes and SHA-256 hashes.

Only number tiles (27 × 2 voices), Peng/Gang/Hu/ZiMo (4 × 2 voices), and ChuPai
are imported. Music, chat voices, honor tiles and unrelated game assets are not
included. Reimport with `python scripts/import_weihai_audio.py`.

## Mapping

The mapping follows upstream `script/MahjongTileDef.ts`, rather than file order:

| Arena tile | Upstream value | Voice file (under sex_0_ or sex_1_) |
| --- | --- | --- |
| `[0, n]` 条 | `40 + n` | `MahjongVal_41_.mp3` … `MahjongVal_49_.mp3` |
| `[1, n]` 万 | `20 + n` | `MahjongVal_21_.mp3` … `MahjongVal_29_.mp3` |
| `[2, n]` 筒 | `80 + n` | `MahjongVal_81_.mp3` … `MahjongVal_89_.mp3` |
| discard | impact + tile voice | `ChuPai.mp3` + mapped tile |
| pong | Peng | `Round_Peng_.mp3` |
| kong / ankong / jiakong | Gang | `Round_Gang_.mp3` |
| hu / robkong | Hu | `Round_Hu_.mp3` |
| zimo | ZiMo | `Round_ZiMo_.mp3` |

Participant indices 0/2 use voice 0; 1/3 use voice 1. Voices follow participants
when seats rotate. Draws do not announce private tiles. Exchange, daque and pass
have no matching imported voice and remain silent.
