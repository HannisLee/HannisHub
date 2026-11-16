"""使用临时数据库验证私聊隔离、去重和已读位置。"""
import os
import tempfile
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from chatworld import private_chat as dm


class PrivateChatTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, HANNISHUB_DB_PATH=self.tmp.name+'/test.db')
        self.env.start()
        self.users = patch.object(dm, 'list_users', return_value=[{'username':x} for x in ['a','b','c']])
        self.users.start()
        self.profile = patch.object(dm.lobby_profile, 'get_profile', side_effect=lambda x:{'name':x})
        self.profile.start()
        self.access = patch.object(dm,'available',return_value=True)
        self.access_mock = self.access.start()
        self.peers = {c['name']:c['id'] for c in dm.contacts('a')}

    def tearDown(self):
        self.access.stop(); self.profile.stop(); self.users.stop(); self.env.stop(); self.tmp.cleanup()

    def test_isolation_retry_read_and_cleanup(self):
        payload={'source':'desk','text':'你好','request_id':'one'}
        dm.send('a',self.peers['b'],payload)
        dm.send('a',self.peers['b'],payload)
        self.assertEqual(len(dm.messages('a',self.peers['b'])),1)
        self.assertEqual(dm.messages('c',self.peers['b']),[])
        a = next(c['id'] for c in dm.contacts('b') if c['name']=='a')
        rows=dm.messages('b',a)
        self.assertEqual(rows[0]['outgoing'],0)
        self.assertEqual(next(c['unread'] for c in dm.contacts('b') if c['name']=='a'),1)
        dm.read('b',a,rows[0]['seq']); dm.read('b',a,0)
        self.assertEqual(next(c['unread'] for c in dm.contacts('b') if c['name']=='a'),0)
        dm.purge_user('a')
        self.assertEqual(dm.messages('b',self.peers['c']),[])

    def test_invalid_and_unavailable(self):
        with self.assertRaises(HTTPException): dm.send('a',self.peers['b'],{'text':' '})
        self.access_mock.return_value=False
        with self.assertRaises(HTTPException): dm.send('a',self.peers['b'],{'text':'hi','request_id':'x'})


if __name__ == '__main__': unittest.main()
