"""OCR 识别记录：SQLite 存储、按账号隔离与旧版 JSON 迁移。全部使用临时库与临时目录。"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from core import database
from model_manager import ocr_records


def _upload_request(filename: str, body: bytes) -> Request:
    chunks = iter([{"type": "http.request", "body": body, "more_body": False}])

    async def receive():
        return next(chunks)

    return Request({"type": "http", "method": "POST", "path": "/api/ocr/records", "headers": [
        (b"content-length", str(len(body)).encode()), (b"x-file-name", filename.encode()),
    ]}, receive)


class OcrRecordsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        root = Path(self._dir.name)
        for patcher in (
            patch.dict("os.environ", {"HANNISHUB_DB_PATH": str(root / "test.db")}),
            patch.object(ocr_records, "OCR_FILES_DIR", root / "ocr_files"),
            patch.object(ocr_records, "LEGACY_OCR_DATA_DIR", root / "ocr_records"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.root = root

    async def _create(self, owner: str, filename: str = "票据.png") -> dict:
        async def fake_run(username, record_id):
            ocr_records._update(record_id, {"status": "completed", "result": f"{owner} 的结果", "chars": 5})

        with patch.object(ocr_records, "request_username", return_value=owner), \
                patch.object(ocr_records, "_run", side_effect=fake_run):
            record = await ocr_records.create_record(_upload_request(filename, b"PNGDATA"), "document", "", "")
            for task in list(ocr_records._tasks):
                await task
        return record

    async def test_records_are_isolated_per_account(self):
        alice = await self._create("alice")
        bob = await self._create("bob")
        self.assertEqual([item["id"] for item in ocr_records.list_records("alice")], [alice["id"]])
        self.assertNotIn("result", ocr_records.list_records("alice")[0])
        self.assertNotIn("owner", ocr_records.list_records("alice")[0])
        self.assertEqual(ocr_records.read_text("alice", alice["id"])["text"], "alice 的结果")
        for action in (
            lambda: ocr_records.read_text("alice", bob["id"]),
            lambda: ocr_records.source_path("alice", bob["id"]),
            lambda: ocr_records.rename_record("alice", bob["id"], "改名"),
            lambda: ocr_records.delete_record("alice", bob["id"]),
        ):
            with self.assertRaises(HTTPException) as caught:
                action()
            self.assertEqual(caught.exception.status_code, 404)
        path, media_type, _ = ocr_records.source_path("bob", bob["id"])
        self.assertEqual(path.read_bytes(), b"PNGDATA")
        self.assertEqual(media_type, "image/png")
        # 文件平铺在 ocr_files/<记录 ID>/，不再按用户分目录
        self.assertEqual(path.parent, self.root / "ocr_files" / bob["id"])

    async def test_delete_and_purge(self):
        alice = await self._create("alice")
        bob = await self._create("bob")
        ocr_records.delete_record("alice", alice["id"])
        self.assertEqual(ocr_records.list_records("alice"), [])
        self.assertFalse((self.root / "ocr_files" / alice["id"]).exists())
        self.assertEqual(ocr_records.purge_user("bob"), 1)
        self.assertFalse((self.root / "ocr_files" / bob["id"]).exists())

    async def test_recover_marks_active_records_failed(self):
        record = await self._create("alice")
        ocr_records._update(record["id"], {"status": "running"})
        ocr_records.recover_interrupted()
        self.assertEqual(ocr_records.list_records("alice")[0]["status"], "error")

    def test_legacy_storage_moves_to_admin(self):
        record_id = "0" * 32
        user_dir = self.root / "ocr_records" / "somehash"
        (user_dir / record_id).mkdir(parents=True)
        (user_dir / record_id / "source.pdf").write_bytes(b"%PDF")
        (user_dir / record_id / "result.md").write_text("# 协议", encoding="utf-8")
        (user_dir / "records.json").write_text(json.dumps([{
            "id": record_id, "name": "协议.pdf", "filename": "协议.pdf", "extension": "pdf", "kind": "pdf",
            "size": 4, "task": "document", "status": "completed", "progress": 100, "chars": 4,
            "created_at": "2026-11-13T14:44:07+09:00", "updated_at": "2026-11-13T14:44:11+09:00", "pages": 2,
        }]), encoding="utf-8")

        self.assertEqual(ocr_records.migrate_legacy_storage(), 1)
        admin = ocr_records.ADMIN_USERNAME
        self.assertEqual(ocr_records.read_text(admin, record_id)["text"], "# 协议")
        self.assertEqual(ocr_records.source_path(admin, record_id)[0].read_bytes(), b"%PDF")
        self.assertEqual(ocr_records.list_records("bob"), [])
        self.assertFalse((self.root / "ocr_records").exists())
        self.assertTrue((self.root / "ocr_records.migrated" / "somehash" / "records.json").is_file())
        self.assertEqual(ocr_records.migrate_legacy_storage(), 0)

    def test_schema_version_recorded(self):
        with database.connect() as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], len(database._MIGRATIONS))
            self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "wal")


if __name__ == "__main__":
    unittest.main()
