"""本机 ASR 转写保护逻辑的回归检查。"""

import unittest
import asyncio
import json
import tempfile
import threading
from types import SimpleNamespace

import httpx
from starlette.requests import Request
from pathlib import Path
from unittest.mock import patch

from model_manager.app import _asr_extract_text, _asr_max_completion_tokens
import model_manager.app as app
from core import database


class TempDatabaseMixin:
    """每个用例使用独立的临时 SQLite 库与任务目录，绝不触碰线上 data/。"""

    def setUp(self):
        super().setUp()
        self._db_dir = tempfile.TemporaryDirectory()
        self.root = Path(self._db_dir.name)
        env = patch.dict("os.environ", {"HANNISHUB_DB_PATH": str(self.root / "test.db")})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(self._db_dir.cleanup)
        for name, value in (("ASR_JOB_DIR", self.root / "jobs"),
                            ("LEGACY_ASR_HISTORY_DIR", self.root / "legacy" / "asr_history"),
                            ("LEGACY_ASR_JOB_DIR", self.root / "legacy" / "asr_jobs")):
            patcher = patch.object(app, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        owner = patch.object(app, "_asr_request_owner", return_value="alice")
        owner.start()
        self.addCleanup(owner.stop)


class AsrHelperTests(unittest.TestCase):
    def test_completion_token_limit_follows_chunk_duration(self):
        self.assertEqual(_asr_max_completion_tokens(0), 256)
        self.assertEqual(_asr_max_completion_tokens(60), 720)
        self.assertEqual(_asr_max_completion_tokens(600), 7200)
        self.assertEqual(_asr_max_completion_tokens(10000), 8192)

    def test_extract_text_removes_protocol_marker(self):
        response = {"text": "language zh<asr_text> 今天的项目会议纪要。"}
        self.assertEqual(_asr_extract_text(response), "今天的项目会议纪要。")

    def test_repetitive_noise_output_is_ignored(self):
        response = {"text": "language English<asr_text>" + "Yeah. " * 1000}
        self.assertEqual(_asr_extract_text(response), "")

    def test_normal_long_text_is_preserved(self):
        text = "".join(chr(index) for index in range(200, 700))
        self.assertEqual(_asr_extract_text({"text": text}), text)

    def test_normal_long_english_transcript_is_preserved(self):
        text = (
            "So actually, I ask you to create some overview slides of every meeting. "
            "You can use that as this. First we talk about the static dataset result, "
            "and then we focus on the dynamic things. The light direction optimization "
            "improves the reconstruction because shadows provide strong constraints."
        ) * 3
        self.assertTrue(_asr_extract_text({"text": text}))


class AsrReadinessTests(unittest.TestCase):
    def test_waits_for_healthy_current_service(self):
        item = {"pid": 123, "port": 8000}
        next_item = {"pid": 456, "port": 8001}
        progress = []
        client = unittest.mock.MagicMock()
        client.get.side_effect = [httpx.ConnectError("尚未监听"), SimpleNamespace(is_success=False), SimpleNamespace(is_success=True)]
        with patch.object(app, "_get_asr_service_item", side_effect=[item, item, next_item]), \
                patch.object(app.httpx, "Client") as client_class, \
                patch.object(app.time, "sleep"):
            client_class.return_value.__enter__.return_value = client
            result = app._wait_for_asr_ready(lambda *args: progress.append(args))
        self.assertEqual(result, next_item)
        self.assertEqual(client.get.call_count, 3)
        self.assertEqual(client.get.call_args.args[0], "http://127.0.0.1:8001/health")
        self.assertEqual(progress[0][0], "queued")

    def test_transcription_does_not_process_before_readiness(self):
        with patch.object(app, "_wait_for_asr_ready", side_effect=RuntimeError("服务未就绪")), \
                patch.object(app, "_asr_probe_duration") as probe:
            with self.assertRaisesRegex(RuntimeError, "服务未就绪"):
                app._transcribe_qwen3_asr({}, Path("audio"), Path("work"))
            probe.assert_not_called()

    def test_timeout_preserves_audio_and_records_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            work_dir = Path(directory)
            audio = work_dir / "audio.m4a"
            audio.write_bytes(b"audio")
            with patch.object(app, "ASR_READY_TIMEOUT_SECONDS", 0), \
                    patch.object(app, "_get_asr_service_item", side_effect=app.HTTPException(404)), \
                    patch.object(app, "_update_asr_history_record") as update:
                app._run_asr_history_task("asr_failed", {}, audio, work_dir)
            self.assertTrue(audio.is_file())
            self.assertIn("超时", update.call_args.args[1]["error"])
            self.assertEqual(update.call_args.args[1]["status"], "error")


class AsrUploadTests(TempDatabaseMixin, unittest.IsolatedAsyncioTestCase):
    async def test_disconnected_upload_is_marked_as_failed(self):
        messages = iter([
            {"type": "http.request", "body": b"part", "more_body": True},
            {"type": "http.disconnect"},
        ])
        async def receive():
            return next(messages)
        request = Request({"type": "http", "method": "POST", "path": "/", "headers": [
            (b"content-length", b"10"), (b"x-audio-filename", b"test.m4a"),
        ]}, receive)
        response = await app.transcribe_with_qwen3_asr(request)
        record = app._asr_history_snapshots("alice")[0]
        self.assertEqual(response.status_code, 400)
        self.assertEqual(record["status"], "error")
        self.assertIn("重新上传", record["error"])
        partial = app.ASR_JOB_DIR / record["id"] / "audio.m4a"
        self.assertEqual(partial.read_bytes(), b"part")
        app._delete_asr_history_record(record["id"], "alice")
        self.assertFalse(partial.exists())

    async def test_cancelled_upload_is_marked_as_failed(self):
        async def receive():
            raise asyncio.CancelledError()
        request = Request({"type": "http", "method": "POST", "path": "/", "headers": []}, receive)
        with self.assertRaises(asyncio.CancelledError):
            await app.transcribe_with_qwen3_asr(request)
        record = app._asr_history_snapshots("alice")[0]
        self.assertEqual(record["status"], "error")
        self.assertIn("重新上传", record["error"])

    async def test_upload_before_start_is_queued_until_ready(self):
        tasks = set()
        entered = threading.Event()
        ready = threading.Event()
        def wait_ready(on_progress):
            on_progress("queued", 0, "正在等待 ASR 服务初始化完成")
            entered.set()
            if not ready.wait(5):
                raise RuntimeError("测试等待超时")
            return {"pid": 123, "port": 8000}
        def transcribe(item, input_path, work_dir, on_progress):
            selected = app._wait_for_asr_ready(on_progress)
            self.assertEqual(selected["pid"], 123)
            return {"duration": 1, "chunks": 1, "text": "测试"}
        with patch.object(app, "_asr_background_tasks", tasks), \
                patch.object(app, "_wait_for_asr_ready", side_effect=wait_ready), \
                patch.object(app, "_transcribe_qwen3_asr", side_effect=transcribe):
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url="http://test") as client:
                    response = await client.post("/api/asr/transcriptions", content=b"audio", headers={"x-audio-filename": "test.m4a"})
                    self.assertEqual(response.status_code, 202)
                    self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                    record_id = response.json()["record"]["id"]
                    record = app._find_asr_history_record(record_id)
                    self.assertEqual(record["status"], "queued")
                    self.assertIn("等待 ASR", record["progress_detail"])
                    ready.set()
                    await asyncio.gather(*list(tasks))
                    self.assertEqual(app._find_asr_history_record(record_id)["status"], "completed")
                    text = await client.get(f"/api/asr/history/{record_id}/text")
                    self.assertEqual(text.json()["text"], "测试")
            finally:
                ready.set()
                if tasks:
                    await asyncio.gather(*list(tasks))


def _insert_asr(record_id: str, owner: str, status: str, filename: str = "a.m4a", transcript: str | None = None):
    with database.connect() as conn:
        conn.execute(
            "INSERT INTO asr_records(id, owner, name, original_filename, uploaded_at, status, transcript) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (record_id, owner, record_id, filename, 1.0, status, transcript),
        )


class AsrIsolationTests(TempDatabaseMixin, unittest.IsolatedAsyncioTestCase):
    async def test_other_account_cannot_see_or_touch_records(self):
        _insert_asr("asr_alice", "alice", "completed", transcript="alice 的全文")
        _insert_asr("asr_bob", "bob", "completed", transcript="bob 的全文")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url="http://test") as client:
            listed = (await client.get("/api/asr/history")).json()["records"]
            self.assertEqual([item["id"] for item in listed], ["asr_alice"])
            self.assertEqual((await client.get("/api/asr/history/asr_bob/text")).status_code, 404)
            self.assertEqual((await client.patch("/api/asr/history/asr_bob", json={"name": "x"})).status_code, 404)
            self.assertEqual((await client.delete("/api/asr/history/asr_bob")).status_code, 404)
            self.assertEqual((await client.get("/api/asr/history/asr_alice/text")).json()["text"], "alice 的全文")
        self.assertEqual(app._find_asr_history_record("asr_bob")["name"], "asr_bob")

    async def test_extraction_prompt_is_per_account(self):
        with patch.object(app.ai_settings, "get_asr_extraction_prompt", return_value="管理员默认"), \
                patch.object(app.ai_settings, "save_asr_extraction_prompt") as admin_save:
            self.assertEqual(app._get_asr_extraction_prompt("alice"), "管理员默认")
            self.assertEqual(app._save_asr_extraction_prompt("alice", " alice 的提示词 "), "alice 的提示词")
            self.assertEqual(app._get_asr_extraction_prompt("alice"), "alice 的提示词")
            self.assertEqual(app._get_asr_extraction_prompt("bob"), "管理员默认")
            admin_save.assert_not_called()
            app._save_asr_extraction_prompt(app.ADMIN_USERNAME, "新默认")
            admin_save.assert_called_once_with("新默认")

    async def test_purge_user_removes_records_and_audio(self):
        record_id = "asr_" + "a" * 32
        _insert_asr(record_id, "bob", "error")
        (app.ASR_JOB_DIR / record_id).mkdir(parents=True)
        (app.ASR_JOB_DIR / record_id / "audio.m4a").write_bytes(b"x")
        _insert_asr("asr_alice", "alice", "completed")
        self.assertEqual(app.purge_asr_user("bob"), 1)
        self.assertFalse((app.ASR_JOB_DIR / record_id).exists())
        self.assertEqual(len(app._asr_history_snapshots("alice")), 1)


class AsrMigrationTests(TempDatabaseMixin, unittest.TestCase):
    def test_legacy_shared_history_moves_to_admin(self):
        legacy = app.LEGACY_ASR_HISTORY_DIR
        legacy.mkdir(parents=True)
        (legacy / "asr_one.txt").write_text("第一条全文", encoding="utf-8")
        (legacy / "asr_one.extracted.txt").write_text("提炼", encoding="utf-8")
        (legacy / "records.json").write_text(json.dumps({"records": [
            {"id": "asr_one", "name": "一", "uploaded_at": 2, "status": "completed", "text_length": 5,
             "transcript_file": "asr_one.txt", "extraction_file": "asr_one.extracted.txt"},
            {"id": "asr_two", "name": "二", "uploaded_at": 1, "status": "error", "transcript_file": "asr_two.txt"},
        ]}), encoding="utf-8")
        (app.LEGACY_ASR_JOB_DIR / "asr_two").mkdir(parents=True)
        (app.LEGACY_ASR_JOB_DIR / "asr_two" / "audio.m4a").write_bytes(b"x")

        self.assertEqual(app.migrate_legacy_asr_storage(), 2)
        admin = app._asr_history_snapshots(app.ADMIN_USERNAME)
        self.assertEqual([item["id"] for item in admin], ["asr_one", "asr_two"])
        self.assertTrue(admin[0]["has_extraction"])
        self.assertFalse(admin[1]["has_extraction"])
        self.assertEqual(app._find_asr_history_record("asr_one")["transcript"], "第一条全文")
        self.assertEqual(app._asr_history_snapshots("bob"), [])
        self.assertTrue((app.ASR_JOB_DIR / "asr_two" / "audio.m4a").is_file())
        self.assertFalse(legacy.exists())
        self.assertTrue(legacy.with_name("asr_history.migrated").is_dir())
        # 再次执行不重复导入
        self.assertEqual(app.migrate_legacy_asr_storage(), 0)


class AsrRecoveryTests(TempDatabaseMixin, unittest.IsolatedAsyncioTestCase):
    async def test_interrupted_tasks_are_requeued_after_service_ready(self):
        (app.ASR_JOB_DIR / "asr_active").mkdir(parents=True)
        (app.ASR_JOB_DIR / "asr_active" / "audio.m4a").write_bytes(b"audio")
        _insert_asr("asr_active", "alice", "transcribing", "active.m4a")
        _insert_asr("asr_missing", "bob", "queued", "missing.m4a")
        _insert_asr("asr_done", "alice", "completed", "done.m4a")
        tasks = set()
        processed = []

        def run_task(record_id, item, input_path, work_dir):
            processed.append((record_id, input_path, work_dir))

        with patch.object(app, "_asr_background_tasks", tasks), \
                patch.object(app, "_run_asr_history_task", side_effect=run_task):
            count = await app.recover_interrupted_asr_tasks()
            self.assertEqual(count, 1)
            await asyncio.gather(*list(tasks))

        self.assertEqual(app._find_asr_history_record("asr_active")["status"], "queued")
        self.assertEqual(app._find_asr_history_record("asr_missing")["status"], "error")
        self.assertEqual(app._find_asr_history_record("asr_done")["status"], "completed")
        self.assertEqual(processed[0][0], "asr_active")

    async def test_interrupted_upload_is_not_recovered_as_complete_audio(self):
        job = app.ASR_JOB_DIR / "asr_upload"
        job.mkdir(parents=True)
        (job / "audio.m4a").write_bytes(b"partial")
        _insert_asr("asr_upload", "alice", "uploading", "test.m4a")
        with patch.object(app, "_run_asr_history_task") as run:
            self.assertEqual(await app.recover_interrupted_asr_tasks(), 0)
            record = app._asr_history_snapshots("alice")[0]
            self.assertEqual(record["status"], "error")
            self.assertIn("重新上传", record["error"])
            run.assert_not_called()
            self.assertEqual((job / "audio.m4a").read_bytes(), b"partial")

    def test_failed_task_keeps_original_audio_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            work_dir = Path(directory)
            audio = work_dir / "audio.m4a"
            chunk = work_dir / "chunk-001.flac"
            audio.write_bytes(b"audio")
            chunk.write_bytes(b"chunk")
            with patch.object(app, "_make_asr_progress_reporter", return_value=lambda *args: None), \
                    patch.object(app, "_transcribe_qwen3_asr", side_effect=RuntimeError("连接失败")), \
                    patch.object(app, "_update_asr_history_record"), \
                    patch.object(app, "_complete_asr_history_record"):
                app._run_asr_history_task("asr_failed", {"pid": 123}, audio, work_dir)
            self.assertTrue(audio.is_file())
            self.assertFalse(chunk.exists())


if __name__ == "__main__":
    unittest.main()
