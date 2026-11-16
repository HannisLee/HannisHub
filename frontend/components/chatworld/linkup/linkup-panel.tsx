"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLinkupBoard, setLinkupCloseGuard, submitLinkupOnExit, submitLinkupScore,
  type LinkupBoard, type LinkupScore, type LinkupSubmitResult, type RankedMode,
} from "../../../lib/lobby-linkup";
import type { MachineInfo } from "../lobby/game/layout";
import { SHIFTS, SHIFT_LABEL, type Shift } from "./board";
import { LinkupEngine, type LinkupUi } from "./engine";
import {
  CASUAL_LEVELS, CASUAL_SIZES, DAILY_TOOLS, LEVELS_PER_ROUND, MODE_LABEL, SHIFT_DESC, TOOLS,
  campaignLevel, casualLevel, dailyLevel, type CasualLevel, type CasualSize, type LevelConfig,
} from "./levels";
import { linkupAudio } from "./sounds";

const EMPTY_UI: LinkupUi = {
  phase: "idle", config: null, score: 0, levelStartScore: 0, combo: 0, maxCombo: 0, hints: 0, shuffles: 0,
  pairsLeft: 0, totalPairs: 0, seconds: 0, timeBonus: 0, matched: 0, notice: null,
};

const CASUAL_KEY = "hannishub:linkup-casual";

interface CasualPrefs {
  size: CasualSize;
  level: CasualLevel;
  shift: Shift | "random";
}

function readCasual(): CasualPrefs {
  const fallback: CasualPrefs = { size: "medium", level: "normal", shift: "random" };
  try {
    const raw = JSON.parse(window.localStorage.getItem(CASUAL_KEY) ?? "null") as Partial<CasualPrefs> | null;
    if (!raw) return fallback;
    return {
      size: raw.size && raw.size in CASUAL_SIZES ? raw.size : fallback.size,
      level: raw.level && raw.level in CASUAL_LEVELS ? raw.level : fallback.level,
      shift: raw.shift === "random" || (raw.shift && SHIFTS.includes(raw.shift)) ? raw.shift : fallback.shift,
    };
  } catch {
    return fallback;
  }
}

function formatClock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function rankedMode(config: LevelConfig | null): RankedMode | null {
  return config?.mode === "campaign" || config?.mode === "daily" ? config.mode : null;
}

/** 排行榜 */
function Leaderboard({ board, tab, onTab }: { board: LinkupBoard | null; tab: RankedMode; onTab: (tab: RankedMode) => void }) {
  const rows = board ? board[tab] : [];
  const mine = board?.mine[tab] ?? null;
  return (
    <section className="linkup-rank" aria-label="排行榜">
      <div className="linkup-rank-tabs" role="tablist">
        {(["campaign", "daily"] as const).map(key => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`linkup-rank-tab${tab === key ? " is-active" : ""}`} onClick={() => onTab(key)}>
            {key === "campaign" ? "闯关榜" : "今日挑战榜"}
          </button>
        ))}
      </div>
      {!board ? (
        <p className="linkup-rank-empty">正在读取排行榜…</p>
      ) : rows.length === 0 ? (
        <p className="linkup-rank-empty">{tab === "daily" ? "今天还没有人挑战，来拿第一吧" : "还没有成绩，来当第一个上榜的人"}</p>
      ) : (
        <ol className="linkup-rank-list">
          {rows.map((row, index) => (
            <li key={`${row.name}-${index}`} className={`linkup-rank-row${row.mine ? " is-mine" : ""}`}>
              <span className="linkup-rank-no">{index + 1}</span>
              <span className="linkup-rank-name">{row.name}</span>
              <span className="linkup-rank-meta">{tab === "campaign" ? `第 ${row.level} 关` : row.cleared ? "已通关" : "未通关"}</span>
              <span className="linkup-rank-score">{row.score.toLocaleString()}</span>
            </li>
          ))}
        </ol>
      )}
      {mine ? (
        <p className="linkup-rank-mine">我的最好：{mine.score.toLocaleString()} 分 · 第 {mine.rank} 名 · 共玩 {mine.plays} 局</p>
      ) : null}
    </section>
  );
}

/** 连连看面板：大厅街机。闯关 / 每日挑战 / 休闲三种模式，Canvas 像素画面 + 排行榜 */
export function LinkupPanel({ machine }: { machine?: MachineInfo; onClose?: () => void }) {
  void machine;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<LinkupEngine | null>(null);
  const [ui, setUi] = useState<LinkupUi>(EMPTY_UI);
  const uiRef = useRef<LinkupUi>(EMPTY_UI);
  const [menu, setMenu] = useState(true);
  const [board, setBoard] = useState<LinkupBoard | null>(null);
  const [boardError, setBoardError] = useState("");
  const [tab, setTab] = useState<RankedMode>("campaign");
  const [casual, setCasual] = useState<CasualPrefs>(readCasual);
  const [sfxMuted, setSfxMuted] = useState(() => linkupAudio().sfxMuted);
  const [musicMuted, setMusicMuted] = useState(() => linkupAudio().musicMuted);
  /** 已经隐藏的临时提示编号 */
  const [noticeHidden, setNoticeHidden] = useState(0);
  const [result, setResult] = useState<LinkupSubmitResult | null>(null);
  const [submitError, setSubmitError] = useState("");
  /** 每开一局递增；submittedRun 记录已提交成绩的局，避免重复提交 */
  const runRef = useRef({ id: 0, seed: 0, submitted: -1 });

  const loadBoard = useCallback(() => {
    fetchLinkupBoard()
      .then(data => {
        setBoard(data);
        setBoardError("");
      })
      .catch(error => setBoardError(error instanceof Error ? error.message : "排行榜读取失败"));
  }, []);

  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  // 引擎：挂载时创建，卸载时销毁；仍在进行中的计分局按当前分数提交
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const run = runRef.current;
    let frame = 0;
    const engine = new LinkupEngine(canvas, host, () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = engine.ui();
        uiRef.current = next;
        setUi(next);
      });
    });
    engineRef.current = engine;
    setLinkupCloseGuard(() => {
      const current = uiRef.current;
      const mode = rankedMode(current.config);
      if (!mode || current.phase === "idle" || current.phase === "over" || run.submitted === run.id) return null;
      return "这一局还没结束，离开会按当前分数结算。确定离开吗？";
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      const current = engine.ui();
      const mode = rankedMode(current.config);
      if (mode && current.phase !== "idle" && current.score > 0 && run.submitted !== run.id) {
        submitLinkupOnExit({
          mode, score: current.score, level: current.config?.level ?? 1, cleared: false,
          day: mode === "daily" ? dayOf(current.config) : undefined,
        });
      }
      setLinkupCloseGuard(null);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // 临时提示：显示约 1.7 秒后隐藏
  useEffect(() => {
    const id = ui.notice?.id;
    if (!id) return;
    const timer = setTimeout(() => setNoticeHidden(id), 1700);
    return () => clearTimeout(timer);
  }, [ui.notice]);
  const notice = ui.notice && ui.notice.id !== noticeHidden ? ui.notice.text : "";

  const submit = useCallback((score: LinkupScore) => {
    const run = runRef.current;
    if (run.submitted === run.id) return;
    run.submitted = run.id;
    setSubmitError("");
    submitLinkupScore(score)
      .then(response => {
        setResult(response);
        setBoard(response.board);
        if (response.record) linkupAudio().play("record");
      })
      .catch(error => setSubmitError(error instanceof Error ? error.message : "成绩提交失败"));
  }, []);

  // 计分模式结束时提交：闯关超时 / 放弃，每日挑战结束或通关
  useEffect(() => {
    const mode = rankedMode(ui.config);
    if (!mode || !ui.config) return;
    const cleared = ui.phase === "clear";
    if (ui.phase === "over" || (mode === "daily" && cleared)) {
      submit({ mode, score: ui.score, level: ui.config.level, cleared: mode === "daily" ? cleared : ui.config.level > 1, day: mode === "daily" ? dayOf(ui.config) : undefined });
    }
  }, [ui.phase, ui.config, ui.score, submit]);

  const begin = useCallback((config: LevelConfig, tools: { hints: number; shuffles: number }, carry?: Partial<LinkupUi>) => {
    const engine = engineRef.current;
    if (!engine) return;
    linkupAudio().unlock();
    linkupAudio().play("click");
    setMenu(false);
    // 竖屏（手机）时闯关与休闲改为竖向盘面，方块更大；每日挑战要求所有人盘面相同，保持横向
    const host = hostRef.current;
    const portrait = Boolean(host && host.clientHeight > host.clientWidth * 1.15);
    const shaped = portrait && config.mode !== "daily" && config.cols > config.rows ? { ...config, rows: config.cols, cols: config.rows } : config;
    engine.start(shaped, {
      hints: tools.hints, shuffles: tools.shuffles, score: carry?.score ?? 0, maxCombo: carry?.maxCombo ?? 0, matched: carry?.matched ?? 0,
    });
    canvasRef.current?.focus({ preventScroll: true });
  }, []);

  const newRun = () => {
    runRef.current.id++;
    runRef.current.seed = Math.floor(Math.random() * 1e9);
    setResult(null);
    setSubmitError("");
  };

  const startCampaign = () => {
    newRun();
    begin(campaignLevel(1, runRef.current.seed), { hints: TOOLS.hint.start, shuffles: TOOLS.shuffle.start });
  };

  const nextLevel = () => {
    const current = uiRef.current;
    if (!current.config || current.config.mode !== "campaign") return;
    begin(campaignLevel(current.config.level + 1, runRef.current.seed), {
      hints: Math.min(TOOLS.hint.max, current.hints + TOOLS.hint.perLevel),
      shuffles: Math.min(TOOLS.shuffle.max, current.shuffles + TOOLS.shuffle.perLevel),
    }, current);
  };

  const startDaily = () => {
    if (!board) return;
    newRun();
    begin(dailyLevel(board.day), { hints: DAILY_TOOLS.hint, shuffles: DAILY_TOOLS.shuffle });
  };

  const startCasual = (prefs = casual) => {
    newRun();
    try {
      window.localStorage.setItem(CASUAL_KEY, JSON.stringify(prefs));
    } catch {
      // 忽略
    }
    begin(casualLevel(prefs.size, prefs.level, prefs.shift, Math.floor(Math.random() * 1e9)), { hints: -1, shuffles: -1 });
  };

  const again = () => {
    const mode = ui.config?.mode;
    if (mode === "campaign") startCampaign();
    else if (mode === "daily") startDaily();
    else startCasual();
  };

  /** 结算当前计分局（闯关中途结束、计分局返回菜单） */
  const settle = () => {
    const current = engineRef.current?.ui();
    const mode = rankedMode(current?.config ?? null);
    if (!current || !mode || current.phase === "idle" || current.phase === "over") return;
    submit({ mode, score: current.score, level: current.config?.level ?? 1, cleared: false, day: dayOf(current.config) });
  };

  const backToMenu = (confirmFirst = true) => {
    linkupAudio().play("click");
    const current = engineRef.current?.ui();
    const active = current && ["ready", "playing", "paused", "clear"].includes(current.phase);
    if (active && rankedMode(current.config) && runRef.current.submitted !== runRef.current.id) {
      if (confirmFirst && !window.confirm("这一局还没结束，返回菜单会按当前分数结算。确定吗？")) return;
      settle();
    } else {
      loadBoard();
    }
    engineRef.current?.abandon();
    setMenu(true);
  };

  // 键盘：H 提示、R 重列、P / 空格暂停、回车进入下一关
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || menu) return;
      const engine = engineRef.current;
      if (!engine) return;
      const key = event.key.toLowerCase();
      if (key === "h") engine.useHint();
      else if (key === "r") engine.useShuffle();
      else if (key === "p" || (key === " " && target?.tagName !== "BUTTON")) {
        event.preventDefault();
        engine.togglePause();
      } else if (key === "enter" && uiRef.current.phase === "clear" && uiRef.current.config?.mode === "campaign") {
        event.preventDefault();
        nextLevel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleSfx = () => {
    const next = !linkupAudio().sfxMuted;
    linkupAudio().setSfxMuted(next);
    setSfxMuted(next);
    if (!next) {
      linkupAudio().unlock();
      linkupAudio().play("click");
    }
  };

  const toggleMusic = () => {
    const audio = linkupAudio();
    const next = !audio.musicMuted;
    audio.unlock();
    audio.setMusicMuted(next);
    setMusicMuted(next);
  };

  const config = ui.config;
  const playing = ui.phase === "playing";
  const timed = Boolean(config?.time);
  const daily = board ? dailyLevel(board.day) : null;
  const round = config ? config.round : 1;
  const levelInRound = config ? ((config.level - 1) % LEVELS_PER_ROUND) + 1 : 1;
  const casualConfig = casualLevel(casual.size, casual.level, casual.shift, 0);

  return (
    <div className="linkup">
      <div className="linkup-hud">
        {config && !menu ? (
          <div className="linkup-hud-title">
            <span className="linkup-hud-mode">{MODE_LABEL[config.mode]}</span>
            <span className="linkup-hud-level">{config.title}</span>
            {config.mode === "campaign" ? <span className="linkup-hud-round">第 {round} 轮 · {levelInRound}/{LEVELS_PER_ROUND}</span> : null}
          </div>
        ) : null}
        {!menu && config ? (
          <div className="linkup-stats" aria-live="polite">
            <div className="linkup-stat">
              <span className="linkup-stat-label">分数</span>
              <span className="linkup-stat-value">{ui.score.toLocaleString()}</span>
            </div>
            <div className={`linkup-stat${ui.combo >= 2 ? " is-hot" : ""}`}>
              <span className="linkup-stat-label">连击</span>
              <span className="linkup-stat-value">{ui.combo >= 2 ? `×${ui.combo}` : "—"}</span>
            </div>
            <div className="linkup-stat">
              <span className="linkup-stat-label">剩余</span>
              <span className="linkup-stat-value">{ui.pairsLeft}<small> / {ui.totalPairs} 对</small></span>
            </div>
            <div className="linkup-stat">
              <span className="linkup-stat-label">{timed ? "倒计时" : "用时"}</span>
              <span className={`linkup-stat-value${timed && ui.seconds <= 10 && playing ? " is-danger" : ""}`}>{timed ? `${ui.seconds}s` : formatClock(ui.seconds)}</span>
            </div>
          </div>
        ) : null}
        <div className="linkup-tools">
          {!menu && config ? (
            <>
              <button type="button" className="linkup-tool" disabled={!playing || ui.hints === 0} onClick={() => engineRef.current?.useHint()} title="提示一对可以消除的方块（H）">
                提示<span className="linkup-tool-count">{ui.hints < 0 ? "∞" : ui.hints}</span>
              </button>
              <button type="button" className="linkup-tool" disabled={!playing || ui.shuffles === 0} onClick={() => engineRef.current?.useShuffle()} title="打乱剩余方块（R）">
                重列<span className="linkup-tool-count">{ui.shuffles < 0 ? "∞" : ui.shuffles}</span>
              </button>
              <button type="button" className="linkup-tool" disabled={!playing && ui.phase !== "paused"} onClick={() => engineRef.current?.togglePause()} title="暂停 / 继续（P 或空格）">
                {ui.phase === "paused" ? "继续" : "暂停"}
              </button>
              <button type="button" className="linkup-tool is-quiet" onClick={() => backToMenu()}>菜单</button>
            </>
          ) : null}
          <button type="button" className="linkup-tool is-quiet" aria-pressed={!sfxMuted} onClick={toggleSfx} title={sfxMuted ? "开启音效" : "关闭音效"}>
            {sfxMuted ? "音效关" : "音效"}
          </button>
          <button type="button" className="linkup-tool is-quiet" aria-pressed={!musicMuted} onClick={toggleMusic} title={musicMuted ? "开启音乐" : "关闭音乐"}>
            {musicMuted ? "音乐关" : "音乐"}
          </button>
        </div>
      </div>

      <div className="linkup-stage">
        <div ref={hostRef} className="linkup-host">
          <canvas ref={canvasRef} tabIndex={0} className="linkup-canvas" aria-label="连连看棋盘：点击两个相同的方块，能用不超过两个拐弯的线连起来就会消除" />
        </div>

        {notice && !menu ? <div className="linkup-toast" role="status">{notice}</div> : null}

        {!menu && ui.phase === "ready" && config ? (
          <div className="linkup-banner" aria-live="polite">
            <p className="linkup-banner-title">{config.title}</p>
            <p className="linkup-banner-text">{SHIFT_DESC[config.shift]}{timed ? ` · 限时 ${config.time} 秒` : " · 不限时"}</p>
          </div>
        ) : null}

        {!menu && ui.phase === "paused" ? (
          <div className="linkup-overlay">
            <p className="linkup-overlay-title">已暂停</p>
            <p className="linkup-overlay-text">暂停时棋盘会盖住。按 P 或空格继续。</p>
            <div className="linkup-overlay-actions">
              <button type="button" className="linkup-button is-primary" onClick={() => engineRef.current?.togglePause()}>继续游戏</button>
              <button type="button" className="linkup-button" onClick={() => backToMenu()}>返回菜单</button>
            </div>
          </div>
        ) : null}

        {!menu && ui.phase === "clear" && config ? (
          <div className="linkup-overlay">
            <p className="linkup-overlay-title">{config.mode === "campaign" ? `第 ${config.level} 关完成` : config.mode === "daily" ? "今日挑战完成" : "全部消除"}</p>
            <dl className="linkup-result">
              <div><dt>本关得分</dt><dd>{(ui.score - ui.levelStartScore - ui.timeBonus).toLocaleString()}</dd></div>
              {timed ? <div><dt>剩余时间奖励</dt><dd>+{ui.timeBonus.toLocaleString()}</dd></div> : <div><dt>用时</dt><dd>{formatClock(ui.seconds)}</dd></div>}
              <div><dt>最高连击</dt><dd>{ui.maxCombo}</dd></div>
              {config.mode !== "casual" ? <div className="is-total"><dt>总分</dt><dd>{ui.score.toLocaleString()}</dd></div> : null}
            </dl>
            {config.mode === "daily" ? <ResultNote result={result} error={submitError} /> : null}
            {config.mode === "campaign" ? (
              <p className="linkup-overlay-note">下一关：{campaignLevel(config.level + 1, 0).title} · 提示、重列各补充 1 次</p>
            ) : null}
            <div className="linkup-overlay-actions">
              {config.mode === "campaign" ? (
                <>
                  <button type="button" className="linkup-button is-primary" onClick={nextLevel}>下一关（回车）</button>
                  <button type="button" className="linkup-button" onClick={() => backToMenu(false)}>结束并结算</button>
                </>
              ) : (
                <>
                  <button type="button" className="linkup-button is-primary" onClick={again}>再来一局</button>
                  <button type="button" className="linkup-button" onClick={() => backToMenu()}>返回菜单</button>
                </>
              )}
            </div>
          </div>
        ) : null}

        {!menu && ui.phase === "over" && config ? (
          <div className="linkup-overlay">
            <p className="linkup-overlay-title">{config.time && ui.seconds <= 0 ? "时间到" : "本局结束"}</p>
            <dl className="linkup-result">
              <div><dt>{config.mode === "campaign" ? "到达关卡" : "消除"}</dt><dd>{config.mode === "campaign" ? `第 ${config.level} 关` : `${ui.totalPairs - ui.pairsLeft} / ${ui.totalPairs} 对`}</dd></div>
              <div><dt>最高连击</dt><dd>{ui.maxCombo}</dd></div>
              <div className="is-total"><dt>总分</dt><dd>{ui.score.toLocaleString()}</dd></div>
            </dl>
            {rankedMode(config) ? <ResultNote result={result} error={submitError} /> : null}
            <div className="linkup-overlay-actions">
              <button type="button" className="linkup-button is-primary" onClick={again}>再来一局</button>
              <button type="button" className="linkup-button" onClick={() => backToMenu()}>返回菜单</button>
            </div>
          </div>
        ) : null}

        {menu ? (
          <div className="linkup-menu">
            <div className="linkup-modes">
              <header className="linkup-menu-head">
                <h2 className="linkup-menu-title">连连看</h2>
                <p className="linkup-menu-text">找出两个相同的方块，能用不超过两个拐弯的线连起来就能消除，线可以从棋盘外绕过去。清空棋盘即过关。</p>
              </header>
              <article className="linkup-mode">
                <div className="linkup-mode-body">
                  <h3 className="linkup-mode-name">闯关模式</h3>
                  <p className="linkup-mode-desc">{LEVELS_PER_ROUND} 关一轮，每关一种变化：不变化、向下、向左、向上、向右、上下分离、左右分离、上下集中、左右集中、上左下右、左下右上。限时过关，剩余时间换奖励分；一轮通关后图案更多、时间更紧。</p>
                  <p className="linkup-mode-meta">14×8 · 提示 {TOOLS.hint.start} 次、重列 {TOOLS.shuffle.start} 次，每过一关各补 1 次{board?.mine.campaign ? ` · 我的最好 ${board.mine.campaign.score.toLocaleString()} 分（第 ${board.mine.campaign.level} 关）` : ""}</p>
                </div>
                <button type="button" className="linkup-button is-primary" onClick={startCampaign}>开始闯关</button>
              </article>
              <article className="linkup-mode">
                <div className="linkup-mode-body">
                  <h3 className="linkup-mode-name">每日挑战</h3>
                  <p className="linkup-mode-desc">
                    {daily ? `今天（${board?.day}）：${SHIFT_LABEL[daily.shift]}，16×9 大盘面，限时 ${daily.time} 秒。` : "每天一个新盘面。"}
                    所有人拿到同一个盘面，比谁的分数高，可以反复挑战取最好成绩。
                  </p>
                  <p className="linkup-mode-meta">提示 {DAILY_TOOLS.hint} 次、重列 {DAILY_TOOLS.shuffle} 次{board?.mine.daily ? ` · 今日最好 ${board.mine.daily.score.toLocaleString()} 分（第 ${board.mine.daily.rank} 名）` : ""}</p>
                </div>
                <button type="button" className="linkup-button is-primary" disabled={!board} onClick={startDaily}>开始挑战</button>
              </article>
              <article className="linkup-mode">
                <div className="linkup-mode-body">
                  <h3 className="linkup-mode-name">休闲模式</h3>
                  <p className="linkup-mode-desc">不限时，提示与重列不限次数，不计成绩。</p>
                  <div className="linkup-options">
                    <div className="linkup-segment" role="group" aria-label="盘面大小">
                      {(Object.keys(CASUAL_SIZES) as CasualSize[]).map(key => (
                        <button key={key} type="button" className={casual.size === key ? "is-active" : ""} aria-pressed={casual.size === key} onClick={() => setCasual({ ...casual, size: key })}>{CASUAL_SIZES[key].label}</button>
                      ))}
                    </div>
                    <div className="linkup-segment" role="group" aria-label="难度">
                      {(Object.keys(CASUAL_LEVELS) as CasualLevel[]).map(key => (
                        <button key={key} type="button" className={casual.level === key ? "is-active" : ""} aria-pressed={casual.level === key} onClick={() => setCasual({ ...casual, level: key })}>{CASUAL_LEVELS[key].label}</button>
                      ))}
                    </div>
                    <label className="linkup-select">
                      <span>变化</span>
                      <select value={casual.shift} onChange={event => setCasual({ ...casual, shift: event.target.value as Shift | "random" })}>
                        <option value="random">随机</option>
                        {SHIFTS.map(shift => <option key={shift} value={shift}>{SHIFT_LABEL[shift]}</option>)}
                      </select>
                    </label>
                  </div>
                  <p className="linkup-mode-meta">{casualConfig.kinds} 种图案 · {(casualConfig.rows * casualConfig.cols) / 2} 对</p>
                </div>
                <button type="button" className="linkup-button" onClick={() => startCasual()}>开始</button>
              </article>
            </div>
            <div className="linkup-side">
              <Leaderboard board={board} tab={tab} onTab={setTab} />
              {boardError ? <p className="linkup-error">{boardError}</p> : null}
              <section className="linkup-help">
                <h3 className="linkup-help-title">操作</h3>
                <ul>
                  <li>点击两个相同的方块消除；连续快速消除得连击加分</li>
                  <li><kbd>H</kbd> 提示 · <kbd>R</kbd> 重列 · <kbd>P</kbd> / 空格 暂停</li>
                  <li>没有可消除的方块时会自动重列（不消耗道具）</li>
                </ul>
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function dayOf(config: LevelConfig | null): string | undefined {
  return config?.mode === "daily" ? config.day : undefined;
}

function ResultNote({ result, error }: { result: LinkupSubmitResult | null; error: string }) {
  if (error) return <p className="linkup-error">成绩提交失败：{error}</p>;
  if (!result) return <p className="linkup-overlay-note">正在提交成绩…</p>;
  if (result.record) return <p className="linkup-overlay-note is-record">新纪录！当前排名第 {result.rank} 名</p>;
  return <p className="linkup-overlay-note">未超过最好成绩 {result.previous?.toLocaleString()} 分{result.rank ? ` · 当前排名第 ${result.rank} 名` : ""}</p>;
}
