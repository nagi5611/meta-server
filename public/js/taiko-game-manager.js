// public/js/taiko-game-manager.js
// 轟太鼓リズムゲーム: オーバーレイ制御・ノーツ生成・判定・スコア管理

import { isMobile } from './mobile-utils.js';

/**
 * ノーツ定義: { time: 秒, type: 'don'|'ka', volume?: 0.1〜3 } または { type: 'roll', startTime: 秒, endTime: 秒 }
 * デモ譜面（固定）。後から外部ファイルに分離可能。
 */
const DEMO_CHART = [
    { time: 1.0, type: 'don' },
    { time: 1.5, type: 'don' },
    { time: 2.0, type: 'ka' },
    { time: 2.5, type: 'don' },
    { time: 3.0, type: 'don' },
    { time: 3.5, type: 'ka' },
    { time: 4.0, type: 'ka' },
    { time: 4.5, type: 'don' },
    { time: 5.0, type: 'don' },
    { time: 5.5, type: 'don' },
    { time: 6.0, type: 'ka' },
    { time: 6.5, type: 'don' },
    { time: 7.0, type: 'don' },
    { time: 7.5, type: 'ka' },
    { time: 8.0, type: 'don' },
    { time: 8.5, type: 'ka' },
    { time: 9.0, type: 'don' },
    { time: 9.5, type: 'don' },
    { time: 10.0, type: 'ka' },
    { time: 10.5, type: 'don' },
];

/** ノーツが画面右端から判定ラインに到達するまでの時間（秒） */
const NOTE_TRAVEL_TIME = 1.8;
/** 判定ライン左位置 (px) — CSS と合わせる */
const JUDGE_LINE_LEFT_PX = 60;
/** 判定ラインからの距離（px）で判定。ノーツ中心がラインに触れているかで精度を上げる */
/** 良: 判定ラインからこの距離以内（px） */
const JUDGE_GOOD_PX = 45;
/** 可: 判定ラインからこの距離以内（px） */
const JUDGE_OK_PX = 90;
/** 不可: ライン通過後この距離を超えたら不可（px）。ヒット処理の猶予のため余裕を持たせる */
const JUDGE_MISS_PX = 130;

/** ヒット音のパス */
const SOUND_DON = '/music/don_.mp3';
const SOUND_KA = '/music/ka_.mp3';

/**
 * 譜面の volume（倍率、未指定は 1）を 10%〜300% に丸める
 * @param {unknown} v
 * @returns {number}
 */
function clampChartNoteVolume(v) {
    const x = Number(v);
    if (!Number.isFinite(x)) return 1;
    return Math.min(3, Math.max(0.1, x));
}

/**
 * BPM から 4/4 の1小節の秒数
 * @param {number} bpm
 */
function taikoBarSecFromBpm(bpm) {
    const v = Number(bpm);
    if (!Number.isFinite(v) || v <= 0) return 2;
    return (60 / v) * 4;
}

/**
 * 譜面エディタのグリッド時間(秒)を実時間(秒)へ変換する（小節ごとBPMで伸縮）
 * @param {number} uSec
 * @param {number} baseBpm
 * @param {Record<string, number>} measureBpms
 */
function taikoWallAtUniform(uSec, baseBpm, measureBpms) {
    const u = Math.max(0, Number(uSec) || 0);
    const base = Number.isFinite(baseBpm) && baseBpm > 0 ? baseBpm : 120;
    const Tuni = taikoBarSecFromBpm(base);
    if (Tuni <= 0) return 0;
    const eff = (barIndex) => {
        const bi = Math.max(0, Number(barIndex) || 0);
        const ov = measureBpms && Object.prototype.hasOwnProperty.call(measureBpms, String(bi))
            ? Number(measureBpms[String(bi)])
            : NaN;
        if (Number.isFinite(ov) && ov >= 1 && ov <= 500) return ov;
        return base;
    };
    const barIndex = Math.floor(u / Tuni);
    const within = u - barIndex * Tuni;
    let wall = 0;
    for (let i = 0; i < barIndex; i++) {
        wall += taikoBarSecFromBpm(eff(i));
    }
    const Twall = taikoBarSecFromBpm(eff(barIndex));
    wall += (within / Tuni) * Twall;
    return wall;
}

class TaikoGameManager {
    constructor() {
        this._overlay = null;
        this._songSelectEl = null;
        this._gameContainerEl = null;
        this._chartListEl = null;
        this._chartEmptyEl = null;
        this._notesContainer = null;
        this._scoreEl = null;
        this._judgeEl = null;
        this._open = false;

        this._score = 0;
        this._maxScore = 0; // 満点（全ノーツ良 = 100pt × ノーツ数）
        this._chart = [];
        this._chartMeta = null; // { id, name, difficulty, endTime, tempo?, measureBpms? } 選曲時
        /** @type {number} 譜面のベース BPM（グリッド時間の定義に使用） */
        this._chartBaseBpm = 120;
        /** @type {Record<string, number>} 小節インデックス → BPM 上書き */
        this._chartMeasureBpms = {};
        this._judgeCounts = { good: 0, ok: 0, miss: 0 };
        this._currentCombo = 0;
        this._maxCombo = 0;
        this._rollCount = 0;
        this._activeNotes = []; // { el, targetTime, type, hit, chartIndex, endTime? }
        this._processedChartIndices = new Set(); // 処理済み（ヒット or 不可）のチャート索引
        this._startTime = null;
        this._rafId = null;
        this._judgeTimer = null;

        this._boundKeyDown = this._onKeyDown.bind(this);

        /** @type {import('socket.io-client').Socket | null} */
        this._socket = null;
        /** @type {((payload: { type: string, from?: string }) => void) | null} */
        this._onRemoteHit = null;
        /** マルチプレイゾーン情報 */
        this._mpZone = null;
        /** @type {number | null} */
        this._mpClaimedPart = null;
        this._mpOnState = null;
        this._mpOnSyncStart = null;
        this._mpOnResults = null;
        this._mpPartNames = {};

        // --- BGM sync (WebAudio + time sync)
        /** @type {AudioContext | null} */
        this._bgmAudioCtx = null;
        /** @type {{ key: string, buffer: AudioBuffer | null }} */
        this._bgmCache = { key: '', buffer: null };
        /** @type {AudioBufferSourceNode | null} */
        this._bgmSource = null;
        /** @type {GainNode | null} */
        this._bgmGain = null;
        /** @type {number[]} */
        this._serverOffsetSamplesMs = [];
        /** @type {number} */
        this._serverOffsetMs = 0;
        /** @type {boolean} */
        this._mpReadySent = false;
        /** @type {boolean} */
        this._mpNeedsBgm = false;

        /** @type {boolean} マルチ開始（譜面/スケジューリング）済み */
        this._mpGameStarted = false;

        /** @type {{ don: AudioBuffer, ka: AudioBuffer } | null} */
        this._hitSoundBuffers = null;
        /** @type {Promise<void> | null} */
        this._hitSoundDecodePromise = null;
    }

    /** WebAudioコンテキストを確保して返す（ユーザー操作後に resume すること） */
    _ensureBgmAudioCtx() {
        if (this._bgmAudioCtx) return this._bgmAudioCtx;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this._bgmAudioCtx = Ctx ? new Ctx() : null;
        return this._bgmAudioCtx;
    }

    /** サーバ時刻オフセットを推定（複数回サンプルして中央値を採用） */
    async _sampleServerOffset() {
        if (!this._socket) return;
        const t0 = Date.now();
        await new Promise((resolve) => {
            this._socket.emit('taiko-time-sync', { t0 }, (res) => {
                const t1 = Date.now();
                const serverNow = res && typeof res.serverNow === 'number' ? res.serverNow : null;
                if (serverNow != null) {
                    const rtt = Math.max(0, t1 - t0);
                    const offset = serverNow - (t0 + rtt / 2);
                    this._serverOffsetSamplesMs.push(offset);
                    if (this._serverOffsetSamplesMs.length > 11) this._serverOffsetSamplesMs.shift();
                    const sorted = [...this._serverOffsetSamplesMs].sort((a, b) => a - b);
                    this._serverOffsetMs = sorted[Math.floor(sorted.length / 2)] || 0;
                }
                resolve();
            });
        });
    }

    _estimatedServerNowMs() {
        return Date.now() + (Number(this._serverOffsetMs) || 0);
    }

    /** BGM(mp3)をデコードしてAudioBufferを返す。bgmVersionが無い場合はnull。 */
    async _loadChartBgmBuffer(chartId, bgmVersion) {
        if (!chartId || bgmVersion == null) return null;
        const ctx = this._ensureBgmAudioCtx();
        if (!ctx) return null;
        const key = `${chartId}:${bgmVersion}`;
        if (this._bgmCache.key === key && this._bgmCache.buffer) return this._bgmCache.buffer;
        const url = `/chart-bgm/${encodeURIComponent(chartId)}.mp3?v=${encodeURIComponent(String(bgmVersion))}`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('BGMの取得に失敗しました');
        const ab = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab.slice(0));
        this._bgmCache = { key, buffer: buf };
        return buf;
    }

    _stopBgm() {
        if (this._bgmSource) {
            try { this._bgmSource.stop(); } catch {}
            try { this._bgmSource.disconnect(); } catch {}
        }
        this._bgmSource = null;
    }

    /**
     * Socket.io クライアントを接続する（マルチプレイ同期用）
     * @param {import('socket.io-client').Socket | null} socket
     */
    setSocket(socket) {
        if (this._socket && this._onRemoteHit) {
            this._socket.off('taiko-hit', this._onRemoteHit);
        }
        this._socket = socket || null;
        if (!this._socket) {
            this._onRemoteHit = null;
            return;
        }
        this._onRemoteHit = (payload) => {
            if (!payload || (payload.type !== 'don' && payload.type !== 'ka')) return;
            if (this._socket && payload.from && payload.from === this._socket.id) return;
            this._playHitSound(payload.type === 'ka' ? 'ka' : 'don');
        };
        this._socket.on('taiko-hit', this._onRemoteHit);
    }

    /**
     * DOM 要素を取得しイベントを設定する。
     */
    init() {
        this._overlay = document.getElementById('taiko-game-overlay');
        this._songSelectEl = document.getElementById('taiko-song-select');
        this._gameContainerEl = document.getElementById('taiko-game-container');
        this._chartListEl = document.getElementById('taiko-chart-list');
        this._chartEmptyEl = document.getElementById('taiko-chart-empty');
        this._notesContainer = document.getElementById('taiko-notes');
        this._scoreEl = document.getElementById('taiko-score');
        this._scoreMaxEl = document.getElementById('taiko-score-max');
        this._scoreRateEl = document.getElementById('taiko-score-rate');

        if (!this._overlay) return;

        document.getElementById('taiko-song-select-close')?.addEventListener('click', () => this.close());
        document.getElementById('taiko-results-close')?.addEventListener('click', () => this._closeResults());

        // 判定テキスト要素を動的に作成
        this._judgeEl = document.createElement('div');
        this._judgeEl.className = 'taiko-judge-text';
        this._notesContainer?.parentElement?.appendChild(this._judgeEl);

        document.getElementById('taiko-game-close')?.addEventListener('click', () => this.close());

        const hintPopup = document.getElementById('taiko-hint-popup');
        const hintBodyPc = document.getElementById('taiko-hint-body-pc');
        const hintBodyMobile = document.getElementById('taiko-hint-body-mobile');
        document.getElementById('taiko-game-hint')?.addEventListener('click', () => {
            if (!hintPopup || !hintBodyPc || !hintBodyMobile) return;
            hintBodyPc.style.display = isMobile() ? 'none' : 'block';
            hintBodyMobile.style.display = isMobile() ? 'block' : 'none';
            hintPopup.style.display = 'flex';
            hintPopup.setAttribute('aria-hidden', 'false');
        });
        hintPopup?.querySelector('.taiko-hint-popup-backdrop')?.addEventListener('click', () => this._closeHintPopup());
        hintPopup?.querySelector('.taiko-hint-popup-close')?.addEventListener('click', () => this._closeHintPopup());

        // 太鼓の面（画像）クリック・タップ → ドン
        const drumEl = document.getElementById('taiko-drum');
        drumEl?.addEventListener('click', () => this._hit('don'));
        drumEl?.addEventListener('touchstart', (e) => { e.preventDefault(); this._hit('don'); }, { passive: false });

        // 画像を除く青い部分全体 → カッ
        const kaZone = document.getElementById('taiko-ka-zone');
        kaZone?.addEventListener('click', () => this._hit('ka'));
        kaZone?.addEventListener('touchstart', (e) => { e.preventDefault(); this._hit('ka'); }, { passive: false });

        document.getElementById('taiko-mp-lobby-close')?.addEventListener('click', () => this.close());
    }

    _closeHintPopup() {
        const popup = document.getElementById('taiko-hint-popup');
        if (popup) {
            popup.style.display = 'none';
            popup.setAttribute('aria-hidden', 'true');
        }
    }

    isOpen() {
        return this._open;
    }

    /**
     * 太鼓メニューを開く。ソロは選曲、マルチはロビー。
     * @param {{ multiplayer?: boolean, groupId?: string, multiplayerChartId?: string, slotCount?: number, worldId?: string } | null} [zone]
     */
    open(zone) {
        if (!this._overlay) return;
        this._open = true;
        this._overlay.style.display = 'flex';
        if (this._gameContainerEl) this._gameContainerEl.style.display = 'none';
        const resultsEl = document.getElementById('taiko-results');
        if (resultsEl) resultsEl.style.display = 'none';
        const lobbyEl = document.getElementById('taiko-mp-lobby');

        const isMp = zone && zone.multiplayer && zone.groupId && zone.multiplayerChartId
            && zone.worldId && (zone.slotCount || 1) >= 1;
        if (isMp) {
            if (this._songSelectEl) this._songSelectEl.style.display = 'none';
            if (lobbyEl) lobbyEl.style.display = 'flex';
            this._mpZone = {
                worldId: zone.worldId,
                groupId: String(zone.groupId).trim(),
                multiplayerChartId: String(zone.multiplayerChartId).trim(),
                slotCount: Math.min(3, Math.max(1, Number(zone.slotCount) || 1))
            };
            this._mpClaimedPart = null;
            this._mpGameStarted = false;
            this._setupMultiplayerLobby();
            return;
        }
        this._teardownMultiplayer();
        if (lobbyEl) lobbyEl.style.display = 'none';
        if (this._songSelectEl) this._songSelectEl.style.display = 'flex';
        this._loadChartList();
    }

    /**
     * 選曲リストを取得して表示する
     */
    async _loadChartList() {
        if (!this._chartListEl || !this._chartEmptyEl) return;
        this._chartListEl.innerHTML = '';
        this._chartEmptyEl.style.display = 'none';
        try {
            const res = await fetch('/api/charts');
            const charts = res.ok ? await res.json() : {};
            const ids = Object.keys(charts);
            if (ids.length === 0) {
                this._chartEmptyEl.style.display = 'block';
                const li = document.createElement('li');
                li.textContent = 'デモで遊ぶ';
                li.className = 'taiko-chart-item-demo';
                li.addEventListener('click', () => this._startGamePlay(DEMO_CHART, null));
                this._chartListEl.appendChild(li);
                return;
            }
            ids.forEach((id) => {
                const c = charts[id];
                const li = document.createElement('li');
                li.textContent = c.name || id;
                li.dataset.chartId = id;
                li.addEventListener('click', () => {
                    const notes = Array.isArray(c.notes) ? c.notes : [];
                    const meta = {
                        id,
                        name: c.name || id,
                        difficulty: c.difficulty,
                        endTime: c.endTime,
                        tempo: c.tempo,
                        measureBpms: c.measureBpms
                    };
                    this._startGamePlay(notes.length ? notes : DEMO_CHART, meta);
                });
                this._chartListEl.appendChild(li);
            });
        } catch (err) {
            this._chartEmptyEl.style.display = 'block';
            this._chartEmptyEl.textContent = '譜面の取得に失敗しました';
            const li = document.createElement('li');
            li.textContent = 'デモで遊ぶ';
            li.addEventListener('click', () => this._startGamePlay(DEMO_CHART, null));
            this._chartListEl.appendChild(li);
        }
    }

    /**
     * 選んだ譜面でゲームを開始する
     * @param {Array<{time:number, type:string}>} chart - 譜面
     * @param {{ id: string, name: string, difficulty?: number, endTime?: number, tempo?: number, measureBpms?: Record<string, number> | null } | null} meta - 曲メタ（選曲時）
     * @param {{ startAtPerfSec?: number } | undefined} [opts]
     */
    _startGamePlay(chart, meta, opts) {
        if (!this._songSelectEl || !this._gameContainerEl) return;
        this._songSelectEl.style.display = 'none';
        this._gameContainerEl.style.display = 'flex';
        const resultsEl = document.getElementById('taiko-results');
        if (resultsEl) resultsEl.style.display = 'none';

        const tempoRaw = meta && meta.tempo != null ? Number(meta.tempo) : NaN;
        this._chartBaseBpm = Number.isFinite(tempoRaw) && tempoRaw >= 1 && tempoRaw <= 500 ? tempoRaw : 120;
        this._chartMeasureBpms = (meta && meta.measureBpms && typeof meta.measureBpms === 'object')
            ? { ...meta.measureBpms }
            : {};
        this._chart = this._applyWallTimesToChart(this._normalizeChart(chart));
        this._chartMeta = meta || null;
        this._score = 0;
        const donKaCount = this._chart.filter((n) => n.type !== 'roll').length;
        this._maxScore = donKaCount * 100;
        this._rollCount = 0;
        this._judgeCounts = { good: 0, ok: 0, miss: 0 };
        this._currentCombo = 0;
        this._maxCombo = 0;
        this._activeNotes = [];
        this._processedChartIndices = new Set();
        this._updateScoreDisplay();
        if (this._notesContainer) this._notesContainer.innerHTML = '';
        this._startTime = (opts && typeof opts.startAtPerfSec === 'number')
            ? opts.startAtPerfSec
            : (performance.now() / 1000);

        document.addEventListener('keydown', this._boundKeyDown);
        this._loop();
    }

    /**
     * roll-start/roll-end のペアを roll に変換。既存の roll はそのまま。
     * @param {Array} chart
     * @returns {Array}
     */
    _normalizeChart(chart) {
        const result = [];
        const starts = [];
        const sorted = [...chart].sort((a, b) => {
            const ta = a.type === 'roll' ? a.startTime : a.time;
            const tb = b.type === 'roll' ? b.startTime : b.time;
            return (ta ?? 0) - (tb ?? 0);
        });
        for (const n of sorted) {
            if (n.type === 'roll-start') {
                starts.push(n.time);
            } else if (n.type === 'roll-end' && starts.length > 0) {
                const start = starts.shift();
                if (n.time > start) result.push({ type: 'roll', startTime: start, endTime: n.time });
            } else if (n.type !== 'roll-start' && n.type !== 'roll-end') {
                result.push(n);
            }
        }
        return result.sort((a, b) => {
            const ta = a.type === 'roll' ? a.startTime : a.time;
            const tb = b.type === 'roll' ? b.startTime : b.time;
            return (ta ?? 0) - (tb ?? 0);
        });
    }

    /**
     * グリッド上の時刻を実時間に変換（インスタンスのベース BPM・小節 BPM を使用）
     * @param {number} uSec
     */
    _wallAtUniform(uSec) {
        return taikoWallAtUniform(uSec, this._chartBaseBpm, this._chartMeasureBpms);
    }

    /**
     * 正規化済み譜面各ノーツに実時間でのヒット時刻を付与する
     * @param {Array<Record<string, unknown>>} chart
     */
    _applyWallTimesToChart(chart) {
        return chart.map((n) => {
            if (n.type === 'roll') {
                const ws = this._wallAtUniform(n.startTime ?? 0);
                const we = this._wallAtUniform(n.endTime ?? n.startTime ?? 0);
                return { ...n, _wallStart: ws, _wallEnd: we };
            }
            return { ...n, _wallHit: this._wallAtUniform(n.time ?? 0) };
        });
    }

    close() {
        if (!this._open) return;
        this._stopBgm();
        this._teardownMultiplayer();
        this._open = false;
        this._closeHintPopup();
        if (this._overlay) this._overlay.style.display = 'none';
        if (this._rafId) cancelAnimationFrame(this._rafId);
        if (this._notesContainer) this._notesContainer.innerHTML = '';
        this._activeNotes = [];
        this._chart = [];
        this._chartMeta = null;
        this._chartBaseBpm = 120;
        this._chartMeasureBpms = {};
        this._processedChartIndices = new Set();
        this._startTime = null;
        clearTimeout(this._judgeTimer);
        this._judgeTimer = null;
        if (this._judgeEl) {
            this._judgeEl.textContent = '';
            this._judgeEl.className = 'taiko-judge-text';
        }
        document.removeEventListener('keydown', this._boundKeyDown);
        const lobbyEl = document.getElementById('taiko-mp-lobby');
        if (lobbyEl) lobbyEl.style.display = 'none';
    }

    /**
     * マルチプレイ用 Socket ルームから離脱しリスナーを外す
     */
    _teardownMultiplayer() {
        const z = this._mpZone;
        if (this._socket && z) {
            this._socket.emit('taiko-mp-leave', { worldId: z.worldId, groupId: z.groupId });
        }
        if (this._socket && this._mpOnState) {
            this._socket.off('taiko-mp-state', this._mpOnState);
        }
        if (this._socket && this._mpOnSyncStart) {
            this._socket.off('taiko-mp-sync-start', this._mpOnSyncStart);
        }
        if (this._socket && this._mpOnResults) {
            this._socket.off('taiko-mp-results', this._mpOnResults);
        }
        this._mpOnState = null;
        this._mpOnSyncStart = null;
        this._mpOnResults = null;
        this._mpZone = null;
        this._mpClaimedPart = null;
        this._mpPartNames = {};
        this._mpReadySent = false;
        this._mpNeedsBgm = false;
        this._mpGameStarted = false;
    }

    /**
     * マルチロビー UI と Socket 参加
     */
    _setupMultiplayerLobby() {
        const z = this._mpZone;
        const hintEl = document.getElementById('taiko-mp-lobby-hint');
        const statusEl = document.getElementById('taiko-mp-status');
        const wrap = document.getElementById('taiko-mp-part-buttons');
        if (!z || !wrap) return;
        if (hintEl) {
            hintEl.textContent = `グループ「${z.groupId}」・${z.slotCount}人でプレイ。パートを選んでください。`;
        }
        if (statusEl) statusEl.textContent = '';
        wrap.innerHTML = '';

        if (!this._socket || !this._socket.connected) {
            if (statusEl) statusEl.textContent = '接続されていません。ページを再読み込みしてください。';
            return;
        }

        for (let i = 1; i <= z.slotCount; i++) {
            const row = document.createElement('div');
            row.className = 'taiko-mp-part-row';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = this._mpPartNames[i] && this._mpPartNames[i].trim() ? this._mpPartNames[i].trim() : `${i}P`;
            btn.dataset.part = String(i);
            btn.addEventListener('click', () => this._multiplayerClaimPart(i));

            const pill = document.createElement('span');
            pill.className = 'taiko-mp-part-pill';
            pill.dataset.part = String(i);
            pill.textContent = '未参加';

            row.appendChild(btn);
            row.appendChild(pill);
            wrap.appendChild(row);
        }

        // 譜面に設定された初期パート名（charts.partNames）を反映
        fetch('/api/charts')
            .then((r) => (r.ok ? r.json() : {}))
            .then((charts) => {
                const c = charts && z.multiplayerChartId ? charts[z.multiplayerChartId] : null;
                const pn = c && c.partNames && typeof c.partNames === 'object' ? c.partNames : null;
                const bgmVersion = c && c.bgmVersion != null ? c.bgmVersion : null;
                this._mpNeedsBgm = bgmVersion != null;
                if (!pn) return;
                for (let i = 1; i <= z.slotCount; i++) {
                    const v = pn[i] || pn[`p${i}`];
                    if (typeof v !== 'string' || !v.trim()) continue;
                    const s = v.trim().slice(0, 20);
                    this._mpPartNames[i] = s;
                    const btn = wrap.querySelector(`button[data-part="${i}"]`);
                    if (btn instanceof HTMLButtonElement) btn.textContent = s;
                }
            })
            .catch(() => {});

        // 時刻同期をロビー入室時に数回サンプリング
        (async () => {
            for (let i = 0; i < 7; i++) {
                await this._sampleServerOffset();
                await new Promise((r) => setTimeout(r, 200));
            }
        })();

        this._mpOnState = (payload) => this._onMultiplayerState(payload);
        this._mpOnSyncStart = (payload) => this._onMultiplayerSyncStart(payload);
        this._mpOnResults = (payload) => this._onMultiplayerResults(payload);
        this._socket.on('taiko-mp-state', this._mpOnState);
        this._socket.on('taiko-mp-sync-start', this._mpOnSyncStart);
        this._socket.on('taiko-mp-results', this._mpOnResults);

        this._socket.emit('taiko-mp-join', {
            worldId: z.worldId,
            groupId: z.groupId,
            slotCount: z.slotCount,
            chartId: z.multiplayerChartId
        }, (ack) => {
            if (!ack || !ack.ok) {
                if (statusEl) statusEl.textContent = 'ルームに入れませんでした。';
            }
        });
    }

    /**
     * @param {number} partIndex 1..3
     */
    _multiplayerClaimPart(partIndex) {
        const z = this._mpZone;
        if (!this._socket || !z) return;
        // ユーザー操作でWebAudioをアンロック
        const ctx = this._ensureBgmAudioCtx();
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});

        this._socket.emit('taiko-mp-claim-part', {
            worldId: z.worldId,
            groupId: z.groupId,
            partIndex
        }, (ack) => {
            const statusEl = document.getElementById('taiko-mp-status');
            if (ack && ack.ok) {
                this._mpClaimedPart = partIndex;
                const btn = document.querySelector(`#taiko-mp-part-buttons button[data-part="${partIndex}"]`);
                const label = (btn && btn instanceof HTMLButtonElement && btn.textContent) ? btn.textContent : `${partIndex}P`;
                if (statusEl) statusEl.textContent = `${label} を選択しました`;

                // BGMの事前デコード完了まで ready を送らない（BGMなしなら即ready）
                this._mpReadySent = false;
                const pill = document.querySelector(`.taiko-mp-part-pill[data-part="${partIndex}"]`);
                if (pill && pill instanceof HTMLElement) {
                    pill.classList.remove('ready');
                    pill.classList.add('loading');
                    pill.textContent = this._mpNeedsBgm ? 'BGM読込中' : '準備中';
                }

                this._prepareMultiplayerBgmAndReady().catch((e) => {
                    if (statusEl) statusEl.textContent = 'BGMの準備に失敗: ' + (e?.message || e);
                });
            } else if (statusEl) {
                statusEl.textContent = ack?.error === 'taken'
                    ? 'このパートは埋まっています'
                    : ack?.error === 'in_game'
                        ? '演奏中はパートを変更できません'
                        : '選択できませんでした';
            }
        });
    }

    async _prepareMultiplayerBgmAndReady() {
        const z = this._mpZone;
        if (!this._socket || !z || this._mpClaimedPart == null) return;
        const chartId = z.multiplayerChartId;
        let bgmVersion = null;
        try {
            const res = await fetch('/api/charts');
            const charts = res.ok ? await res.json() : {};
            const c = charts[chartId];
            bgmVersion = c && c.bgmVersion != null ? c.bgmVersion : null;
        } catch {}

        if (bgmVersion == null) {
            // BGM無し: 即ready
            this._mpNeedsBgm = false;
            this._socket.emit('taiko-mp-ready', { worldId: z.worldId, groupId: z.groupId, partIndex: this._mpClaimedPart, ready: true });
            this._mpReadySent = true;
            const pill = document.querySelector(`.taiko-mp-part-pill[data-part="${this._mpClaimedPart}"]`);
            if (pill && pill instanceof HTMLElement) {
                pill.classList.remove('loading');
                pill.classList.add('ready');
                pill.textContent = 'OK';
            }
            return;
        }

        this._mpNeedsBgm = true;
        await this._loadChartBgmBuffer(chartId, bgmVersion);
        if (!this._socket || !this._mpZone || this._mpClaimedPart == null) return;
        this._socket.emit('taiko-mp-ready', { worldId: z.worldId, groupId: z.groupId, partIndex: this._mpClaimedPart, ready: true });
        this._mpReadySent = true;
        const pill = document.querySelector(`.taiko-mp-part-pill[data-part="${this._mpClaimedPart}"]`);
        if (pill && pill instanceof HTMLElement) {
            pill.classList.remove('loading');
            pill.classList.add('ready');
            pill.textContent = 'OK';
        }
    }

    /**
     * @param {{ slotCount: number, parts: Record<string, { taken: boolean, name?: string }>, inGame?: boolean, startAt?: number }} payload
     */
    _onMultiplayerState(payload) {
        const z = this._mpZone;
        const wrap = document.getElementById('taiko-mp-part-buttons');
        if (!z || !payload || !wrap) return;
        const sc = payload.slotCount || z.slotCount;
        const parts = payload.parts || {};
        let allTaken = true;
        for (let i = 1; i <= sc; i++) {
            if (!parts[i] || !parts[i].taken) allTaken = false;
        }
        wrap.querySelectorAll('button').forEach((btn) => {
            const p = Number(btn.dataset.part);
            const taken = parts[p]?.taken;
            const name = parts[p]?.name;
            if (name && String(name).trim()) {
                btn.textContent = String(name).trim();
                this._mpPartNames[p] = String(name).trim();
            } else {
                btn.textContent = (this._mpPartNames[p] && this._mpPartNames[p].trim()) ? this._mpPartNames[p].trim() : `${p}P`;
            }
            btn.classList.remove('taiko-mp-part-mine', 'taiko-mp-part-taken');
            if (this._mpClaimedPart === p) {
                btn.classList.add('taiko-mp-part-mine');
            } else if (taken) {
                btn.classList.add('taiko-mp-part-taken');
            }
            btn.disabled = taken && this._mpClaimedPart !== p;
        });

        // ready状態（OK / 準備中）を全員分反映
        wrap.querySelectorAll('.taiko-mp-part-pill').forEach((pillEl) => {
            const pill = pillEl;
            if (!(pill instanceof HTMLElement)) return;
            const p = Number(pill.dataset.part);
            const taken = parts[p]?.taken;
            const ready = !!parts[p]?.ready;

            pill.classList.remove('ready', 'loading');
            if (!taken) {
                pill.textContent = '未参加';
                return;
            }
            if (ready) {
                pill.classList.add('ready');
                pill.textContent = 'OK';
            } else {
                pill.classList.add('loading');
                pill.textContent = this._mpNeedsBgm ? 'BGM読込中' : '準備中';
            }
        });

        const hintEl = document.getElementById('taiko-mp-lobby-hint');
        const statusEl = document.getElementById('taiko-mp-status');
        if (payload.inGame && payload.startAt) {
            const leftMs = Math.max(0, Number(payload.startAt) - Date.now());
            const sec = Math.ceil(leftMs / 1000);
            if (hintEl) hintEl.textContent = '満員になりました。まもなく開始します…';
            if (statusEl) statusEl.textContent = `開始まで ${sec} 秒`;
            const ring = document.querySelector('.taiko-mp-wait-ring');
            if (ring) ring.classList.add('countdown');

            // taiko-mp-sync-start を受け逃したケースを state から復旧
            if (!this._mpGameStarted && this._mpClaimedPart != null) {
                this._mpGameStarted = true;
                this._onMultiplayerSyncStart({
                    chartId: z.multiplayerChartId,
                    startAt: payload.startAt,
                    partIndex: this._mpClaimedPart
                });
            }
        } else {
            const ring = document.querySelector('.taiko-mp-wait-ring');
            if (ring) ring.classList.remove('countdown');
        }
    }

    /**
     * @param {{ startAt: number, chartId: string }} payload
     */
    _onMultiplayerSyncStart(payload) {
        const z = this._mpZone;
        if (!z || !payload || !payload.chartId) return;
        if (this._mpGameStarted) return;
        this._mpGameStarted = true;
        const part = payload.partIndex != null ? Number(payload.partIndex) : this._mpClaimedPart;
        if (part == null) return;

        const lobbyEl = document.getElementById('taiko-mp-lobby');
        if (lobbyEl) lobbyEl.style.display = 'none';
        if (this._socket && this._mpOnState) {
            this._socket.off('taiko-mp-state', this._mpOnState);
        }
        if (this._socket && this._mpOnSyncStart) {
            this._socket.off('taiko-mp-sync-start', this._mpOnSyncStart);
        }
        this._mpOnState = null;
        this._mpOnSyncStart = null;

        const startAt = Number(payload.startAt) || Date.now();
        const delayMs = Math.max(0, startAt - this._estimatedServerNowMs());
        const startAtPerfSec = (performance.now() / 1000) + (delayMs / 1000);

        // BGMスケジューリング（存在する場合）
        const ctx = this._ensureBgmAudioCtx();
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
        (async () => {
            try {
                const res = await fetch('/api/charts');
                const charts = res.ok ? await res.json() : {};
                const c = charts[payload.chartId];
                const bgmVersion = c && c.bgmVersion != null ? c.bgmVersion : null;
                if (bgmVersion == null) return;
                const buf = await this._loadChartBgmBuffer(payload.chartId, bgmVersion);
                if (!buf || !ctx) return;
                this._stopBgm();
                const gain = ctx.createGain();
                gain.gain.value = 0.42;
                gain.connect(ctx.destination);
                this._bgmGain = gain;
                const src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(gain);
                this._bgmSource = src;
                const when = ctx.currentTime + Math.max(0, delayMs / 1000);
                src.start(when);
            } catch {}
        })();

        setTimeout(async () => {
            try {
                const res = await fetch('/api/charts');
                const charts = res.ok ? await res.json() : {};
                const c = charts[payload.chartId];
                const notes = this._notesForMultiplayerPart(c, part);
                if (!notes || !Array.isArray(notes) || notes.length === 0) {
                    window.alert(`パート${part}の譜面がありません。管理画面の譜面で${part === 1 ? '1P' : part === 2 ? '2P' : '3P'}を設定してください。`);
                    this._mpZone = null;
                    this.close();
                    return;
                }
                const meta = {
                    id: payload.chartId,
                    name: c?.name || payload.chartId,
                    difficulty: c?.difficulty,
                    endTime: c?.endTime,
                    tempo: c?.tempo,
                    measureBpms: c?.measureBpms
                };
                this._startGamePlay(notes, meta, { startAtPerfSec });
            } catch (e) {
                window.alert('譜面の取得に失敗しました');
                this.close();
            }
        }, Math.max(0, startAtPerfSec * 1000 - performance.now()));
    }

    /**
     * マルチの最終リザルト（全員終了後）
     * @param {{ chartId?: string, totalScore?: number, players?: Array<{ partIndex: number, name: string, score: number }> }} payload
     */
    _onMultiplayerResults(payload) {
        const resultsEl = document.getElementById('taiko-results');
        if (!resultsEl) return;
        const total = Math.max(0, Math.floor(Number(payload?.totalScore) || 0));
        const players = Array.isArray(payload?.players) ? payload.players : [];

        if (this._gameContainerEl) this._gameContainerEl.style.display = 'none';
        if (this._songSelectEl) this._songSelectEl.style.display = 'none';
        const lobbyEl = document.getElementById('taiko-mp-lobby');
        if (lobbyEl) lobbyEl.style.display = 'none';

        const songNameEl = document.getElementById('taiko-results-song-name');
        if (songNameEl) songNameEl.textContent = '総合得点';
        const userEl = document.getElementById('taiko-results-username');
        if (userEl) userEl.textContent = `合計 ${total}点`;
        const diffEl = document.getElementById('taiko-results-difficulty');
        if (diffEl) diffEl.textContent = 'マルチプレイ';
        const scoreValEl = document.getElementById('taiko-results-score-value');
        if (scoreValEl) scoreValEl.textContent = String(total);
        const goodEl = document.getElementById('taiko-results-good');
        const okEl = document.getElementById('taiko-results-ok');
        const missEl = document.getElementById('taiko-results-miss');
        const comboEl = document.getElementById('taiko-results-max-combo');
        const rollEl = document.getElementById('taiko-results-roll');
        if (goodEl) goodEl.textContent = '-';
        if (okEl) okEl.textContent = '-';
        if (missEl) missEl.textContent = '-';
        if (comboEl) comboEl.textContent = '-';
        if (rollEl) rollEl.textContent = '-';
        const fillEl = document.getElementById('taiko-results-clear-fill');
        if (fillEl) fillEl.style.width = '100%';

        const listEl = document.getElementById('taiko-results-ranking-list');
        if (listEl) {
            listEl.innerHTML = '';
            players.sort((a, b) => a.partIndex - b.partIndex).forEach((p) => {
                const li = document.createElement('li');
                const name = (p.name && String(p.name).trim())
                    ? String(p.name).trim()
                    : (this._mpPartNames[p.partIndex] && this._mpPartNames[p.partIndex].trim())
                        ? this._mpPartNames[p.partIndex].trim()
                        : `P${p.partIndex}`;
                li.textContent = `${name} ${p.score}点`;
                listEl.appendChild(li);
            });
        }
        resultsEl.style.display = 'flex';
    }

    /**
     * @param {Record<string, unknown> | undefined} chart
     * @param {number} part 1|2|3
     * @returns {Array<unknown> | null}
     */
    _notesForMultiplayerPart(chart, part) {
        if (!chart) return null;
        if (part === 1) return Array.isArray(chart.notes) ? chart.notes : null;
        if (part === 2) return Array.isArray(chart.notes2) ? chart.notes2 : null;
        if (part === 3) return Array.isArray(chart.notes3) ? chart.notes3 : null;
        return null;
    }

    // ------------------------------------------------------------------ private

    /**
     * キーボード入力ハンドラ
     * ドン: F・J  カツ: D・K
     */
    _onKeyDown(e) {
        if (!this._open) return;
        if (e.code === 'Escape') { this.close(); return; }
        if (e.code === 'KeyF' || e.code === 'KeyJ') this._hit('don');
        if (e.code === 'KeyD' || e.code === 'KeyK') this._hit('ka');
    }

    /**
     * ドン／カのデコード済みバッファを確保する（BGM と同じ AudioContext を使用）
     * @returns {Promise<void>}
     */
    _ensureHitSoundBuffers() {
        if (this._hitSoundBuffers?.don && this._hitSoundBuffers?.ka) return Promise.resolve();
        if (this._hitSoundDecodePromise) return this._hitSoundDecodePromise;
        const ctx = this._ensureBgmAudioCtx();
        if (!ctx) return Promise.resolve();
        const load = async (url) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(res.statusText);
            const ab = await res.arrayBuffer();
            return ctx.decodeAudioData(ab.slice(0));
        };
        this._hitSoundDecodePromise = Promise.all([load(SOUND_DON), load(SOUND_KA)])
            .then(([don, ka]) => {
                this._hitSoundBuffers = { don, ka };
            })
            .finally(() => {
                this._hitSoundDecodePromise = null;
            });
        return this._hitSoundDecodePromise;
    }

    /**
     * ドン／カッのヒット音を再生する（譜面 volume は 10%〜300%）
     * @param {'don'|'ka'} type
     * @param {number} [volumeMultiplier=1]
     */
    _playHitSound(type, volumeMultiplier = 1) {
        const v = clampChartNoteVolume(volumeMultiplier);
        const playWithBuffer = () => {
            const ctx = this._ensureBgmAudioCtx();
            if (!ctx || !this._hitSoundBuffers?.don || !this._hitSoundBuffers?.ka) return false;
            const buf = type === 'ka' ? this._hitSoundBuffers.ka : this._hitSoundBuffers.don;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            const src = ctx.createBufferSource();
            const gain = ctx.createGain();
            src.buffer = buf;
            gain.gain.value = v;
            src.connect(gain);
            gain.connect(ctx.destination);
            src.start();
            return true;
        };
        const playFallback = () => {
            const audio = new Audio(type === 'don' ? SOUND_DON : SOUND_KA);
            audio.volume = Math.min(1, v);
            audio.play().catch(() => {});
        };
        if (this._hitSoundBuffers?.don && this._hitSoundBuffers?.ka) {
            if (!playWithBuffer()) playFallback();
            return;
        }
        this._ensureHitSoundBuffers()
            .then(() => {
                if (!playWithBuffer()) playFallback();
            })
            .catch(() => playFallback());
    }

    /**
     * ヒット判定処理（ノーツが判定ラインに触れているか＝位置で判定）
     * @param {'don'|'ka'} type
     */
    _hit(type) {
        if (!this._open) return;

        this._flashButton(type);

        if (this._socket) {
            const z = this._mpZone;
            const multiplayer = !!z;
            this._socket.emit('taiko-hit', {
                type,
                multiplayer,
                worldId: multiplayer ? z.worldId : undefined,
                groupId: multiplayer ? z.groupId : undefined
            });
        }

        const laneEl = this._notesContainer?.parentElement;
        if (!laneEl) return;
        const laneRect = laneEl.getBoundingClientRect();
        const judgeLineX = laneRect.left + JUDGE_LINE_LEFT_PX;

        let best = null;
        let bestDistancePx = Infinity;
        for (const note of this._activeNotes) {
            if (note.hit || note.type !== type || !note.el) continue;
            const rect = note.el.getBoundingClientRect();
            const noteCenterX = (rect.left + rect.right) / 2;
            const distancePx = Math.abs(noteCenterX - judgeLineX);
            if (distancePx < bestDistancePx) {
                bestDistancePx = distancePx;
                best = note;
            }
        }

        const volFromSrc = (activeNote) => {
            const sn = activeNote?.srcNote;
            if (!sn || sn.type === 'roll') return 1;
            return clampChartNoteVolume(sn.volume);
        };

        if (best) {
            if (bestDistancePx <= JUDGE_GOOD_PX) {
                this._playHitSound(type, volFromSrc(best));
                this._judge('good', best);
            } else if (bestDistancePx <= JUDGE_OK_PX) {
                this._playHitSound(type, volFromSrc(best));
                this._judge('ok', best);
            } else {
                this._playHitSound(type, 1);
            }
            return;
        }

        const now = this._now();
        const inRoll = this._chart.some(
            (n) => n.type === 'roll' && now >= (n._wallStart ?? 0) && now <= (n._wallEnd ?? n._wallStart ?? 0)
        );
        if (inRoll) {
            this._rollCount++;
            this._playHitSound(type, 1);
            this._playHitSound(type, 1);
            this._showRollHitEffect();
        } else {
            this._playHitSound(type, 1);
        }
    }

    _judge(result, note) {
        note.hit = true;
        if (result === 'good') this._judgeCounts.good++;
        else if (result === 'ok') this._judgeCounts.ok++;
        if (result === 'good' || result === 'ok') {
            this._currentCombo++;
            if (this._currentCombo > this._maxCombo) this._maxCombo = this._currentCombo;
        }
        if (note.el) {
            note.el.classList.add('taiko-note-hit');
            this._removeNoteAfterEffect(note);
        }

        const points = result === 'good' ? 100 : result === 'ok' ? 50 : 0;
        this._score += points;
        this._updateScoreDisplay();

        this._showJudgeText(result);
    }

    /** 譜面左スペースのスコア表示を更新（太鼓の達人ベース: 良=100, 可=50, 不可=0） */
    _updateScoreDisplay() {
        if (this._scoreEl) this._scoreEl.textContent = String(this._score);
        if (this._scoreMaxEl) this._scoreMaxEl.textContent = String(this._maxScore);
        if (this._scoreRateEl) {
            const rate = this._maxScore > 0 ? Math.floor((this._score / this._maxScore) * 100) : 0;
            this._scoreRateEl.textContent = rate + '%';
        }
    }

    /** エフェクト終了後にノーツを DOM と _activeNotes から削除 */
    _removeNoteAfterEffect(note) {
        const el = note.el;
        if (!el) return;
        let done = false;
        const onEnd = () => {
            if (done) return;
            done = true;
            el.remove();
            note.el = null;
            this._activeNotes = this._activeNotes.filter(n => n !== note);
            if (note.chartIndex !== undefined) this._processedChartIndices.add(note.chartIndex);
        };
        el.addEventListener('animationend', onEnd, { once: true });
        setTimeout(onEnd, 380);
    }

    _showJudgeText(result) {
        if (!this._judgeEl) return;
        clearTimeout(this._judgeTimer);
        const labels = { good: '良', ok: '可', miss: '不可' };
        const label = labels[result] || result;
        this._judgeEl.textContent = label;
        this._judgeEl.className = `taiko-judge-text visible ${result}`;
        this._judgeTimer = setTimeout(() => {
            if (this._judgeEl) this._judgeEl.classList.remove('visible');
        }, 200);
    }

    /** 連打ヒット時の黄色エフェクト（判定表示＋ロールバーのフラッシュ＋judge周りのはじけるエフェクト） */
    _showRollHitEffect() {
        if (this._judgeEl) {
            clearTimeout(this._judgeTimer);
            this._judgeEl.textContent = '連打';
            this._judgeEl.className = 'taiko-judge-text visible roll';
            this._judgeTimer = setTimeout(() => {
                if (this._judgeEl) this._judgeEl.classList.remove('visible');
            }, 150);
        }
        this._showJudgeBurstEffect();
        const now = this._now();
        for (const note of this._activeNotes) {
            if (note.type === 'roll' && note.el && !note.hit) {
                const endT = note.endTime ?? note.targetTime;
                if (now >= (note.targetTime ?? 0) && now <= endT) {
                    note.el.classList.remove('taiko-roll-hit');
                    void note.el.offsetWidth;
                    note.el.classList.add('taiko-roll-hit');
                    setTimeout(() => note.el?.classList.remove('taiko-roll-hit'), 150);
                    break;
                }
            }
        }
    }

    /** judge.png の周りから黄色がはじけるエフェクト */
    _showJudgeBurstEffect() {
        const burstEl = document.getElementById('taiko-judge-burst');
        if (!burstEl) return;
        const particleCount = 16;
        const distance = 72;
        burstEl.innerHTML = '';
        const ring = document.createElement('span');
        ring.className = 'taiko-burst-ring';
        burstEl.appendChild(ring);
        for (let i = 0; i < particleCount; i++) {
            const angle = (i / particleCount) * Math.PI * 2;
            const x = Math.cos(angle) * distance;
            const y = Math.sin(angle) * distance;
            const p = document.createElement('span');
            p.className = 'taiko-burst-particle';
            p.style.setProperty('--burst-offset', `translate(${x}px, ${y}px)`);
            p.style.animationDelay = `${(i / particleCount) * 0.03}s`;
            burstEl.appendChild(p);
        }
        setTimeout(() => { burstEl.innerHTML = ''; }, 400);
    }

    _flashButton(type) {
        const targets = type === 'don' ? ['taiko-drum'] : ['taiko-ka-zone'];
        targets.forEach(targetId => {
            const el = document.getElementById(targetId);
            if (!el) return;
            el.classList.remove('active');
            void el.offsetWidth;
            el.classList.add('active');
            setTimeout(() => el.classList.remove('active'), 150);
        });
    }

    /** ゲーム開始からの経過秒数 */
    _now() {
        return performance.now() / 1000 - this._startTime;
    }

    /**
     * ノーツを追加生成・位置更新・削除するメインループ
     */
    _loop() {
        if (!this._open) return;

        const now = this._now();
        const laneWidth = this._notesContainer?.offsetWidth || 600;
        const rightEdge = laneWidth - 32;
        const laneSpan = rightEdge - JUDGE_LINE_LEFT_PX;

        // 新規ノーツ生成（到達時刻 - NOTE_TRAVEL_TIME 秒前に出現）
        this._chart.forEach((note, chartIndex) => {
            if (this._processedChartIndices.has(chartIndex)) return;
            const hitWall = note.type === 'roll' ? note._wallStart : note._wallHit;
            const spawnWall = (hitWall ?? 0) - NOTE_TRAVEL_TIME;
            const exists = this._activeNotes.some(n => n.chartIndex === chartIndex);
            if (!exists && now >= spawnWall) {
                const el = document.createElement('div');
                if (note.type === 'roll') {
                    el.className = 'taiko-note taiko-note-roll';
                    el.textContent = '連打';
                    const duration = (note._wallEnd ?? 0) - (note._wallStart ?? 0);
                    const widthPx = Math.max(40, (duration / NOTE_TRAVEL_TIME) * laneSpan);
                    el.style.width = widthPx + 'px';
                    el.style.boxSizing = 'border-box';
                    this._notesContainer?.appendChild(el);
                    this._activeNotes.push({
                        el,
                        targetTime: note._wallStart ?? 0,
                        endTime: note._wallEnd ?? note._wallStart ?? 0,
                        type: 'roll',
                        hit: false,
                        chartIndex,
                        srcNote: note
                    });
                } else {
                    el.className = `taiko-note ${note.type}`;
                    el.textContent = note.type === 'don' ? 'ドン' : 'カッ';
                    const vm = clampChartNoteVolume(note.volume);
                    el.style.transform = `translateY(-50%) scale(${vm})`;
                    this._notesContainer?.appendChild(el);
                    this._activeNotes.push({
                        el,
                        targetTime: note._wallHit ?? 0,
                        type: note.type,
                        hit: false,
                        chartIndex,
                        srcNote: note
                    });
                }
            }
        });

        let missShownThisFrame = false;

        // ノーツ位置更新
        for (const note of this._activeNotes) {
            if (note.hit) continue;
            const remaining = note.targetTime - now;
            const left = JUDGE_LINE_LEFT_PX + remaining / NOTE_TRAVEL_TIME * laneSpan;
            if (note.el) {
                note.el.style.left = note.type === 'roll' ? `${left}px` : `${left - 32}px`;
            }

            if (note.type === 'roll') {
                if (now > (note.endTime ?? note.targetTime)) {
                    note.el?.remove();
                    note.el = null;
                    note.hit = true;
                    this._processedChartIndices.add(note.chartIndex);
                }
                continue;
            }

            // 不可: 判定ラインから JUDGE_MISS_PX を超えて通過したら miss。エフェクト後に削除
            const distancePx = Math.abs(remaining) * laneSpan / NOTE_TRAVEL_TIME;
            if (remaining < 0 && distancePx > JUDGE_MISS_PX && !missShownThisFrame) {
                note.hit = true;
                this._currentCombo = 0;
                this._judgeCounts.miss++;
                if (note.el) {
                    note.el.classList.add('taiko-note-miss');
                    this._removeNoteAfterEffect(note);
                }
                this._showJudgeText('miss');
                missShownThisFrame = true;
            } else if (remaining < 0 && distancePx > JUDGE_MISS_PX) {
                note.hit = true;
                this._currentCombo = 0;
                this._judgeCounts.miss++;
                if (note.el) {
                    note.el.classList.add('taiko-note-miss');
                    this._removeNoteAfterEffect(note);
                }
            }
        }

        // ヒット済みのうち、エフェクト未使用（即削除）のものだけここで削除。エフェクト中は animationend で削除。連打は即削除。
        this._activeNotes = this._activeNotes.filter(note => {
            if (!note.hit) return true;
            const el = note.el;
            if (note.type === 'roll' || !el) {
                if (note.chartIndex !== undefined) this._processedChartIndices.add(note.chartIndex);
                return false;
            }
            if (el.classList.contains('taiko-note-hit') || el.classList.contains('taiko-note-miss')) return true;
            el.remove();
            note.el = null;
            if (note.chartIndex !== undefined) this._processedChartIndices.add(note.chartIndex);
            return false;
        });

        // 曲終了チェック: 終了時間を過ぎた、または全ノーツ処理済みで余韻後（実時間）
        const getNoteEndWall = (n) => (n.type === 'roll' ? (n._wallEnd ?? 0) : (n._wallHit ?? 0));
        const lastNoteWall = this._chart.length ? Math.max(...this._chart.map(getNoteEndWall)) : 0;
        const endWall = this._chartMeta?.endTime != null
            ? this._wallAtUniform(this._chartMeta.endTime)
            : lastNoteWall + 1;
        const allDone = this._chart.length > 0 && this._activeNotes.every(n => n.hit);
        if (allDone && now >= endWall) {
            this._rafId = null;
            setTimeout(() => this._onSongEnd(), 300);
            return;
        }

        this._rafId = requestAnimationFrame(() => this._loop());
    }

    /**
     * 曲終了時: 成績発表・ランキングを表示する
     */
    async _onSongEnd() {
        document.removeEventListener('keydown', this._boundKeyDown);
        if (this._gameContainerEl) this._gameContainerEl.style.display = 'none';

        const meta = this._chartMeta || {};
        const chartId = meta.id;
        const username = typeof localStorage !== 'undefined' ? (localStorage.getItem('username') || 'プレイヤー') : 'プレイヤー';

        // マルチ: 全員終了後に総合リザルトを出す（ここでは終了通知だけ送って待機表示へ）
        if (this._socket && this._mpZone && this._mpClaimedPart != null) {
            const z = this._mpZone;
            const lobbyEl = document.getElementById('taiko-mp-lobby');
            if (lobbyEl) lobbyEl.style.display = 'flex';
            const hintEl = document.getElementById('taiko-mp-lobby-hint');
            const statusEl = document.getElementById('taiko-mp-status');
            const wrap = document.getElementById('taiko-mp-part-buttons');
            if (this._songSelectEl) this._songSelectEl.style.display = 'none';
            if (wrap) wrap.innerHTML = '';
            if (hintEl) hintEl.textContent = '演奏終了。ほかのプレイヤーの終了を待っています…';
            if (statusEl) statusEl.textContent = '';

            this._socket.emit('taiko-mp-finish', {
                worldId: z.worldId,
                groupId: z.groupId,
                partIndex: this._mpClaimedPart,
                score: this._score
            });
            return;
        }

        if (chartId) {
            try {
                await fetch('/api/charts/' + encodeURIComponent(chartId) + '/score', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, score: this._score })
                });
            } catch (e) {}
        }

        const resultsEl = document.getElementById('taiko-results');
        if (!resultsEl) return;

        document.getElementById('taiko-results-song-name').textContent = meta.name || '曲名';
        document.getElementById('taiko-results-username').textContent = username;
        const diffLabels = ['かんたん', 'ふつう', 'むずかしい', 'おに'];
        const diff = meta.difficulty != null ? meta.difficulty : 1;
        document.getElementById('taiko-results-difficulty').textContent = diffLabels[Math.min(diff, 3)] || 'ふつう';
        document.getElementById('taiko-results-score-value').textContent = String(this._score);
        document.getElementById('taiko-results-good').textContent = String(this._judgeCounts.good);
        document.getElementById('taiko-results-ok').textContent = String(this._judgeCounts.ok);
        document.getElementById('taiko-results-miss').textContent = String(this._judgeCounts.miss);
        document.getElementById('taiko-results-max-combo').textContent = String(this._maxCombo);
        document.getElementById('taiko-results-roll').textContent = String(this._rollCount);
        const clearRate = this._maxScore > 0 ? Math.min(1, this._score / this._maxScore) : 0;
        const fillEl = document.getElementById('taiko-results-clear-fill');
        if (fillEl) fillEl.style.width = `${Math.round(clearRate * 100)}%`;

        const listEl = document.getElementById('taiko-results-ranking-list');
        listEl.innerHTML = '';
        let ranking = [];
        if (chartId) {
            try {
                const res = await fetch('/api/charts/' + encodeURIComponent(chartId) + '/ranking');
                ranking = res.ok ? await res.json() : [];
            } catch (e) {}
        }
        for (let i = 0; i < 10; i++) {
            const li = document.createElement('li');
            const entry = ranking[i];
            if (entry) {
                li.textContent = `${i + 1} ${entry.username} ${entry.score}点`;
                li.classList.remove('taiko-results-ranking-empty');
            } else {
                li.textContent = `${i + 1} - -`;
                li.classList.add('taiko-results-ranking-empty');
            }
            listEl.appendChild(li);
        }

        resultsEl.style.display = 'flex';
    }

    /**
     * 成績発表を閉じて選曲に戻る
     */
    _closeResults() {
        const resultsEl = document.getElementById('taiko-results');
        if (resultsEl) resultsEl.style.display = 'none';
        // マルチ: リザルトを閉じたら太鼓メニュー自体も閉じて元に戻す（選曲に戻らない）
        if (this._mpZone) {
            this.close();
            return;
        }
        const lobbyEl = document.getElementById('taiko-mp-lobby');
        if (lobbyEl && lobbyEl.style.display !== 'none') return;
        if (this._songSelectEl) this._songSelectEl.style.display = 'flex';
    }
}

export default TaikoGameManager;
