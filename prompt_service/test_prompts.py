"""提示词归档收藏与置顶排序的回归检查。"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from prompt_service import app as prompt_app


class PromptFavoriteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings_path = Path(self.temp.name) / "settings.json"
        self.settings_path.write_text(
            json.dumps(
                {
                    "prompts": [
                        {
                            "id": "prompt_old",
                            "content": "旧提示词",
                            "raw_content": "旧提示词",
                            "polished_content": "",
                            "group_id": "",
                            "created_at": "2026-10-01T00:00:00+00:00",
                            "updated_at": "2026-10-01T00:00:00+00:00",
                        },
                        {
                            "id": "prompt_new",
                            "content": "新提示词",
                            "raw_content": "新提示词",
                            "polished_content": "",
                            "group_id": "",
                            "created_at": "2026-10-02T00:00:00+00:00",
                            "updated_at": "2026-10-02T00:00:00+00:00",
                        },
                    ],
                    "groups": [],
                    "custom": "保留自定义字段",
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.settings_patch = patch.object(prompt_app, "SETTINGS_PATH", self.settings_path)
        self.settings_patch.start()
        self.server = FastAPI()
        self.server.include_router(prompt_app.router, prefix="/api")
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.server),
            base_url="http://test",
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        self.settings_patch.stop()
        self.temp.cleanup()

    def read_settings(self):
        return json.loads(self.settings_path.read_text(encoding="utf-8"))

    async def test_favorite_is_pinned_and_fields_are_preserved(self):
        response = await self.client.put(
            "/api/prompts/prompt_old/favorite",
            json={"favorite": True},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["favorite"])

        listed = (await self.client.get("/api/prompts")).json()["prompts"]
        self.assertEqual(
            [item["id"] for item in listed],
            ["prompt_old", "prompt_new"],
        )
        saved = self.read_settings()
        self.assertTrue(saved["prompts"][0]["favorite"])
        self.assertFalse(saved["prompts"][1].get("favorite", False))
        self.assertEqual(saved["custom"], "保留自定义字段")
        self.assertEqual(saved["prompts"][0]["updated_at"], "2026-10-01T00:00:00+00:00")

        response = await self.client.put(
            "/api/prompts/prompt_old/favorite",
            json={"favorite": False},
        )
        self.assertEqual(response.status_code, 200)
        listed = (await self.client.get("/api/prompts")).json()["prompts"]
        self.assertEqual(
            [item["id"] for item in listed],
            ["prompt_new", "prompt_old"],
        )

    async def test_new_prompt_defaults_to_unfavorite(self):
        response = await self.client.post(
            "/api/prompts",
            json={"content": "新归档", "raw_content": "新归档", "polished_content": ""},
        )
        self.assertEqual(response.status_code, 201)
        self.assertFalse(response.json()["favorite"])
        item = next(
            current for current in self.read_settings()["prompts"]
            if current["id"] == response.json()["id"]
        )
        self.assertFalse(item["favorite"])

    async def test_invalid_favorite_payload_and_missing_prompt(self):
        response = await self.client.put(
            "/api/prompts/prompt_old/favorite",
            json={"favorite": "true"},
        )
        self.assertEqual(response.status_code, 400)
        response = await self.client.put(
            "/api/prompts/prompt_missing/favorite",
            json={"favorite": True},
        )
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
