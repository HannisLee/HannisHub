"""本机 ASR 转写保护逻辑的回归检查。"""

import unittest
import asyncio
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from llama_manager.app import _asr_extract_text, _asr_max_completion_tokens
import llama_manager.app as app


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


class AsrRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_interrupted_tasks_are_requeued_after_service_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            history_dir = root / "history"
            jobs_dir = root / "jobs"
            history_dir.mkdir()
            (jobs_dir / "asr_active").mkdir(parents=True)
            (jobs_dir / "asr_active" / "audio.m4a").write_bytes(b"audio")
            (history_dir / "records.json").write_text(json.dumps({"records": [
                {"id": "asr_active", "status": "transcribing", "original_filename": "active.m4a"},
                {"id": "asr_missing", "status": "queued", "original_filename": "missing.m4a"},
                {"id": "asr_done", "status": "completed", "original_filename": "done.m4a"},
            ]}), encoding="utf-8")
            tasks = set()
            processed = []

            def run_task(record_id, item, input_path, work_dir):
                processed.append((record_id, item["pid"], input_path, work_dir))

            with patch.object(app, "ASR_HISTORY_DIR", history_dir), \
                    patch.object(app, "ASR_HISTORY_INDEX_PATH", history_dir / "records.json"), \
                    patch.object(app, "ASR_JOB_DIR", jobs_dir), \
                    patch.object(app, "_asr_background_tasks", tasks), \
                    patch.object(app, "_get_asr_service_item", return_value={"pid": 123, "port": 8000}), \
                    patch.object(app, "_run_asr_history_task", side_effect=run_task):
                count = await app.recover_interrupted_asr_tasks()
                self.assertEqual(count, 1)
                await asyncio.gather(*list(tasks))

            records = json.loads((history_dir / "records.json").read_text(encoding="utf-8"))["records"]
            self.assertEqual(records[0]["status"], "queued")
            self.assertEqual(records[1]["status"], "error")
            self.assertEqual(records[2]["status"], "completed")
            self.assertEqual(processed[0][0], "asr_active")
            self.assertEqual(processed[0][1], 123)


if __name__ == "__main__":
    unittest.main()
