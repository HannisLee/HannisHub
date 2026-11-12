# 聊天大厅素材来源与许可证

本目录全部素材仅供 HannisHub「聊天大厅」场景使用，来源与授权如下。

## 办公室素材（office/）

- 来源：Rubber Studio — Modern Office Tileset 16x16 (Free Sample)
  https://rubberstudio.itch.io/modern-office-tileset-16x16-free-sample
- 许可：见 `office/LICENSE.txt`。可免费用于商业与非商业游戏及互动项目，允许修改；
  不得作为素材包单独转售或再分发。本项目将其作为内置场景资源使用，并保留原始许可证。
- 内容：`office/tiles/`、`office/objects/` 为素材包原始 PNG（28 件）。
- 派生文件（本项目修改/拼接，仍受上述许可约束）：
  - `office/tiles/wall_upper.png`：由 `wall_lower.png` 去除踢脚线生成的纯墙面砖，用于加高上墙。
  - `office/tiles_sheet.png`：9 块地板/墙砖横向拼接的图集，供 Phaser tilemap 使用。
    索引顺序：1 木地板、2 地毯、3 瓷砖、4 墙面(带踢脚线)、5 墙顶、6 墙身、7 墙左端、8 墙右端、9 纯墙面。

## 人物素材（npc/）

- 来源：5yvalia — 12x16 Top Down NPCs (Spritesheet)
  https://5yvalia.itch.io/rpg-type-retro-top-down-npc-sprites
- 许可：CC0（Creative Commons Zero），可免费用于任何项目（含商业），允许修改，无需署名。
- 内容：`12x16-retro-rpg-topdown-npc-parts.png`（部件表）、
  `12x16-retro-rpg-topdown-npc-samples.png`（成品角色表）、`[GUIDE].pdf`（布局指南）均为原始文件。
- 派生文件：`npc/player.png` — 取成品表第 1 行男性角色（10 帧：南 3 / 北 3 / 侧 4），
  将原 4 色灰阶palette重映射为暖色（轮廓 #2B2019、发色 #5E3E28、上衣 #D97757、肤色 #F2C9A0），
  与办公室暖色风格及 HannisHub 品牌色协调。侧向帧朝左，朝右时水平翻转。

## 说明

- 两套素材均从 itch.io 官方页面下载，未使用第三方镜像。
- Limezu Modern Interiors（https://limezu.itch.io/moderninteriors）为付费素材，本轮未使用；
  如需扩展更多家具可购买后替换，接口保持不变。