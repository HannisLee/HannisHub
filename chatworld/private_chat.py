"""私聊持久化：双方各保存一份按 owner 隔离的消息，通过稳定随机编号寻址。"""
import secrets
import time
from fastapi import HTTPException
from core.database import connect, transaction
from core.auth import list_users
from chatworld import lobby_profile, lobby_presence, lobby_desks


def contacts(owner):
    """只返回显示资料，不暴露认证账号。"""
    users = list_users()
    with transaction() as db:
        for u in users:
            db.execute('INSERT OR IGNORE INTO lobby_contacts VALUES (?, ?)', (u['username'], secrets.token_hex(12)))
        rows = db.execute('SELECT * FROM lobby_contacts WHERE owner != ?', (owner,)).fetchall()
        valid = {u['username'] for u in users}
        result = []
        for r in rows:
            if r['owner'] not in valid:
                continue
            last = db.execute('SELECT text FROM lobby_messages WHERE owner=? AND peer=? ORDER BY seq DESC LIMIT 1', (owner, r['owner'])).fetchone()
            read = db.execute('SELECT seq FROM lobby_reads WHERE owner=? AND peer=?', (owner, r['owner'])).fetchone()
            count = db.execute('SELECT count(*) FROM lobby_messages WHERE owner=? AND peer=? AND outgoing=0 AND seq>?', (owner, r['owner'], read[0] if read else 0)).fetchone()[0]
            result.append({'id': r['id'], 'scene_id': lobby_presence.presence.ids.get(r['owner']), 'name': lobby_profile.get_profile(r['owner'])['name'], 'last': last[0] if last else '', 'unread': count})
        return result


def peer_for(owner, contact):
    with connect() as db:
        row = db.execute('SELECT owner FROM lobby_contacts WHERE id=? AND owner!=?', (contact, owner)).fetchone()
    if not row or row[0] not in {u['username'] for u in list_users()}:
        raise HTTPException(404, '联系人不存在')
    return row[0]


def available(owner, peer, source, opening=False):
    """以服务端收到的主连接状态验证场景交互资格。"""
    if source not in {"near", "desk"}:
        return False
    hub = lobby_presence.presence
    m = hub.members.get(owner)
    a = m.primary.state if m and m.primary and m.connections else None
    if not a:
        return False
    if source == 'desk':
        import json
        from pathlib import Path
        mine = lobby_desks.desk_state(owner)['mine']
        layout = json.loads((Path(__file__).resolve().parents[1] / 'frontend/public/chat-lobby/club/layout.json').read_text())
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


def messages(owner, contact, before=0):
    peer = peer_for(owner, contact)
    with connect() as db:
        rows = db.execute('SELECT seq,text,outgoing,created_at FROM lobby_messages WHERE owner=? AND peer=? AND (?=0 OR seq<?) ORDER BY seq DESC LIMIT 50', (owner, peer, before, before)).fetchall()
    return [dict(r) for r in reversed(rows)]


def send(owner, contact, data):
    peer = peer_for(owner, contact)
    if not available(owner, peer, data.get('source')):
        raise HTTPException(409, '交谈已结束，请靠近对方或前往自己的工位电脑')
    text, rid = data.get('text'), data.get('request_id')
    if not isinstance(text, str) or not text.strip() or len(text)>1000 or not isinstance(rid,str) or not 1<=len(rid)<=80:
        raise HTTPException(400, '消息格式无效（最多 1000 字）')
    text = ''.join(c for c in text.strip() if c.isprintable() or c in '\n\t')
    if not text.strip():
        raise HTTPException(400, '消息不能为空')
    with transaction() as db:
        old = db.execute('SELECT seq FROM lobby_messages WHERE owner=? AND peer=? AND request_id=? AND outgoing=1', (owner,peer,rid)).fetchone()
        if old:
            return {'ok':True}
        last = db.execute('SELECT created_at FROM lobby_messages WHERE owner=? AND outgoing=1 ORDER BY seq DESC LIMIT 1', (owner,)).fetchone()
        if last and time.time()-last[0]<0.8:
            raise HTTPException(429, '发送太快，请稍后重试')
        now = time.time()
        for who, other, outgoing in [(owner,peer,1),(peer,owner,0)]:
            db.execute('INSERT INTO lobby_messages(owner,peer,request_id,outgoing,text,created_at) VALUES (?,?,?,?,?,?)', (who,other,rid,outgoing,text,now))
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
