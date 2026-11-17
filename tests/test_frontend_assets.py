"""使用临时静态目录验证构建切换时的资源保留与缓存策略。"""
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.staticfiles import StaticFiles

from core.frontend import FrontendCacheMiddleware, FrontendStaticFiles


class FrontendAssetsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.current = self.root / 'out'
        self.current.mkdir()
        self.retained = self.root / 'retained'
        application = FastAPI()
        application.add_middleware(FrontendCacheMiddleware)
        application.mount('/_next/static', FrontendStaticFiles(self.current / '_next/static', self.retained))
        application.mount('/', StaticFiles(directory=self.current, html=True))
        self.client = TestClient(application)

    def test_old_chunk_survives_build_and_current_takes_priority(self):
        (self.retained / 'chunks').mkdir()
        (self.retained / 'chunks/old.js').write_text('旧脚本')
        (self.retained / 'chunks/shared.js').write_text('旧共享脚本')
        self.assertEqual(self.client.get('/_next/static/chunks/old.js').text, '旧脚本')
        target = self.current / '_next/static/chunks'
        target.mkdir(parents=True)
        (target / 'shared.js').write_text('新共享脚本')
        self.assertEqual(self.client.get('/_next/static/chunks/shared.js').text, '新共享脚本')
        self.assertEqual(self.client.get('/_next/static/chunks/old.js').status_code, 200)
        self.assertEqual(self.client.get('/_next/static/chunks/missing.js').status_code, 404)
        (self.root / 'secret.txt').write_text('秘密')
        (self.retained / 'escape.js').symlink_to(self.root / 'secret.txt')
        self.assertEqual(self.client.get('/_next/static/escape.js').status_code, 404)
        self.assertEqual(self.client.get('/_next/static/%2e%2e/secret.txt').status_code, 404)

    def test_html_and_navigation_data_are_not_cached(self):
        (self.current / 'chat').mkdir()
        for filename, text in [('index.html', '<h1>聊天室</h1>'), ('index.txt', '导航数据'), ('__next._tree.txt', '路由树')]:
            (self.current / 'chat' / filename).write_text(text)
        (self.retained / 'chunk.js').write_text('脚本')
        for path in ['/chat/', '/chat/index.txt', '/chat/__next._tree.txt']:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['cache-control'], 'no-store')
            # 即使浏览器带着旧 ETag，也不能再次缓存本次响应。
            response = self.client.get(path, headers={'If-None-Match': response.headers['etag']})
            self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertNotEqual(self.client.get('/_next/static/chunk.js').headers.get('cache-control'), 'no-store')
