"""容器间仅经 Unix 套接字传输画面和受限公网连接。"""

import asyncio
import hmac
import ipaddress
import os
import socket
import sys
from contextlib import suppress

SOCKET_DIR = "/desk-browser"
DISPLAY = SOCKET_DIR + "/display.sock"
EGRESS = SOCKET_DIR + "/egress.sock"
PROXY_PORT = 10809
DISPLAY_PORT = 18080
STREAM_PATH = b"/desk-browser/session/api/websockets"
STATUS_PATH = b"/desk-browser/session/api/status"


async def _close(writer):
    writer.close()
    with suppress(OSError):
        await writer.wait_closed()


async def _relay(reader, writer, peer_reader, peer_writer):
    async def pump(source, target):
        while chunk := await asyncio.wait_for(source.read(65536), 180):
            target.write(chunk)
            await asyncio.wait_for(target.drain(), 30)
        if target.can_write_eof():
            target.write_eof()

    try:
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(pump(reader, peer_writer))
            tasks.create_task(pump(peer_reader, writer))
    except* (OSError, TimeoutError):
        pass
    finally:
        await _close(peer_writer)


async def _public_connection(host, port, blocked):
    if port not in (80, 443):
        raise ValueError("仅允许网页端口")
    loop = asyncio.get_running_loop()
    endpoints = await loop.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
    addresses = {entry[4][0] for entry in endpoints}
    for address in addresses:
        ip = ipaddress.IPv4Address(address)
        if not ip.is_global or ip.is_multicast or address in blocked:
            continue
        # 直接连接已校验的数字地址，避免二次解析改变目标。
        try:
            return await asyncio.wait_for(asyncio.open_connection(address, port), 5)
        except (OSError, TimeoutError):
            continue
    raise OSError("无可用公网地址")


async def _socks(reader, writer, blocked):
    version, count = await reader.readexactly(2)
    if version != 5 or 0 not in await reader.readexactly(count):
        return
    writer.write(b"\x05\x00")
    await writer.drain()
    version, command, reserved, addr_type = await reader.readexactly(4)
    if (version, command, reserved) != (5, 1, 0):
        return
    if addr_type == 1:
        host = socket.inet_ntoa(await reader.readexactly(4))
    elif addr_type == 3:
        size = (await reader.readexactly(1))[0]
        host = (await reader.readexactly(size)).decode("ascii")
    else:
        return
    port = int.from_bytes(await reader.readexactly(2), "big")
    peer_reader, peer_writer = await _public_connection(host, port, blocked)
    return peer_reader, peer_writer


async def _gateway():
    token = os.environ["HANNISHUB_BROWSER_TOKEN"].encode()
    blocked = set(os.environ.get("HANNISHUB_BROWSER_BLOCK_IPS", "").split())
    slots = asyncio.Semaphore(128)

    async def egress(reader, writer):
        try:
            if slots.locked():
                return
            async with slots:
                try:
                    peer = await asyncio.wait_for(_socks(reader, writer, blocked), 15)
                except (OSError, ValueError, asyncio.IncompleteReadError, TimeoutError):
                    writer.write(b"\x05\x02\x00\x01" + bytes(6))
                    await writer.drain()
                    return
                if peer:
                    writer.write(b"\x05\x00\x00\x01" + bytes(6))
                    await _relay(reader, writer, *peer)
        finally:
            await _close(writer)

    async def display(reader, writer):
        try:
            data = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            lines = data[:-4].split(b"\r\n")
            request = lines[0].split()
            if (len(request) != 3 or request[0] != b"GET"
                    or request[1].split(b"?", 1)[0] not in {STREAM_PATH, STATUS_PATH}):
                return
            credentials = []
            forwarded = [lines[0]]
            for line in lines[1:]:
                key, _, value = line.partition(b":")
                if key.lower() == b"x-hannishub-browser":
                    credentials.append(value.strip())
                else:
                    forwarded.append(line)
            if len(credentials) != 1 or not hmac.compare_digest(credentials[0], token):
                return
            peer_reader, peer_writer = await asyncio.open_unix_connection(DISPLAY)
            peer_writer.write(b"\r\n".join(forwarded) + b"\r\n\r\n")
            await _relay(reader, writer, peer_reader, peer_writer)
        except (OSError, ValueError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
            pass
        finally:
            await _close(writer)

    with suppress(FileNotFoundError):
        os.unlink(EGRESS)
    egress_server = await asyncio.start_unix_server(egress, EGRESS)
    display_server = await asyncio.start_server(display, "0.0.0.0", DISPLAY_PORT, limit=16384)
    async with egress_server, display_server:
        await asyncio.gather(egress_server.serve_forever(), display_server.serve_forever())


async def _browser():
    async def display(reader, writer):
        try:
            peer = await asyncio.open_connection("127.0.0.1", 3000)
            await _relay(reader, writer, *peer)
        except OSError:
            pass
        finally:
            await _close(writer)

    async def egress(reader, writer):
        try:
            peer = await asyncio.open_unix_connection(EGRESS)
            await _relay(reader, writer, *peer)
        except OSError:
            pass
        finally:
            await _close(writer)

    with suppress(FileNotFoundError):
        os.unlink(DISPLAY)
    display_server = await asyncio.start_unix_server(display, DISPLAY)
    egress_server = await asyncio.start_server(egress, "127.0.0.1", PROXY_PORT)
    async with display_server, egress_server:
        await asyncio.gather(display_server.serve_forever(), egress_server.serve_forever())


if __name__ == "__main__":
    asyncio.run({"gateway": _gateway, "browser": _browser}[sys.argv[1]]())
