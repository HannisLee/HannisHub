"""私聊持久化：双方各保存一份按 owner 隔离的消息，通过稳定随机编号寻址。

发送规则：发起私聊需要面对面（near）或坐在自己的工位电脑前（desk）；
接收不限位置——对方在 REPLY_WINDOW_SECONDS 内发来过消息时，可在任意位置（inbox）查看并回复。
阅读历史消息始终不限位置。
"""
import json
import secrets
import time
from fastapi import HTTPException
from core.database import connect, db_path, transaction
from core.auth import list_users
from chatworld import chat_room, lobby_profile, lobby_presence, lobby_desks
from pathlib import Path

# 对方最近一条来信后的这段时间内，可在任意位置回复
REPLY_WINDOW_SECONDS = 24 * 60 * 60
LAYOUT_PATH = Path(__file__).resolve().parents[1] / 'frontend/public/chat-lobby/club/layout.json'


def contacts(owner):
    """只返回显示资料，不暴露认证账号。"""
    users = list_users()
    with transaction() as db:
        for u in users:
            db.execute('INSERT OR IGNORE INTO lobby_contacts VALUES (?, ?)', (u['username'], secrets.token_hex(12)))
        rows = db.execute('SELECT * FROM lobby_contacts WHERE owner != ?', (owner,)).fetchall()
        valid = {u['username'] for u in users}
        peers = [r for r in rows if r['owner'] in valid]
        identities = lobby_profile.get_identities({r['owner'] for r in peers})
        now = time.time()
        result = []
        for r in peers:
            last = db.execute('SELECT text, created_at, attachment_id FROM lobby_messages WHERE owner=? AND peer=? ORDER BY seq DESC LIMIT 1', (owner, r['owner'])).fetchone()
            incoming_row = db.execute('SELECT seq, text, created_at, attachment_id FROM lobby_messages WHERE owner=? AND peer=? AND outgoing=0 ORDER BY seq DESC LIMIT 1', (owner, r['owner'])).fetchone()
            incoming = incoming_row['created_at'] if incoming_row else None
            read = db.execute('SELECT seq FROM lobby_reads WHERE owner=? AND peer=?', (owner, r['owner'])).fetchone()
            count = db.execute('SELECT count(*) FROM lobby_messages WHERE owner=? AND peer=? AND outgoing=0 AND seq>?', (owner, r['owner'], read[0] if read else 0)).fetchone()[0]
            identity = identities[r['owner']]
            result.append({
                'id': r['id'], 'scene_id': lobby_presence.presence.ids.get(r['owner']),
                'name': identity['name'], 'photo': identity['photo'],
                'last': _preview(last), 'last_at': last[1] if last else 0, 'unread': count,
                'can_reply': bool(incoming and now - incoming < REPLY_WINDOW_SECONDS),
            })
            if owner == 'lihan':
                result[-1].update(last_incoming_seq=incoming_row['seq'] if incoming_row else 0,
                                  last_incoming=_preview(incoming_row))
        return result


def peer_for(owner, contact):
    with connect() as db:
        row = db.execute('SELECT owner FROM lobby_contacts WHERE id=? AND owner!=?', (contact, owner)).fetchone()
    if not row or row[0] not in {u['username'] for u in list_users()}:
        raise HTTPException(404, '联系人不存在')
    return row[0]


def can_reply(owner, peer):
    """对方在回复窗口内发来过消息：不限位置即可回复。"""
    with connect() as db:
        row = db.execute('SELECT max(created_at) FROM lobby_messages WHERE owner=? AND peer=? AND outgoing=0', (owner, peer)).fetchone()
    return bool(row[0] and time.time() - row[0] < REPLY_WINDOW_SECONDS)


def available(owner, peer, source, opening=False):
    """能否向对方发消息：收到的会话任意位置可回复；发起则以服务端收到的主连接状态验证场景交互资格。"""
    if source not in {"near", "desk", "inbox"}:
        return False
    if can_reply(owner, peer):
        return True
    if source == 'inbox':
        return False
    hub = lobby_presence.presence
    m = hub.members.get(owner)
    a = m.primary.state if m and m.primary and m.connections else None
    if not a:
        return False
    if source == 'desk':
        mine = lobby_desks.desk_state(owner)['mine']
        layout = json.loads(LAYOUT_PATH.read_text())
        for room in layout['rooms']:
            for desk in room.get('desks', []):
                seat = desk['seat']
                if desk['id'] == mine and a['room'] == room['id'] and a.get('pose') == 'sit':
                    return abs(a['x']-room['x']-seat['x']) < 3 and abs(a['y']-room['y']-seat['y']) < 3
        return False
    n = hub.members.get(peer)
    b = n.primary.state if n and n.primary and n.connections else None
    if not b or a['room'] not in hub_public_rooms or a['room'] != b['room']:
        return False
    dx, dy = b['x']-a['x'], b['y']-a['y']
    if dx*dx+dy*dy > (32 if opening else 48)**2:
        return False
    if opening:
        vx, vy = {'up':(0,-1),'down':(0,1),'left':(-1,0),'right':(1,0)}[a['dir']]
        return dx*vx+dy*vy > 0 and abs(dx*vy-dy*vx) <= dx*vx+dy*vy
    return True


hub_public_rooms = {'foyer', 'hall'}


def _preview(row):
    if not row:
        return ''
    return row['text'] or ('[附件]' if row['attachment_id'] else '')


def files_dir() -> Path:
    path = db_path()
    return path.with_name(f'{path.stem}_private_chat_files')


def upload_scope(owner, contact, source):
    peer = peer_for(owner, contact)
    _require_available(owner, peer, source)
    directory = files_dir()
    if directory.is_dir():
        # 与消息写入串行，避免清理正在提交的附件。
        with transaction() as db:
            referenced = {row[0] for row in db.execute(
                'SELECT DISTINCT attachment_id FROM lobby_messages WHERE attachment_id IS NOT NULL'
            )}
            chat_room.cleanup_files(directory, referenced)
    return {'owner': owner, 'contact': contact}


def file_response_info(owner, contact, file_id, download):
    peer = peer_for(owner, contact)
    with connect() as db:
        if not db.execute(
            'SELECT 1 FROM lobby_messages WHERE attachment_id=? AND owner=? AND peer=? LIMIT 1',
            (file_id, owner, peer),
        ).fetchone():
            raise HTTPException(404, '附件不存在')
    return chat_room.file_response_info(file_id, download, files_dir())


def messages(owner, contact, before=0):
    peer = peer_for(owner, contact)
    with connect() as db:
        rows = db.execute('SELECT seq,text,outgoing,created_at,attachment_id FROM lobby_messages WHERE owner=? AND peer=? AND (?=0 OR seq<?) ORDER BY seq DESC LIMIT 50', (owner, peer, before, before)).fetchall()
    result = []
    for row in reversed(rows):
        message = dict(row)
        file_id = message.pop('attachment_id')
        if file_id:
            try:
                message['attachment'] = chat_room.attachment_info(chat_room.read_file_meta(file_id, files_dir()))
            except HTTPException:
                # 文件丢失时仍可读取历史消息。
                message['text'] = message['text'] or '[附件不可用]'
        result.append(message)
    return result


def _require_available(owner, peer, source):
    if not available(owner, peer, source):
        raise HTTPException(409, '只能回复对方发来的私聊；发起新的私聊请面对对方按 E，或前往自己的工位电脑')


def send(owner, contact, data):
    peer = peer_for(owner, contact)
    _require_available(owner, peer, data.get('source'))
    text, rid, file_id = data.get('text', ''), data.get('request_id'), data.get('attachment_id')
    if not isinstance(text, str) or len(text) > 1000 or not isinstance(rid, str) or not 1 <= len(rid) <= 80:
        raise HTTPException(400, '消息格式无效（最多 1000 字）')
    if file_id is not None and not isinstance(file_id, str):
        raise HTTPException(400, '附件编号无效')
    text = ''.join(c for c in text if c.isprintable() or c in '\n\t').strip()
    if not text and not file_id:
        raise HTTPException(400, '消息不能为空')
    with transaction() as db:
        old = db.execute('SELECT seq FROM lobby_messages WHERE owner=? AND peer=? AND request_id=? AND outgoing=1', (owner,peer,rid)).fetchone()
        if old:
            return {'ok':True}
        if file_id:
            meta = chat_room.read_file_meta(file_id, files_dir())
            if meta.get('owner') != owner or meta.get('contact') != contact:
                raise HTTPException(404, '附件不存在')
        last = db.execute('SELECT created_at FROM lobby_messages WHERE owner=? AND outgoing=1 ORDER BY seq DESC LIMIT 1', (owner,)).fetchone()
        if last and time.time()-last[0]<0.8:
            raise HTTPException(429, '发送太快，请稍后重试')
        now = time.time()
        for who, other, outgoing in [(owner,peer,1),(peer,owner,0)]:
            db.execute('INSERT INTO lobby_messages(owner,peer,request_id,outgoing,text,created_at,attachment_id) VALUES (?,?,?,?,?,?,?)', (who,other,rid,outgoing,text,now,file_id or None))
    return {'ok':True}


def read(owner, contact, seq):
    peer = peer_for(owner, contact)
    with connect() as db:
        row = db.execute('SELECT max(seq) FROM lobby_messages WHERE owner=? AND peer=? AND seq<=?', (owner,peer,seq)).fetchone()
        db.execute('INSERT INTO lobby_reads VALUES (?,?,?) ON CONFLICT(owner,peer) DO UPDATE SET seq=max(seq,excluded.seq)', (owner,peer,row[0] or 0))


def purge_user(owner):
    with transaction() as db:
        db.execute('DELETE FROM lobby_messages WHERE owner=? OR peer=?',(owner,owner))
        db.execute('DELETE FROM lobby_reads WHERE owner=? OR peer=?',(owner,owner))
        db.execute('DELETE FROM lobby_contacts WHERE owner=?',(owner,))
