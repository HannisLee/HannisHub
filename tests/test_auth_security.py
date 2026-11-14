"""验证登录后的权限边界和跨站写请求防护。"""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from core.auth import AuthMiddleware, clear_login_failures, is_login_allowed, login_account_key, record_login_failure
from model_manager import app as model


class SecurityTest(unittest.TestCase):
    def setUp(self):
        application = FastAPI()
        application.add_middleware(AuthMiddleware)

        @application.api_route('/{path:path}', methods=['GET', 'POST', 'DELETE'])
        async def catch(path: str):
            return {'ok': True}

        self.client = TestClient(application, base_url='http://testserver')

    def test_access_and_origin(self):
        with patch('core.auth.current_username', return_value=None):
            self.assertEqual(self.client.get('/api/file-manager/directory').status_code, 401)
        with patch('core.auth.current_username', return_value='other'):
            for path in ['/api/file-manager/directory', '/api/users', '/server/api/tasks', '/llama-manager/api/settings', '/llama-manager/llama-process/123/api/other']:
                self.assertEqual(self.client.get(path).status_code, 403, path)
            for path in ['/api/chat-room/messages', '/api/ocr/records', '/llama-manager/api/asr/history', '/llama-manager/api/custom-services',
                         '/api/todos', '/api/chat-lobby/desks']:
                self.assertEqual(self.client.get(path).status_code, 200, path)
            self.assertEqual(self.client.delete('/api/chat-room/messages', headers={'Origin': 'http://testserver'}).status_code, 403)
            self.assertEqual(self.client.post('/api/ocr/records', headers={'Origin': 'http://evil.test'}).status_code, 403)
            self.assertEqual(self.client.post('/api/ocr/records').status_code, 403)
            self.assertEqual(self.client.post('/api/ocr/records', headers={'Origin': 'http://testserver'}).status_code, 200)
            # 工位待办：普通账号可读写自己的待办，跨站写请求同样被拒
            self.assertEqual(self.client.post('/api/todos', headers={'Origin': 'http://testserver'}).status_code, 200)
            self.assertEqual(self.client.post('/api/todos', headers={'Origin': 'http://evil.test'}).status_code, 403)
            self.assertEqual(self.client.delete('/api/todos/abc', headers={'Origin': 'http://testserver'}).status_code, 200)
        with patch('core.auth.current_username', return_value='lihan'):
            self.assertEqual(self.client.get('/api/file-manager/directory').status_code, 200)
            self.assertEqual(self.client.post('/api/users', headers={'Referer': 'http://testserver/settings/users'}).status_code, 200)

    def test_login_limit(self):
        key = login_account_key('security-test')
        clear_login_failures(key)
        try:
            for _ in range(5):
                record_login_failure(key)
            self.assertFalse(is_login_allowed(key))
        finally:
            clear_login_failures(key)

    def test_start_rejects_other_services(self):
        async def check():
            request = SimpleNamespace(session={'user': 'other'})
            with patch.object(model, '_load_custom_services', return_value={'bad': {'id': 'bad', 'service_category': 'llm'}}):
                with self.assertRaises(HTTPException) as caught:
                    await model.start_server({'service_id': 'bad'}, request)
                self.assertEqual(caught.exception.status_code, 403)
        asyncio.run(check())


if __name__ == '__main__':
    unittest.main()
