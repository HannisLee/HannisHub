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
        self.profile = patch.object(dm.lobby_profile, 'get_identities', side_effect=lambda names:{x:{'name':x,'photo':''} for x in names})
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

    def test_reply_anywhere_after_incoming(self):
        """发起需要面对面或工位；对方来信后在回复窗口内可在任意位置（inbox）回复。"""
        self.access.stop()
        try:
            b_to_a = next(c['id'] for c in dm.contacts('b') if c['name'] == 'a')
            # 没有任何来信：任意位置不能发起
            self.assertFalse(dm.available('b', 'a', 'inbox'))
            self.assertFalse(next(c['can_reply'] for c in dm.contacts('b') if c['name'] == 'a'))
            with self.assertRaises(HTTPException):
                dm.send('b', b_to_a, {'source': 'inbox', 'text': 'hi', 'request_id': 'r0'})
            with patch.object(dm, 'available', return_value=True):
                dm.send('a', self.peers['b'], {'source': 'desk', 'text': '在吗', 'request_id': 'r1'})
            # 收信方任意位置可回复，发信方尚未收到回信仍不能在任意位置继续
            self.assertTrue(dm.available('b', 'a', 'inbox'))
            self.assertTrue(next(c['can_reply'] for c in dm.contacts('b') if c['name'] == 'a'))
            self.assertFalse(dm.available('a', 'b', 'inbox'))
            self.assertFalse(dm.available('b', 'a', 'unknown'))
            dm.send('b', b_to_a, {'source': 'inbox', 'text': '在', 'request_id': 'r2'})
            self.assertEqual([m['text'] for m in dm.messages('a', self.peers['b'])], ['在吗', '在'])
            self.assertTrue(dm.available('a', 'b', 'inbox'))
            # 超过回复窗口后恢复限制
            later = dm.time.time() + dm.REPLY_WINDOW_SECONDS + 1
            with patch.object(dm.time, 'time', return_value=later):
                self.assertFalse(dm.available('b', 'a', 'inbox'))
        finally:
            self.access_mock = self.access.start()

    def test_contacts_carry_photo_and_order_fields(self):
        with patch.object(dm.lobby_profile, 'get_identities', side_effect=lambda names: {x: {'name': x.upper(), 'photo': '🐱'} for x in names}):
            rows = dm.contacts('a')
        self.assertEqual({r['name'] for r in rows}, {'B', 'C'})
        self.assertTrue(all(r['photo'] == '🐱' and r['last_at'] == 0 and r['can_reply'] is False for r in rows))
        self.assertTrue(all('username' not in r and 'owner' not in r for r in rows))

    def test_only_admin_gets_incoming_notification_cursor(self):
        with patch.object(dm, 'list_users', return_value=[{'username': name} for name in ['lihan', 'a']]):
            admin_id = next(row['id'] for row in dm.contacts('a') if row['name'] == 'lihan')
            dm.send('a', admin_id, {'source': 'near', 'text': '找管理员', 'request_id': 'admin-alert'})
            contact = dm.contacts('lihan')[0]
            self.assertEqual(contact['last_incoming'], '找管理员')
            seq = contact['last_incoming_seq']
            self.assertGreater(seq, 0)
            dm.send('lihan', contact['id'], {'source': 'inbox', 'text': '收到', 'request_id': 'admin-reply'})
            self.assertEqual(dm.contacts('lihan')[0]['last_incoming_seq'], seq)
            self.assertNotIn('last_incoming_seq', dm.contacts('a')[0])


if __name__ == '__main__': unittest.main()
