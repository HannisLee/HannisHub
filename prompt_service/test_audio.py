"""录音归档与外部 ASR 的集成回归检查，不依赖真实密钥。"""

import asyncio
import base64
import io
import json
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from prompt_service.audio import AudioService, MAX_AUDIO_BYTES, resolve_asr_endpoint


class AudioTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.settings_path = self.directory / "settings.json"
        self.settings_path.write_text(json.dumps({"prompts": [{"id": "existing"}], "groups": [], "custom": "保留"}))
        self.lock = threading.RLock()
        self.service = self.new_service()
        self.app = FastAPI()
        self.app.include_router(self.service.router, prefix="/api")
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        output = io.BytesIO()
        with wave.open(output, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\x00\x00" * 1600)
        self.audio = output.getvalue()

    def new_service(self):
        def read():
            return json.loads(self.settings_path.read_text())

        def write(data):
            self.settings_path.write_text(json.dumps(data))

        return AudioService(self.directory, read, write, self.lock)

    async def asyncTearDown(self):
        await self.service.stop()
        await self.client.aclose()
        self.temp.cleanup()

    async def upload(self, recording_id="rec_test_001", audio=None):
        return await self.client.post(f"/api/recordings/{recording_id}", content=audio if audio is not None else self.audio, headers={"content-type": "audio/wav"})

    async def wait_status(self, expected, recording_id="rec_test_001"):
        for _ in range(500):
            item = self.service.find(recording_id)
            if item["status"] == expected:
                return item
            if item["status"] == "failed" and expected != "failed":
                self.fail(item["error"])
            await asyncio.sleep(0.01)
        self.fail(f"录音未进入 {expected} 状态")

    async def test_archive_first_and_idempotent_retry(self):
        response = await self.upload()
        self.assertEqual(response.status_code, 200)
        item = await self.wait_status("waiting_config")
        self.assertEqual(Path(item["raw_path"]).read_bytes(), self.audio)
        self.assertGreater(Path(item["converted_path"]).stat().st_size, 0)
        self.assertEqual((await self.upload()).status_code, 200)
        self.assertEqual(len(self.service.records()), 1)
        self.assertEqual((await self.upload(audio=self.audio + b"changed")).status_code, 409)
        download = await self.client.get("/api/recordings/rec_test_001/audio")
        self.assertEqual(download.content, self.audio)
        converted = await self.client.get("/api/recordings/rec_test_001/audio?converted=true")
        self.assertEqual(converted.headers["content-type"], "audio/mpeg")
        saved = json.loads(self.settings_path.read_text())
        self.assertEqual(saved["prompts"], [{"id": "existing"}])
        self.assertEqual(saved["custom"], "保留")

    async def test_delete_archives_and_prevent_reupload(self):
        await self.upload()
        item = await self.wait_status("waiting_config")
        raw = Path(item["raw_path"])
        converted = Path(item["converted_path"])
        text = raw.with_name("rec_test_001.txt")
        text.write_text("需要删除的转写", encoding="utf-8")
        await self.upload("rec_keep_002")
        await self.wait_status("waiting_config", "rec_keep_002")
        self.assertEqual((await self.client.delete("/api/recordings/rec_test_001")).status_code, 200)
        self.assertTrue(all(not path.exists() for path in (raw, converted, text)))
        self.assertEqual([item["id"] for item in self.service.records()], ["rec_keep_002"])
        self.assertEqual((await self.client.get("/api/recordings/rec_test_001/audio")).status_code, 404)
        self.assertEqual((await self.upload()).status_code, 410)
        self.assertEqual((await self.client.delete("/api/recordings/rec_test_001")).status_code, 200)
        saved = json.loads(self.settings_path.read_text())
        self.assertEqual(saved["prompts"], [{"id": "existing"}])
        self.assertEqual(saved["custom"], "保留")
        self.assertEqual((await self.client.get("/api/recordings")).json()["deleted_recordings"], ["rec_test_001"])
        await self.service.stop()
        restarted = self.new_service()
        self.assertEqual(restarted.read_settings()["deleted_recordings"], ["rec_test_001"])

    async def test_delete_local_only_and_processing_guard(self):
        self.assertEqual((await self.client.delete("/api/recordings/rec_local_003")).status_code, 200)
        self.assertEqual((await self.upload("rec_local_003")).status_code, 410)
        await self.upload()
        item = await self.wait_status("waiting_config")
        self.service.update(item["id"], status="processing")
        self.assertEqual((await self.client.delete("/api/recordings/rec_test_001")).status_code, 409)
        self.assertTrue(Path(item["raw_path"]).is_file())
        self.assertNotIn(item["id"], self.service.read_settings()["deleted_recordings"])
        self.assertEqual((await self.client.delete("/api/recordings/bad")).status_code, 400)

    async def test_delete_queued_job_during_another_job(self):
        with patch.object(self.service, "start", new=AsyncMock()):
            await self.upload()
            await self.upload("rec_queued_002")
        entered, release = asyncio.Event(), asyncio.Event()
        processed = []

        async def process(item):
            processed.append(item["id"])
            self.service.update(item["id"], status="processing")
            entered.set()
            await release.wait()
            self.service.update(item["id"], status="waiting_config")

        with patch.object(self.service, "process", side_effect=process):
            self.service.task = asyncio.create_task(self.service.worker())
            self.service.wake.set()
            await asyncio.wait_for(entered.wait(), 2)
            self.assertEqual((await self.client.delete("/api/recordings/rec_queued_002")).status_code, 200)
            release.set()
            await self.wait_status("waiting_config")
            await asyncio.sleep(0.02)
            self.assertEqual(processed, ["rec_test_001"])
            self.assertFalse(self.service.task.done())

    async def test_delete_waits_for_upload_commit(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def stream():
            entered.set()
            await release.wait()
            yield self.audio

        with patch.object(self.service, "start", new=AsyncMock()):
            uploading = asyncio.create_task(self.client.post("/api/recordings/rec_race_004", content=stream(), headers={"content-type": "audio/wav"}))
            await asyncio.wait_for(entered.wait(), 2)
            deleting = asyncio.create_task(self.client.delete("/api/recordings/rec_race_004"))
            await asyncio.sleep(0.02)
            self.assertFalse(deleting.done())
            release.set()
            self.assertEqual((await uploading).status_code, 200)
            self.assertEqual((await deleting).status_code, 200)
        self.assertEqual(self.service.records(), [])
        self.assertFalse((self.directory / "data/recordings/rec_race_004.wav").exists())

    async def test_external_asr_protocol_and_text_archive(self):
        await self.upload()
        await self.wait_status("waiting_config")
        requests = []

        def handle(request):
            requests.append(request)
            self.assertEqual(request.url, httpx.URL("https://asr.example/v1/audio/transcriptions"))
            self.assertEqual(request.headers["authorization"], "Bearer test-key")
            self.assertIn(b'name="file"', request.content)
            self.assertIn(b'name="model"\r\n\r\ntest-model', request.content)
            self.assertIn(b'name="language"\r\n\r\nzh', request.content)
            return httpx.Response(200, json={"text": "这是完整转写"})

        original_client = httpx.AsyncClient
        with patch("prompt_service.audio.httpx.AsyncClient", side_effect=lambda **kwargs: original_client(transport=httpx.MockTransport(handle), **kwargs)):
            response = await self.client.put("/api/asr-settings", json={"api_url": "https://asr.example/v1/audio/transcriptions", "api_key": "test-key", "model": "test-model", "language": "zh"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["api_key"], "test-key")
            item = await self.wait_status("done")
        self.assertEqual(len(requests), 1)
        self.assertEqual(item["text"], "这是完整转写")
        self.assertEqual(Path(item["raw_path"]).with_name("rec_test_001.txt").read_text(), item["text"])

    async def test_mimo_base_address_audio_protocol_and_archive(self):
        await self.upload()
        before = await self.wait_status("waiting_config")

        def handle(request):
            self.assertEqual(str(request.url), "https://api.xiaomimimo.com/v1/chat/completions")
            self.assertEqual(request.headers["authorization"], "Bearer test-key")
            payload = json.loads(request.content)
            self.assertEqual(payload["model"], "mimo-v2.5-asr")
            self.assertEqual(payload["asr_options"], {"language": "auto"})
            self.assertFalse(payload["stream"])
            audio = payload["messages"][0]["content"][0]
            self.assertEqual(audio["type"], "input_audio")
            self.assertEqual(base64.b64decode(audio["input_audio"]["data"].split(",", 1)[1]), Path(before["converted_path"]).read_bytes())
            return httpx.Response(200, json={"choices": [{"message": {"content": "小米转写成功"}}]})

        original_client = httpx.AsyncClient
        with patch("prompt_service.audio.httpx.AsyncClient", side_effect=lambda **kwargs: original_client(transport=httpx.MockTransport(handle), **kwargs)):
            response = await self.client.put("/api/asr-settings", json={"api_url": "https://api.xiaomimimo.com/v1", "api_key": "test-key", "model": "mimo-v2.5-asr"})
            self.assertEqual(response.json()["protocol"], "chat_audio")
            self.assertEqual(response.json()["resolved_api_url"], "https://api.xiaomimimo.com/v1/chat/completions")
            item = await self.wait_status("done")
        self.assertEqual(item["text"], "小米转写成功")
        self.assertEqual(Path(item["raw_path"]).read_bytes(), self.audio)

    async def test_endpoint_resolution_keeps_full_endpoints_and_query(self):
        cases = [
            ({"api_url": "https://asr.example/v1/", "model": "whisper"}, ("openai", "https://asr.example/v1/audio/transcriptions")),
            ({"api_url": "https://asr.example/", "model": "whisper"}, ("openai", "https://asr.example/v1/audio/transcriptions")),
            ({"api_url": "https://asr.example/transcribe?version=2", "model": "whisper"}, ("openai", "https://asr.example/transcribe?version=2")),
            ({"api_url": "https://asr.example/v1", "model": "mimo-v2.5-asr"}, ("chat_audio", "https://asr.example/v1/chat/completions")),
            ({"api_url": "https://api.xiaomimimo.com/v1/audio/transcriptions", "model": "mimo-v2.5-asr"}, ("chat_audio", "https://api.xiaomimimo.com/v1/chat/completions")),
        ]
        for config, expected in cases:
            with self.subTest(config=config):
                self.assertEqual(resolve_asr_endpoint(config), expected)

    async def test_simplified_settings_preserve_hidden_directory_and_timeout(self):
        directory = str(self.directory / "custom-archive")
        await self.client.put("/api/asr-settings", json={"archive_dir": directory, "timeout_seconds": 123})
        response = await self.client.put("/api/asr-settings", json={"api_url": "https://asr.example/v1", "api_key": "new-key", "model": "new-model", "language": "zh"})
        self.assertEqual(response.json()["archive_dir"], directory)
        self.assertEqual(response.json()["resolved_archive_dir"], directory)
        self.assertEqual(response.json()["timeout_seconds"], 123)

    async def test_asr_failure_retains_audio_and_retry_recovers(self):
        await self.upload()
        item = await self.wait_status("waiting_config")
        original_client = httpx.AsyncClient
        responses = iter([httpx.Response(503), httpx.Response(200, json={"text": "重试成功"})])
        with patch("prompt_service.audio.httpx.AsyncClient", side_effect=lambda **kwargs: original_client(transport=httpx.MockTransport(lambda request: next(responses)), **kwargs)):
            await self.client.put("/api/asr-settings", json={"api_url": "https://asr.example/transcribe"})
            await self.wait_status("failed")
            self.assertEqual(Path(item["raw_path"]).read_bytes(), self.audio)
            self.assertTrue(Path(item["converted_path"]).is_file())
            await self.client.post("/api/recordings/rec_test_001/retry")
            self.assertEqual((await self.wait_status("done"))["text"], "重试成功")

    async def test_interrupted_upload_never_commits_partial_audio(self):
        async def broken_stream():
            yield self.audio[:50]
            raise RuntimeError("模拟客户端断线")

        with self.assertRaisesRegex(RuntimeError, "模拟客户端断线"):
            await self.client.post("/api/recordings/rec_test_broken", content=broken_stream(), headers={"content-type": "audio/wav"})
        self.assertEqual(self.service.records(), [])
        self.assertEqual(list((self.directory / "data" / "recordings").iterdir()), [])
        self.assertEqual((await self.upload("rec_test_broken")).status_code, 200)

    async def test_restart_recovers_processing_and_archive_path_survives_settings_change(self):
        await self.upload()
        before = await self.wait_status("waiting_config")
        await self.service.stop()
        self.service.update(before["id"], status="processing")
        self.service = self.new_service()
        await self.service.start()
        after = await self.wait_status("waiting_config")
        self.assertEqual(after["raw_path"], before["raw_path"])
        config = self.service.config()
        config["archive_dir"] = str(self.directory / "new")
        data = self.service.read_settings()
        data["external_asr"] = config
        self.service.write_settings(data)
        self.assertEqual(Path(self.service.find(before["id"])["raw_path"]).read_bytes(), self.audio)

    async def test_invalid_upload_and_invalid_settings(self):
        self.assertEqual((await self.client.post("/api/recordings/invalid", content=self.audio, headers={"content-type": "audio/wav"})).status_code, 400)
        self.assertEqual((await self.client.post("/api/recordings/rec_test_001", content=self.audio, headers={"content-type": "text/plain"})).status_code, 415)
        self.assertEqual((await self.client.post("/api/recordings/rec_test_001", content=self.audio, headers={"content-type": "audio/wav", "content-length": str(MAX_AUDIO_BYTES + 1)})).status_code, 413)
        self.assertEqual((await self.upload(audio=b"")).status_code, 400)
        self.assertEqual((await self.client.put("/api/asr-settings", json={"api_url": "file:///tmp/audio"})).status_code, 400)
        self.assertEqual((await self.client.put("/api/asr-settings", json={"api_key": "bad\nkey"})).status_code, 400)
        self.assertEqual((await self.client.put("/api/asr-settings", json={"timeout_seconds": 0})).status_code, 400)

    async def test_prompt_settings_reader_preserves_audio_and_custom_fields(self):
        import importlib
        module = importlib.import_module("prompt_service.app")
        with patch.object(module, "SETTINGS_PATH", self.settings_path):
            data = module._read_settings()
            data["external_asr"] = {"api_key": "test-key"}
            data["recordings"] = [{"id": "rec_preserved"}]
            module._write_settings(data)
            data = module._read_settings()
            data["prompts"].append({"id": "new"})
            module._write_settings(data)
            saved = module._read_settings()
        self.assertEqual(saved["recordings"], [{"id": "rec_preserved"}])
        self.assertEqual(saved["external_asr"]["api_key"], "test-key")


if __name__ == "__main__":
    unittest.main()
