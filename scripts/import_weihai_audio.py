"""Import the pinned WeiHai Mahjong audio subset, license and SHA-256 manifest."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import time
from urllib.request import urlopen

REVISION = '7a1bc252edcd94b13ad8b41d210a5552d9cceed1'
REPOSITORY = 'https://github.com/hjj2017/whmj.cocos2d_client'
BASE = f'https://raw.githubusercontent.com/hjj2017/whmj.cocos2d_client/{REVISION}/'
SOURCE = 'assets/game/MJ_weihai_/res/1/audio/'
DEST = Path(__file__).resolve().parents[1] / 'webgame' / 'audio' / 'weihai'


def download(pair):
    local, remote = pair
    for attempt in range(4):
        try:
            with urlopen(BASE + remote, timeout=30) as response:
                data = response.read()
            target = DEST / local
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            return {'file': local, 'source': remote, 'bytes': len(data),
                    'sha256': hashlib.sha256(data).hexdigest()}
        except OSError:
            if attempt == 3:
                raise
            time.sleep(attempt + 1)


if __name__ == '__main__':
    files = ['ChuPai.mp3']
    for voice in (0, 1):
        files += [f'sex_{voice}_/MahjongVal_{base + rank}_.mp3'
                  for base in (20, 40, 80) for rank in range(1, 10)]
        files += [f'sex_{voice}_/Round_{action}_.mp3'
                  for action in ('Peng', 'Gang', 'Hu', 'ZiMo')]
    with ThreadPoolExecutor(max_workers=6) as pool:
        manifest = list(pool.map(download, [(f, SOURCE + f) for f in files] + [('LICENSE', 'LICENSE')]))
    (DEST / 'manifest.json').write_text(json.dumps({
        'repository': REPOSITORY, 'revision': REVISION,
        'license': 'Apache-2.0 (upstream repository LICENSE)',
        'files': manifest}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Imported {len(files)} audio files and LICENSE into {DEST}')
