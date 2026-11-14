# ChatWorld 资产速查索引

> 本目录存放聊天大厅（ChatWorld）使用的美术素材原件。**除本文件外全部不入库**（`.gitignore` 已排除 `chatworld/asset/*`）。
> 素材为付费包 **Limezu — Modern Interiors**（https://limezu.itch.io/moderninteriors），用户已购买；
> 允许商用与修改，**禁止单独转售或再分发原件，使用时需署名 limezu.itch.io**，许可证全文见 `modern_interiors/LICENSE.txt`。
> 原始压缩包：项目根目录 `4265_moderninteriors.zip`（不入库）。整理时仅调整了外层目录，包内官方目录名保持原样，便于对照官方说明与 `frontend/public/chat-lobby/CREDITS.md`。

## 1. 目录总览

所有路径相对 `chatworld/asset/modern_interiors/`。

| 路径 | 文件数 | 大小 | 内容 |
|---|---:|---:|---|
| `1_Interiors/` | 48226 | 222M | 室内砖块与家具：房间构建器、26 个主题家具表及单件拆图 |
| `2_Characters/` | 2706 | 90M | 角色生成器分层部件、20 个预制角色、旧版单人角色 |
| `3_Animated_objects/` | 1870 | 11M | 约 310 种动画物件（门、电视、宠物、厨具…），PNG 帧条 + GIF 预览 |
| `4_User_Interface_Elements/` | 30 | 272K | UI 面板、情绪气泡、计时器等动画 |
| `6_Home_Designs/` | 132 | 2.8M | 8 套官方预拼房间（分层 PNG + 预览图） |
| `Palettes/` | 2 | 12K | 官方调色板 |
| `rpg_maker/` | 500 | 10M | RPG Maker MV / XP / VX Ace（WIP）适配版素材与导入说明 |
| `tools/character_generator/` | 1632 | 291M | 官方角色生成器 2.0：`linux/`（Unity 程序，可执行文件 `Character Generator 2.0.x86_64`）与 `windows_setup.exe` |
| `READ_ME.txt` / `THIRD-PARTY TOOLS.txt` | — | — | 官方说明 |

### 分辨率约定

`1_Interiors`、`3_Animated_objects`、`2_Characters/Character_Generator/*`、`6_Home_Designs/*` 都按 **16x16 / 32x32 / 48x48** 三档平行存放，内容一致只是像素放大。
聊天大厅当前统一使用 **16x16 档**（游戏内整数倍放大）。注意 32/48 档的子目录名带后缀，如 `1_Interiors/32x32/Theme_Sorter_32x32/`（官方拼写错误：`Room_Bulder_subfiles_32x32`）。

## 2. 室内素材 `1_Interiors/16x16/`

| 文件 / 目录 | 用途 |
|---|---|
| `Room_Builder_16x16.png`（1216×1808） | 房间构建总表：地板、墙面、墙顶、踢脚线、门洞等 |
| `Room_Builder_subfiles/` | 总表拆分：`Walls`、`Floors`、`borders`、`Baseboards`、`3d_walls`、`Arched_Entryways`、`Floor_Paths`、`Floor_Shadows`、`Floor_Connectors` |
| `Interiors_16x16.png`（256×17024） | 全部家具的超长总表 |
| `Theme_Sorter/` | 按主题分类的家具表，共 26 张（`1_Generic`…`26_Condominium`），**先看这里挑家具** |
| `Theme_Sorter_Singles/` | 主题家具拆成单件 PNG（带默认阴影），文件名形如 `Living_Room_Singles_12.png`，编号无语义，需对照图片 |
| `Theme_Sorter_Shadowless(_Singles)/` | 同上，无阴影版本 |
| `Theme_Sorter_Black_Shadow(_Singles)/` | 同上，黑色阴影版本 |
| `Old stuff/` | 旧版 `Tileset_16x16_*.png`、`Floors_only`、`Colored_ceilings` 等，兼容用 |

主题单件数量（`Theme_Sorter_Singles/`，16x16）：

| 主题目录 | 单件数 |
|---|---:|
| `2_Living_Room_Singles` | 122 |
| `3_Bathroom_Singles` | 159 |
| `4_Bedroom_Singles` | 556 |
| `5_Classroom_and_Library_Singles` | 75 |
| `6_Music_and_Sport` | 249 |
| `7_Art_Singles` | 46 |
| `8_Gym_Singles` | 209 |
| `9_Fishing_Singles` | 77 |
| `10_Birthday_Party_Singles` | 46 |
| `11_Halloween_Singles` | 240 |
| `12_Kitchen_Singles` | 408 |
| `13_Conference_Hall_Singles` | 68 |
| `14_Basement_Singles` | 246 |
| `15_Christmas_Singles` | 123 |
| `16_Grocery_Store_Singles` | 489 |
| `18_Jail_Singles` | 344 |
| `19_Hospital_SIngles` | 550 |
| `20_Japanese_Interiors_Singles` | 133 |
| `21_Clothing_Store_Singles` | 494 |
| `22_Museum_Singles` | 451 |
| `23_Television_and_Film_Studio_SIngles` | 80 |
| `24_Ice_Cream_Shop_Singles` | 102 |
| `25_Shooting_Range_Singles` | 28 |
| `26_Condominium_Singles` | 86 |

> 主题 `1_Generic` 与 `17_Visibile_Upstairs_System` 只有总表，没有单件目录。

## 3. 角色 `2_Characters/`

### 角色生成器 `Character_Generator/`（16x16 档计数）

| 目录 | 数量 | 说明 |
|---|---:|---|
| `0_Premade_Characters/` | 20 | 预制完整角色 `Premade_Character_01…20.png`（16x16 档 896×656），总览 `Premade_Characters_LIST.png` |
| `Bodies/` / `Bodies_kids/` | 9 / 4 | 身体（肤色） |
| `Eyes/` / `Eyes_kids/` | 7 / 6 | 眼睛 |
| `Outfits/` / `Outfits_kids/` | 132 / 7 | 服装 |
| `Hairstyles/` / `Hairstyles_kids/` | 200 / 30 | 发型 |
| `Accessories/` | 84 | 配饰，总览 `ACCESSORY_LIST.png` |
| `Books/` / `Smartphones/` | 6 / 5 | 手持道具动画 |

- 叠层顺序（`CHARACTER_GENERATOR.txt`）：**身体 → 眼睛 → 服装 → 发型 → 配饰**；儿童睡衣 `Outfit_kid_6_pajama_frog`、`Outfit_kid_7_pajama_tiger` 不需要发型。
- 帧布局说明见 `Spritesheet_animations_GUIDE.png`，教程见 `HOW_TO_CHARACTER_GENERATOR.png`；`.ase` 为 Aseprite 源文件。

### 旧版单人角色 `Old/Single_Characters_Legacy/16x16/`

18 个命名角色：Adam、Alex、Amelia、Ash、Bob、Bouncer、Bruce、Butcher、Dan、Edward、Lucy、Molly、Pier、Rob、Roki、Samuel、Witch、Zombie。
每人按动作拆分为 `<名字>_<动作>_16x16.png`，动作包括 `idle`、`idle_anim`、`run`、`sit`/`sit2`/`sit3`、`phone`、`reading`、`shopping_cart` 等（坐下、看手机等交互可直接取这里）。

## 4. 动画物件 `3_Animated_objects/16x16/`

- `spritesheets/`：横向帧条 PNG，**游戏内使用这个**；高度即单帧高，帧宽需按物件原生尺寸切（如 `animated_cat.png` 576×16 = 12 帧 × 48×16）。
- `gif/`：同名 GIF 预览，用于快速查看动画效果。
- 部分文件名带 `x-y loop`，表示循环播放的帧区间；个别文件名有官方拼写错误（`aniamted_`、`animeted_`）。

以下为去掉 `animated_` 前缀后的全部名称（按关键词分组）：

**门 / 电梯 / 扶梯**（68）：`door_1`、`door_1_locked`、`door_2`、`door_2_locked`、`door_3`、`door_3_locked`、`door_4`、`door_4_locked`、`door_5`、`door_5_locked`、`door_6`、`door_6_locked`、`door_big_1`、`door_big_1_locked`、`door_big_2`、`door_big_2_locked`、`door_big_3`、`door_big_3_locked`、`door_big_4`、`door_big_4_locked`、`door_big_5`、`door_big_5_locked`、`door_big_6`、`door_big_6_locked`、`door_condominium`、`door_condominium_2`、`door_glass_double`、`door_glass_left`、`door_glass_right`、`door_glass_vertical_left`、`door_glass_vertical_right`、`door_prison`、`door_prison_cell`、`door_sliding_glass`、`door_vertical_left_1`、`door_vertical_left_2`、`door_vertical_left_3`、`door_vertical_right_1`、`door_vertical_right_2`、`door_vertical_right_3`、`elevator_door_entrance_1`、`elevator_door_entrance_2`、`elevator_door_exit`、`emergency_exit`、`escalator_down`、`escalator_up`、`fitting_room_curtain`、`grocery_store_butchershop_cool_room_door`、`hospital_door_blue`、`hospital_door_green`、`hospital_door_green_double`、`hospital_glass_door`、`hospital_surgery_door`、`hospital_xraycabin_door`、`hospital_xraycabin_door_2`、`japanese_sliding_door`、`morgue_freezer_door_corpse_3`、`morgue_freezer_door_corpse_4`、`morgue_freezer_door_empty`、`morgue_freezer_door_no_corpse`、`museum_ticket_office_door_back`、`museum_ticket_office_door_front`、`museum_ticket_turnstile`、`museum_ticket_turnstile_vertical`、`public_toilet_door`、`trapdoor_1`、`trapdoor_2`、`trapdoor_3`

**厨房 / 冰箱 / 餐饮**（40）：`canteen_big_fridge_cake`、`canteen_big_fridge_empty`、`canteen_big_fridge_empty_left`、`canteen_counter`、`canteen_fridge_cake_1`、`canteen_fridge_cake_2`、`canteen_fridge_cake_3`、`canteen_fridge_empty`、`coffee`、`fridge`、`fridge_grey`、`fridge_grey_vertical_left`、`fridge_grey_vertical_right`、`fridge_white_vertical_left`、`fridge_white_vertical_right`、`grocery_store_bakery_industrial_fridge_both`、`grocery_store_bakery_industrial_fridge_left`、`grocery_store_bakery_industrial_fridge_right`、`grocery_store_bakery_industrial_oven_down`、`grocery_store_bakery_industrial_oven_up`、`grocery_store_fridge2_glass_left`、`grocery_store_fridge2_glass_right`、`grocery_store_fridge_glass_both`、`grocery_store_fridge_glass_left`、`grocery_store_fridge_glass_right`、`kitchen_bbq`、`kitchen_drawer_1`、`kitchen_drawer_2`、`kitchen_drawer_3`、`kitchen_kneader`、`kitchen_oven`、`kitchen_oven_1cookers`、`kitchen_oven_2cookers`、`kitchen_oven_3cookers`、`kitchen_oven_4cookers`、`kitchen_pan_with_omelette`、`kitchen_sink_1`、`kitchen_sink_2`、`kitchen_sink_3`、`toaster`

**浴室 / 水槽**（22）：`bathroom_cabinet_blue_empty`、`bathroom_cabinet_blue_full`、`bathroom_cabinet_white_empty`、`bathroom_cabinet_white_full`、`bathroom_cabinet_whiteblue_empty`、`bathroom_cabinet_whiteblue_full`、`bathroom_sink_new_2_3-10 loop`、`bathroom_sink_new_3-10 loop`、`bathtub`、`bathtub_2`、`bathtub_2_new_1_4-7 loop`、`bathtub_2_new_2_4-7 loop`、`bathtub_2_new_3_4-7 loop`、`bathtub_3_new_4-7 loop`、`bathtub_new_2_6-9 loop`、`bathtub_new_6-9 loop`、`bathtub_with_duck`、`fishcuttingtable_sink`、`fishmonger_sink`、`hospital_sink_4-7 loop`、`jail_shower_4-8 loop`、`sink`

**电视 / 屏幕 / 时钟 / 电子设备**（21）：`TV_reportage`、`TV_reportage_hospital`、`TV_reportage_hospital_2`、`amplifier`、`amplifier_big`、`clothing_store_advertising_monitor`、`control_room_facebook_scrolling`、`control_room_screens`、`control_room_server`、`cuckoo_clock`、`hospital_screen_color`、`hospital_xraymachine_screen`、`hospital_xrayscreen_arm`、`hospital_xrayscreen_head`、`old_tv`、`old_tv2`、`pendulum_clock`、`security_camera_left`、`security_camera_right`、`security_camera_wall_left`、`security_camera_wall_right`

**动物 / 宠物**（22）：`butterfly`、`butterfly_1_idle`、`butterfly_2`、`butterfly_2_idle`、`butterfly_3`、`butterfly_3_idle`、`butterfly_4`、`butterfly_4_idle`、`butterfly_5`、`butterfly_5_idle`、`butterfly_6`、`butterfly_6_idle`、`butterfly_idle`、`cat`、`fishmonger_fish_tank`、`fishtank_orange`、`fishtank_red`、`frog_2_idle`、`frog_3_idle`、`frog_4_idle`、`frog_idle`、`spider`

**节日 / 派对 / 万圣节 / 灵异**（32）：`Christmas_carousel`、`Christmas_chimney`、`Christmas_jack_in_the_box`、`Christmas_snowball_globe`、`Christmas_tree_lights`、`blood_altar`、`candle`、`candle_red_left`、`candle_red_right`、`candle_wax`、`cauldron`、`glowing_pumpkin`、`haunted_bookcase`、`haunted_mirror`、`haunted_mirror_2`、`haunted_painting_doll_1`、`haunted_painting_doll_2`、`haunted_painting_doll_3`、`incense_burner_4_10_loop`、`iron_cage`、`iron_cage_doll`、`mirror_person_approaching `、`mirror_person_approaching_2`、`mirror_person_approaching_3`、`mirror_person_approaching_4`、`party_balloon_blue`、`party_balloon_green`、`party_balloon_red`、`party_balloon_yellow`、`pentacle`、`spell_book`、`wall_candle`

**商店 / 超市**（57）：`Shopping_Carts`、`grocery_store_butchershop_carcass`、`grocery_store_butchershop_carcass_stale`、`grocery_store_checkout_roller`、`grocery_store_ticket_machine`、`safe_bucks`、`safe_empty`、`safe_gold`、`shopping_cart_blue_empty_down`、`shopping_cart_blue_empty_left`、`shopping_cart_blue_empty_right`、`shopping_cart_blue_empty_up`、`shopping_cart_blue_full1_down`、`shopping_cart_blue_full1_left`、`shopping_cart_blue_full1_right`、`shopping_cart_blue_full1_up`、`shopping_cart_blue_full2_down`、`shopping_cart_blue_full2_left`、`shopping_cart_blue_full2_right`、`shopping_cart_blue_full2_up`、`shopping_cart_blue_full3_down`、`shopping_cart_blue_full3_left`、`shopping_cart_blue_full3_right`、`shopping_cart_blue_full3_up`、`shopping_cart_green_empty_down`、`shopping_cart_green_empty_left`、`shopping_cart_green_empty_right`、`shopping_cart_green_empty_up`、`shopping_cart_green_full1_down`、`shopping_cart_green_full1_left`、`shopping_cart_green_full1_right`、`shopping_cart_green_full1_up`、`shopping_cart_green_full2_down`、`shopping_cart_green_full2_left`、`shopping_cart_green_full2_right`、`shopping_cart_green_full2_up`、`shopping_cart_green_full3_down`、`shopping_cart_green_full3_left`、`shopping_cart_green_full3_right`、`shopping_cart_green_full3_up`、`shopping_cart_red_empty_down`、`shopping_cart_red_empty_left`、`shopping_cart_red_empty_right`、`shopping_cart_red_empty_up`、`shopping_cart_red_full1_down`、`shopping_cart_red_full1_left`、`shopping_cart_red_full1_right`、`shopping_cart_red_full1_up`、`shopping_cart_red_full2_down`、`shopping_cart_red_full2_left`、`shopping_cart_red_full2_right`、`shopping_cart_red_full2_up`、`shopping_cart_red_full3_down`、`shopping_cart_red_full3_left`、`shopping_cart_red_full3_right`、`shopping_cart_red_full3_up`、`tapis_roulant`

**医院 / 停尸间**（4）：`hospital_resonance_machine`、`hospital_xraymachine`、`morgue_freezer_corpse`、`morgue_freezer_corpse_2`

**博物馆 / 安防**（4）：`museum_laser_front`、`museum_laser_front_modular`、`museum_laser_horizontal`、`museum_laser_horizontal_modular`

**健身 / 运动 / 玩具**（13）：`punching_bag_left`、`punching_bag_left_2`、`punching_bag_left_3`、`punching_bag_right`、`punching_bag_right_2`、`punching_bag_right_3`、`toybox_2_full`、`toybox_empty`、`toybox_empty_2`、`toybox_full`、`toybox_full_2`、`toytrain`、`treadmill`

**场景与其他**（26）：`chimney`、`chimney_red`、`chimney_white`、`chimney_yellow`、`floating_floor_generic_middle`、`floating_floor_left`、`floating_floor_middle`、`floating_floor_right`、`jail_locker_empty`、`jail_locker_full`、`japanese_shrine`、`moldy_fruit_basket`、`receptionist`、`receptionist_2`、`receptionist_2_with_textbox`、`receptionist_with_textbox`、`trap_falling_blade`、`trap_falling_bookcase`、`trap_flipping_floor`、`trap_flipping_floor_generic`、`trap_flipping_floor_generic_with_floor`、`trap_flipping_floor_with_floor`、`wall_piano`、`wall_piano_2`、`wall_piano_3`、`wall_piano_4`

<!-- 共 309 个去重名称 -->

## 5. UI 元素 `4_User_Interface_Elements/`

- `UI_16x16.png` / `UI_32x32.png` / `UI_48x48.png`：对话框、按钮、面板等 UI 总表。
- `UI_thinking_emotes_animation_*.png`：思考气泡动画。
- `Animated_Spritesheets/`：`UI_angry_emote`、`UI_tear_drop_emote`、`UI_thinking_emote_dots`、`UI_mail`、`UI_arrow_pointing_up/down`、`UI_timer_green_to_green`、`UI_timer_green_to_red`（三档分辨率 GIF/PNG），适合做聊天气泡、未读提醒。

## 6. 官方预拼房间 `6_Home_Designs/`

8 套：`Condominium`、`Generic_Home`、`Gym`、`Ice-Cream_Shop`、`Japanese_Interiors_Home`、`Museum`、`Shooting_Range`、`TV_Studio`（目录名均带 `_Designs`）。
每套按分辨率存放 `*_layer_1.png`（地面与墙）、`*_layer_2.png`（家具层）、`*_preview.png`（合成预览）。可直接作为房间参考，或从中裁剪成套砖块。

## 7. 聊天大厅已使用的资产

聊天大厅（入口厅 + 我的房间 + 大厅）的派生素材全部由 **`scripts/build_chat_lobby_assets.py`** 从本目录生成，输出到 `frontend/public/chat-lobby/club/`（Next.js 静态资源必须放在 `frontend/public/`，已入库）。
布局（家具坐标、碰撞盒、门、传送门、机器交互区）也在该脚本中维护，改完重新运行即可。
`layout.json` / `avatar/parts.json` 中的 `build` 是输出内容哈希，前端据此给素材地址加 `?v=` 防止浏览器混用新旧缓存：

```bash
python3 scripts/build_chat_lobby_assets.py --preview /tmp/lobby_preview.png   # 需要 Pillow
```

| 派生文件 | 来源 |
|---|---|
| `room.png` 我的房间背景 | 木地板与浅绿墙面取自 Room_Builder；窗帘窗、米色地毯烘焙其中 |
| `avatar/{body,eyes,outfit,hair,accessory}.png` + `avatar/parts.json` | `2_Characters/Character_Generator/` 的 `Bodies`、`Eyes`、`Outfits`、`Hairstyles`、`Accessories`（16x16 档，共 432 件）：取第 1 行 idle、第 2 行 walk 与第 4 行 sit（右 / 左）重排为 96x320 块，每类一张图集，前端运行时叠层合成 |
| `foyer.png` / `hall.png` 房间背景 | 地板 `Room_Builder_subfiles/Room_Builder_Floors_16x16.png`、墙面 `Room_Builder_Walls_16x16.png`；墙顶收边与阴影为脚本程序化绘制；大厅上墙炫彩「HannisHub」为脚本点阵绘制（`rainbow_text`）；挂饰与地毯取自 `Theme_Sorter/1_Generic_16x16.png` 及各主题单件 |
| `objects.png` + `objects.json` 家具图集 | `Theme_Sorter_Singles/` 的 Living Room、Basement、Classroom and Library、Conference Hall、Television and Film Studio，以及 Generic 总表裁剪（办公椅、长椅、穿衣镜、工位木桌、茶几、侧向餐椅）、Bedroom 总表裁剪（单人床、床头柜、白衣柜）、Kitchen 总表裁剪（冰箱、咖啡机）、Music and Sport 总表裁剪（钢琴凳、吉他）；台球桌与三人沙发由 Basement 单件拼接；工位长条桌由 Generic 俯视木桌九宫格拉伸（`stretch`），工位转椅为 Generic 背面视角办公转椅；留言板软木板为脚本程序化绘制（`notice_board`）。构建时统一裁掉透明边 |
| `anims/*.png` 动画帧条 | `3_Animated_objects/16x16/spritesheets/`（玻璃门、电梯、接待员、滚动屏显示器、音箱、机柜、文档屏、咖啡、猫、鱼缸、布谷鸟钟、钢琴、小火车）；`wave_screen` 截取自 X 光机监视器波形；`arrow_down` / `arrow_up` 由 `4_User_Interface_Elements` 的 GIF 转为帧条 |
| `player.png` | `2_Characters/Character_Generator/0_Premade_Characters/16x16/Premade_Character_12.png` 按与形象部件相同的 96x320 布局重排（脚本生成） |

详细说明见 `frontend/public/chat-lobby/CREDITS.md`。新增素材时同样只把派生文件放进 `frontend/public/chat-lobby/`，并在 CREDITS.md 登记。

## 8. 速查命令

```bash
cd chatworld/asset/modern_interiors
# 按关键词找动画物件
ls 3_Animated_objects/16x16/spritesheets | grep -i door
# 按关键词在全部 16x16 素材中找文件（家具单件编号无语义，需先看 Theme_Sorter 总表）
find . -path '*16x16*' -iname '*condominium*'
# 查看图片尺寸（推算帧数）
file 3_Animated_objects/16x16/spritesheets/animated_cat.png
```
