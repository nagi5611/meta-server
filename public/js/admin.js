let currentAlertTarget = null;
/** セレクター補完用のプレイヤー一覧（loadPlayers で更新） */
let cachedPlayersForCompletion = [];
/** tp コマンド用ワールドID一覧（loadWorldsForCompletion で更新） */
let cachedWorldIdsForCompletion = [];

// Update interval (2 seconds)
const UPDATE_INTERVAL = 2000;
// Bandwidth graph poll (1 second for smooth graph)
const BANDWIDTH_POLL_INTERVAL = 1000;
const BANDWIDTH_HISTORY_MAX = 60; // 60 points = 1 min at 1s poll

let lastTrafficSample = null;
let bandwidthHistory = [];
let worldEditInitialized = false;
let chartPanelInitialized = false;
/** 譜面作成パネルで選択中の譜面ID */
let selectedChartId = null;
/** 譜面一覧のキャッシュ（renderChartList/selectChart で参照） */
let cachedCharts = {};
/** 編集中のノーツ配列（{ time, type, volume? }[] または { type:'roll', startTime, endTime }[]）。譜面編集エリアと同期 */
let editingNotes = [];
/** 譜面エディタ: ノーツ音量ドラッグ中の pointerId。-1 はなし */
let chartVolumeDragPointerId = -1;
/** ドン・カノーツの音量倍率（1.0=100%、0.1〜3.0） */
const NOTE_VOLUME_MIN = 0.1;
const NOTE_VOLUME_MAX = 3;
/** 縦移動がこの px を超えたら音量ドラッグとみなす（クリック選択と区別） */
const CHART_NOTE_VOLUME_DRAG_THRESHOLD_PX = 4;

/**
 * ノーツ音量を 10%〜300% に丸める（未指定は 100%）
 * @param {unknown} v
 * @returns {number}
 */
function clampNoteVolume(v) {
    const x = Number(v);
    if (!Number.isFinite(x)) return 1;
    return Math.min(NOTE_VOLUME_MAX, Math.max(NOTE_VOLUME_MIN, x));
}

/**
 * エディタ表示・保存用の音量（don/ka のみ。既定 1）
 * @param {{ type?: string, volume?: unknown } | null | undefined} note
 * @returns {number}
 */
function getNoteVolumeForEditor(note) {
    if (!note || (note.type !== 'don' && note.type !== 'ka')) return 1;
    return clampNoteVolume(note.volume != null ? note.volume : 1);
}

/**
 * セル内のポインタ Y からノーツ音量を算出（中心=10%、端=300%）
 * @param {number} clientY
 * @param {DOMRect} cellRect
 * @returns {number}
 */
function chartNoteVolumeFromPointerY(clientY, cellRect) {
    const cy = (cellRect.top + cellRect.bottom) / 2;
    const half = Math.max(1, cellRect.height / 2);
    const dist = Math.abs(clientY - cy);
    const t = Math.min(1, dist / half);
    return NOTE_VOLUME_MIN + t * (NOTE_VOLUME_MAX - NOTE_VOLUME_MIN);
}

/**
 * ドラッグ中チップのセル内 Y から音量を決め、指定した全ドン・カに同じ volume を適用する
 * @param {number | number[]} noteIndices 単一インデックスまたは配列
 * @param {number} clientY
 * @param {HTMLElement} chipEl ドラッグ起点のチップ（セル座標の基準）
 */
function applyChartNoteVolumeFromPointer(noteIndices, clientY, chipEl) {
    const cell = chipEl.parentElement;
    if (!cell) return;
    const rect = cell.getBoundingClientRect();
    const vol = clampNoteVolume(chartNoteVolumeFromPointerY(clientY, rect));
    const list = Array.isArray(noteIndices) ? noteIndices : [noteIndices];
    for (const ni of list) {
        const n = editingNotes[ni];
        if (!n || (n.type !== 'don' && n.type !== 'ka')) continue;
        n.volume = vol;
    }
    flushChartPartSlot();
    const grid = document.getElementById('chart-measures-grid');
    if (grid) {
        for (const ni of list) {
            const n = editingNotes[ni];
            if (!n || (n.type !== 'don' && n.type !== 'ka')) continue;
            const el = grid.querySelector(`.note-chip[data-index="${ni}"]`);
            if (el) el.style.height = `${Math.max(4, 16 * vol)}px`;
        }
    }
}
/** マルチプレイ用 1P/2P/3P の切替（1..3） */
let chartEditingPart = 1;
/** 選択中譜面のパート別ノーツ（インデックス 0=1P,1=2P,2=3P） */
let chartPartNoteSlots = [[], [], []];
/** 選択中譜面のパート名（1..3） */
let chartPartNames = { 1: '', 2: '', 3: '' };

/**
 * 「編集パート」タブ（1P/2P/3P）の表示名を更新する
 */
function updateChartPartTabLabels() {
    const b1 = document.getElementById('chart-part-tab-1');
    const b2 = document.getElementById('chart-part-tab-2');
    const b3 = document.getElementById('chart-part-tab-3');
    if (b1) b1.textContent = (chartPartNames[1] && chartPartNames[1].trim()) ? chartPartNames[1].trim() : '1P';
    if (b2) b2.textContent = (chartPartNames[2] && chartPartNames[2].trim()) ? chartPartNames[2].trim() : '2P';
    if (b3) b3.textContent = (chartPartNames[3] && chartPartNames[3].trim()) ? chartPartNames[3].trim() : '3P';
}
/** 譜面編集エリアで選択中のノーツ索引。-1 は未選択 */
let selectedNoteIndex = -1;
/** 譜面編集エリアで範囲選択中のノーツ索引（複数選択） */
let selectedNoteIndices = new Set();
/** コピーされたノーツ（範囲選択/単体選択）を保持する内部クリップボード */
let chartClipboard = null;
/** BPM入力の変更前後でグリッド位置を維持するため、直近の描画BPMを保持する */
let lastRenderedChartBpm = null;
/** 譜面ストリップ: 1秒あたりのピクセル数（ホイールで拡大縮小） */
let chartPixelsPerSecond = 60;
/** 譜面の表示時間範囲（秒）。ノーツの最大時間を下回らないよう render 内で拡張 */
const CHART_TIME_RANGE_DEFAULT = 60;
/** ホイールズームの倍率範囲 */
const CHART_ZOOM_MIN = 0.25;
const CHART_ZOOM_MAX = 4;
/** ノーツドラッグ中: 対象の索引。-1 はドラッグなし */
let noteDragIndex = -1;
/** ノーツドラッグ開始時の clientX */
let noteDragStartX = 0;
/** ノーツを実際にドラッグしたか（移動量で判定） */
let noteDragStarted = false;

/** 小節ごとのBPM上書き（barIndex -> bpm）。未指定は base BPM */
let chartMeasureBpms = {};

/** 譜面プレビュー再生の状態 */
let chartPreviewState = {
    playing: false,
    rafId: 0,
    startedAtPerfMs: 0,
    durationSec: 0,
    /** プレビュー開始位置（曲頭からの秒） */
    startOffsetSec: 0,
    /** 今回の再生長（実時間・秒）。小節BPMでグリッド時間に対する伸縮あり */
    playDurationSec: 0,
    /** 再生開始時の実時間オフセット（wallAtUniform(startOffsetSec)） */
    playbackWallAnchor: 0,
    sources: [],
    playheadEl: null,
    activeCellEl: null,
    /** 全パート再生時: 3行×4小節ビュー */
    allPartsPlayback: false,
    /** 表示中の4小節ブロック先頭（0始まり）。未初期化は -1 */
    playbackWindowStartBar: -1,
    /** 全パート再生時: ハイライトする各パートのセル */
    activeMultiCells: /** @type {HTMLElement[] | null} */ (null)
};

/** 譜面プレビュー用の音（WebAudio） */
let chartPreviewAudioCtx = null;
let chartPreviewAudioBuffers = {
    don: null,
    ka: null
};
/** プレビュー用BGMデコード済みバッファ（chartId:bgmVersion で無効化） */
let chartPreviewBgmCache = { key: '', buffer: /** @type {AudioBuffer | null} */ (null) };

/** ログインユーザー一覧の現在ページ（1始まり） */
let currentLoginUsersPage = 1;
const LOGIN_USERS_PAGE_SIZE = 50;

/**
 * 指定したパネル ID を表示し、サイドメニューの active を更新する。
 * ワールド編集パネルは初表示時に setting.js を動的 import して init する。
 */
function switchPanel(panelId) {
    document.querySelectorAll('.admin-panel').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.admin-nav-item').forEach((el) => el.classList.remove('active'));
    const panel = document.getElementById(panelId);
    const navItem = document.querySelector(`.admin-nav-item[data-panel="${panelId}"]`);
    if (panel) panel.classList.add('active');
    if (navItem) navItem.classList.add('active');

    if (panelId !== 'panel-chart') {
        stopChartPreview();
    }

    if (panelId === 'panel-world-edit' && !worldEditInitialized) {
        worldEditInitialized = true;
        import('/js/setting.js').then((m) => m.initSettingEditor()).catch((e) => console.error('Setting editor init failed:', e));
    }
    if (panelId === 'panel-user-register') {
        loadUsers();
    }
    if (panelId === 'panel-logs') {
        loadLoginUsers(currentLoginUsersPage);
    }
    if (panelId === 'panel-chart') {
        loadCharts();
        if (!chartPanelInitialized) {
            chartPanelInitialized = true;
            bindChartPanelEvents();
        }
    }
}

/** 保存キー: 管理画面テーマ 'light' | 'dark' */
const ADMIN_THEME_KEY = 'adminTheme';

/**
 * テーマを適用し、トグルボタンのアイコンを更新する
 */
function applyAdminTheme(isDark) {
    if (isDark) {
        document.body.classList.add('admin-dark');
        const icon = document.getElementById('admin-theme-icon');
        if (icon) {
            icon.className = 'bi bi-sun-fill';
            document.getElementById('admin-theme-toggle')?.setAttribute('title', 'ライトモードに切替');
        }
    } else {
        document.body.classList.remove('admin-dark');
        const icon = document.getElementById('admin-theme-icon');
        if (icon) {
            icon.className = 'bi bi-moon-fill';
            document.getElementById('admin-theme-toggle')?.setAttribute('title', 'ダークモードに切替');
        }
    }
}

/**
 * 譜面一覧を取得して表示する
 */
async function loadCharts() {
    const statusEl = document.getElementById('chart-status');
    const listEl = document.getElementById('chart-list');
    if (!listEl) return;
    try {
        const res = await fetch('/admin/charts');
        if (!res.ok) throw new Error(res.statusText);
        const charts = await res.json();
        cachedCharts = charts;
        renderChartList(charts);
        if (!selectedChartId) clearChartEditor();
        else updateChartBgmRowUi();
        statusEl.textContent = '';
    } catch (err) {
        statusEl.textContent = '取得失敗: ' + err.message;
        listEl.innerHTML = '';
    }
}

/**
 * 秒を mm:ss.ss 表示へ整形
 * @param {number} sec
 */
function formatChartPreviewTime(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(Math.floor(r)).padStart(2, '0');
    const cs = String(Math.floor((r - Math.floor(r)) * 100)).padStart(2, '0');
    return `${mm}:${ss}.${cs}`;
}

/**
 * 指定小節の有効BPMを返す（未設定ならbase BPM）
 * @param {number} barIndex
 */
function getEffectiveBpmForBar(barIndex) {
    const bi = Math.max(0, Number(barIndex) || 0);
    const ov = chartMeasureBpms && Object.prototype.hasOwnProperty.call(chartMeasureBpms, String(bi))
        ? Number(chartMeasureBpms[String(bi)])
        : NaN;
    if (Number.isFinite(ov) && ov >= 1 && ov <= 500) return ov;
    return getChartTempo();
}

/**
 * 編集グリッド用: ベースBPMのみで各小節の長さが一定のタイムライン上の秒 → 小節/16分割
 * （小節ごとのBPMはノーツ位置に影響しない）
 * @param {number} timeSec
 * @param {number} baseBpm
 * @returns {{ barIndex: number, stepIndex: number }}
 */
function timeToBarStepUniformSecs(timeSec, baseBpm) {
    const t = Math.max(0, Number(timeSec) || 0);
    const sec = getBarSec(baseBpm);
    if (sec <= 0) return { barIndex: 0, stepIndex: 0 };
    const barIndex = Math.floor(t / sec);
    const within = t - barIndex * sec;
    const stepSec = sec / 16;
    let stepIndex = Math.round(within / stepSec);
    if (stepIndex >= 16) stepIndex = 15;
    if (stepIndex < 0) stepIndex = 0;
    return { barIndex, stepIndex };
}

/**
 * 編集グリッド用: 小節/16分割 → ベースBPMの等間隔タイムライン上の秒
 * @param {number} barIndex
 * @param {number} stepIndex
 * @param {number} baseBpm
 */
function barStepToTimeUniformSecs(barIndex, stepIndex, baseBpm) {
    const bi = Math.max(0, Number(barIndex) || 0);
    const si = Math.max(0, Math.min(15, Number(stepIndex) || 0));
    const sec = getBarSec(baseBpm);
    return bi * sec + si * (sec / 16);
}

/**
 * グリッド時間(秒)を実時間(秒)へ。小節BPMが高いほど同じグリッド区間の実時間が短くなる。
 * @param {number} uSec
 */
function wallAtUniform(uSec) {
    const u = Math.max(0, Number(uSec) || 0);
    const base = getChartTempo();
    const Tuni = getBarSec(base);
    if (Tuni <= 0) return 0;
    const barIndex = Math.floor(u / Tuni);
    const within = u - barIndex * Tuni;
    let wall = 0;
    for (let i = 0; i < barIndex; i++) {
        wall += getBarSec(getEffectiveBpmForBar(i));
    }
    const Twall = getBarSec(getEffectiveBpmForBar(barIndex));
    wall += (within / Tuni) * Twall;
    return wall;
}

/**
 * 実時間(秒)をグリッド時間(秒)へ（wallAtUniform の逆変換）
 * @param {number} wallSec
 */
function uniformAtWall(wallSec) {
    let wallRem = Math.max(0, Number(wallSec) || 0);
    const base = getChartTempo();
    const Tuni = getBarSec(base);
    if (Tuni <= 0) return 0;
    let u = 0;
    let barIndex = 0;
    const maxBars = 200000;
    while (wallRem > 1e-9 && barIndex < maxBars) {
        const Twall = getBarSec(getEffectiveBpmForBar(barIndex));
        if (wallRem >= Twall) {
            wallRem -= Twall;
            u += Tuni;
            barIndex++;
        } else {
            u += (wallRem / Twall) * Tuni;
            wallRem = 0;
        }
    }
    return u;
}

/**
 * BPM/ベースBPM変更時に、ノーツの小節/位置（16分割）を維持したまま time(秒) を更新する
 * @param {number} oldBaseBpm
 * @param {number} newBaseBpm
 */
function retimeEditingNotesKeepGridPositionVarBpm(oldBaseBpm, newBaseBpm) {
    const ob = Number(oldBaseBpm);
    const nb = Number(newBaseBpm);
    if (!Number.isFinite(ob) || !Number.isFinite(nb) || ob <= 0 || nb <= 0) return;
    if (ob === nb) return;

    for (const n of editingNotes) {
        if (!n) continue;
        if (n.type === 'roll') {
            const s = Number(n.startTime ?? 0);
            const e = Number(n.endTime ?? n.startTime ?? 0);
            const ps = timeToBarStepUniformSecs(s, ob);
            const pe = timeToBarStepUniformSecs(e, ob);
            n.startTime = barStepToTimeUniformSecs(ps.barIndex, ps.stepIndex, nb);
            n.endTime = barStepToTimeUniformSecs(pe.barIndex, pe.stepIndex, nb);
            continue;
        }
        const t = Number(n.time ?? 0);
        const p = timeToBarStepUniformSecs(t, ob);
        n.time = barStepToTimeUniformSecs(p.barIndex, p.stepIndex, nb);
    }
}

/**
 * プレビューの再生総時間(秒)を算出（endTime入力優先、無ければ最大ノーツ時刻+1小節）
 */
function getChartPreviewDurationSec() {
    const endEl = document.getElementById('chart-edit-end-time');
    const endMeasuresInput = endEl && endEl.value !== '' ? Number(endEl.value) : NaN;
    const endMeasures = Number.isFinite(endMeasuresInput) ? Math.max(1, Math.floor(endMeasuresInput)) : null;
    const base = getChartTempo();
    if (endMeasures != null) {
        return endMeasures * getBarSec(base);
    }

    const getNoteMaxTime = (n) => n?.type === 'roll' ? (n.endTime ?? n.startTime ?? 0) : (n?.time ?? 0);
    const maxNoteTime = editingNotes.length ? Math.max(...editingNotes.map(getNoteMaxTime)) : 0;
    const lastBarSec = getBarSec(base);
    return Math.max(0, maxNoteTime + lastBarSec);
}

/**
 * ノーツ配列から連打区間 [{start, end}, ...] を算出
 * @param {Array<{ type?: string, time?: number, startTime?: number, endTime?: number }>} notes
 */
function getRollSectionsFromNotes(notes) {
    const sorted = [...notes].sort((a, b) => {
        const ta = a.type === 'roll' ? a.startTime : a.time;
        const tb = b.type === 'roll' ? b.startTime : b.time;
        return (ta ?? 0) - (tb ?? 0);
    });
    const sections = [];
    const starts = [];
    for (const n of sorted) {
        if (n.type === 'roll') {
            const s = n.startTime ?? 0;
            const e = n.endTime ?? n.startTime ?? 0;
            if (e > s) sections.push({ start: s, end: e });
        } else if (n.type === 'roll-start') {
            starts.push(n.time);
        } else if (n.type === 'roll-end' && starts.length > 0) {
            const start = starts.shift();
            if (n.time > start) sections.push({ start, end: n.time });
        }
    }
    return sections;
}

/**
 * ノーツ配列からプレビュー用の音イベント列を作る（don/ka + roll区間は0.1sごとにdon）
 * @param {Array<{ type?: string, time?: number, volume?: unknown }>} notes
 * @returns {Array<{ time: number, type: 'don'|'ka', volume: number }>}
 */
function buildChartPreviewEventsFromNotes(notes) {
    const events = [];
    for (const n of notes) {
        if (!n) continue;
        if (n.type === 'don' || n.type === 'ka') {
            const t = Number(n.time ?? 0);
            if (Number.isFinite(t) && t >= 0) {
                events.push({ time: t, type: n.type, volume: getNoteVolumeForEditor(n) });
            }
        }
    }
    for (const s of getRollSectionsFromNotes(notes)) {
        const start = Number(s.start ?? 0);
        const end = Number(s.end ?? 0);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const step = 0.1;
        for (let t = start; t < end; t += step) {
            events.push({ time: t, type: 'don', volume: 1 });
        }
    }
    events.sort((a, b) => a.time - b.time);
    return events;
}

/**
 * editingNotes からプレビュー用の音イベント列を作る（don/ka + roll区間は0.1sごとにdon）
 * @returns {Array<{ time: number, type: 'don'|'ka', volume: number }>}
 */
function buildChartPreviewEvents() {
    return buildChartPreviewEventsFromNotes(editingNotes);
}

/**
 * 1P〜3Pスロットを結合したプレビュー用イベント列（再生前に flushChartPartSlot 済みであること）
 */
function buildChartPreviewEventsAllParts() {
    const merged = [];
    for (let p = 0; p < 3; p++) {
        merged.push(...buildChartPreviewEventsFromNotes(chartPartNoteSlots[p] || []));
    }
    merged.sort((a, b) => a.time - b.time);
    return merged;
}

/**
 * 全パートのノーツからプレビュー総時間(秒)を算出（endTime入力優先）
 */
function getChartPreviewDurationSecAllParts() {
    const endEl = document.getElementById('chart-edit-end-time');
    const endMeasuresInput = endEl && endEl.value !== '' ? Number(endEl.value) : NaN;
    const endMeasures = Number.isFinite(endMeasuresInput) ? Math.max(1, Math.floor(endMeasuresInput)) : null;
    const base = getChartTempo();
    if (endMeasures != null) {
        return endMeasures * getBarSec(base);
    }

    const getNoteMaxTime = (n) => n?.type === 'roll' ? (n.endTime ?? n.startTime ?? 0) : (n?.time ?? 0);
    let maxNoteTime = 0;
    for (let p = 0; p < 3; p++) {
        const notes = chartPartNoteSlots[p] || [];
        if (notes.length) {
            const m = Math.max(...notes.map(getNoteMaxTime));
            if (m > maxNoteTime) maxNoteTime = m;
        }
    }
    const lastBarSec = getBarSec(base);
    return Math.max(0, maxNoteTime + lastBarSec);
}

/**
 * 1P〜3Pのノーツと終了小節から、譜面の総小節数を返す（renderNotesStrip と整合）
 * @returns {number}
 */
function getChartEditorTotalMeasuresAllParts() {
    const getNoteMaxTime = (n) => n.type === 'roll' ? (n.endTime ?? n.startTime ?? 0) : (n.time ?? 0);
    let maxNoteTime = 0;
    for (let p = 0; p < 3; p++) {
        const notes = chartPartNoteSlots[p] || [];
        if (notes.length) {
            const m = Math.max(...notes.map(getNoteMaxTime));
            if (m > maxNoteTime) maxNoteTime = m;
        }
    }
    const maxBarFromNotes = maxNoteTime > 0 ? timeToBarStepUniformSecs(maxNoteTime, getChartTempo()).barIndex + 1 : 0;
    const endEl = document.getElementById('chart-edit-end-time');
    const endMeasuresInput = endEl && endEl.value !== '' ? Number(endEl.value) : NaN;
    const endMeasures = Number.isFinite(endMeasuresInput) ? Math.max(1, Math.floor(endMeasuresInput)) : null;
    const defaultMeasures = 16;
    return Math.max(endMeasures ?? defaultMeasures, maxBarFromNotes, 1);
}

/**
 * 再生秒から「4小節ウィンドウ」の先頭小節インデックス（0始まり）を返す
 * @param {number} timeSec
 * @returns {number}
 */
function getPlaybackFourBarWindowStart(timeSec) {
    const { barIndex } = timeToBarStepUniformSecs(timeSec, getChartTempo());
    return Math.floor(barIndex / 4) * 4;
}

/**
 * 全パート再生の開始秒（選択中ノーツがあればその時刻、なければ曲頭）
 * @returns {number}
 */
function getChartAllPartsPlaybackStartSec() {
    if (selectedNoteIndex >= 0 && editingNotes[selectedNoteIndex]) {
        const n = editingNotes[selectedNoteIndex];
        if (n.type === 'roll') return Number(n.startTime ?? 0);
        return Number(n.time ?? 0);
    }
    if (selectedNoteIndices.size > 0) {
        const first = Math.min(...selectedNoteIndices);
        const n = editingNotes[first];
        if (n) {
            if (n.type === 'roll') return Number(n.startTime ?? 0);
            return Number(n.time ?? 0);
        }
    }
    return 0;
}

/**
 * 全パート再生用の3行ビューを表示開始する（編集グリッドは非表示）
 */
function enterChartMultiPartPlaybackView() {
    chartPreviewState.allPartsPlayback = true;
    chartPreviewState.playbackWindowStartBar = -1;
    const multiWrap = document.getElementById('chart-playback-multi-wrap');
    const grid = document.getElementById('chart-measures-grid');
    if (grid) grid.style.display = 'none';
    if (multiWrap) multiWrap.hidden = false;
}

/**
 * 全パート再生ビューを閉じ、編集グリッドを復帰する
 */
function exitChartMultiPartPlaybackView() {
    const multiWrap = document.getElementById('chart-playback-multi-wrap');
    const grid = document.getElementById('chart-measures-grid');
    if (multiWrap) {
        multiWrap.hidden = true;
        multiWrap.innerHTML = '';
    }
    if (grid) grid.style.display = '';
    chartPreviewState.allPartsPlayback = false;
    chartPreviewState.playbackWindowStartBar = -1;
    chartPreviewState.activeMultiCells = null;
    renderNotesStrip();
}

/**
 * プレビュー用の1小節カード（読み取り専用）を組み立てる
 * @param {number} barIndex
 * @param {boolean} isPlaceholder 譜面終端を超える空き小節
 * @returns {HTMLElement}
 */
function buildChartPlaybackMeasureCard(barIndex, isPlaceholder) {
    const card = document.createElement('div');
    card.className = 'measure-card staff-measure' + (isPlaceholder ? ' chart-playback-measure-placeholder' : '');
    card.dataset.barIndex = String(barIndex);

    const header = document.createElement('div');
    header.className = 'measure-header staff-header';

    const isFirstInRow = barIndex % 4 === 0;
    if (isFirstInRow) {
        const meta = document.createElement('div');
        meta.className = 'staff-meta';
        const clef = document.createElement('div');
        clef.className = 'staff-clef';
        clef.textContent = '𝄞';
        const ts = document.createElement('div');
        ts.className = 'staff-time-signature';
        ts.innerHTML = '<span>4</span><span>4</span>';
        meta.appendChild(clef);
        meta.appendChild(ts);
        header.appendChild(meta);
    } else {
        const spacer = document.createElement('div');
        spacer.className = 'staff-meta staff-meta-spacer';
        header.appendChild(spacer);
    }

    const title = document.createElement('div');
    title.className = 'measure-title staff-measure-title';
    title.textContent = isPlaceholder ? '—' : String(barIndex + 1);
    header.appendChild(title);

    const bpmWrap = document.createElement('div');
    bpmWrap.className = 'measure-bpm-wrap chart-playback-measure-bpm-readonly';
    const key = String(barIndex);
    const hasOverride = chartMeasureBpms && Object.prototype.hasOwnProperty.call(chartMeasureBpms, key);
    const eff = getEffectiveBpmForBar(barIndex);
    const bpmLabel = document.createElement('span');
    bpmLabel.className = 'chart-playback-bpm-label';
    bpmLabel.textContent = hasOverride ? `BPM ${chartMeasureBpms[key]}` : `BPM ${eff}`;
    bpmWrap.appendChild(bpmLabel);
    header.appendChild(bpmWrap);

    card.appendChild(header);

    const cells = document.createElement('div');
    cells.className = 'measure-cells';
    for (let stepIndex = 0; stepIndex < 16; stepIndex++) {
        const cell = document.createElement('div');
        cell.className = 'measure-cell' + (isPlaceholder ? ' chart-playback-cell-disabled' : '');
        cell.dataset.barIndex = String(barIndex);
        cell.dataset.stepIndex = String(stepIndex);
        cells.appendChild(cell);
    }
    card.appendChild(cells);
    return card;
}

/**
 * 指定ノーツをプレビューグリッドのセルへ描画する（読み取り専用チップ）
 * @param {HTMLElement} gridEl
 * @param {Array<{ type?: string, time?: number, startTime?: number, endTime?: number, volume?: unknown }>} notes
 */
function fillPlaybackNoteChipsInGrid(gridEl, notes) {
    const cellMap = new Map();
    gridEl.querySelectorAll('.measure-cell').forEach((cell) => {
        cellMap.set(`${cell.dataset.barIndex}:${cell.dataset.stepIndex}`, cell);
    });
    notes.forEach((note, i) => {
        if (!note) return;
        const time = note.type === 'roll' ? (note.startTime ?? 0) : (note.time ?? 0);
        const { barIndex, stepIndex } = timeToBarStep(time, getChartTempo());
        const key = `${barIndex}:${stepIndex}`;
        const cell = cellMap.get(key);
        if (!cell || cell.classList.contains('chart-playback-cell-disabled')) return;

        const chip = document.createElement('div');
        const cls = note.type === 'ka' ? 'note-ka'
            : note.type === 'don' ? 'note-don'
                : note.type === 'roll-start' ? 'note-roll-start'
                    : note.type === 'roll-end' ? 'note-roll-end'
                        : 'note-don';
        chip.className = `note-chip ${cls}`;
        chip.dataset.pbIndex = String(i);
        chip.textContent = note.type === 'ka' ? 'K'
            : note.type === 'don' ? 'D'
                : note.type === 'roll-start' ? 'S'
                    : note.type === 'roll-end' ? 'E'
                        : 'D';
        if (note.type === 'don' || note.type === 'ka') {
            const vol = getNoteVolumeForEditor(note);
            chip.style.height = `${Math.max(4, 16 * vol)}px`;
        }
        cell.innerHTML = '';
        cell.appendChild(chip);
    });
}

/**
 * 再生位置に合わせ3パート×4小節のDOMを同期する（4小節ブロックが変わったときだけ再構築）
 * @param {number} songTimeSec
 */
function syncMultiPartPlaybackWindowDom(songTimeSec) {
    const wrap = document.getElementById('chart-playback-multi-wrap');
    if (!wrap) return;

    const winStart = getPlaybackFourBarWindowStart(songTimeSec);
    if (winStart === chartPreviewState.playbackWindowStartBar && wrap.querySelector('#chart-playback-multi-rows')) {
        return;
    }
    chartPreviewState.playbackWindowStartBar = winStart;

    const totalMeasures = getChartEditorTotalMeasuresAllParts();
    const rowsRoot = document.createElement('div');
    rowsRoot.id = 'chart-playback-multi-rows';
    rowsRoot.className = 'chart-playback-multi-rows';

    for (let part = 1; part <= 3; part++) {
        const name = (chartPartNames[part] && chartPartNames[part].trim()) ? chartPartNames[part].trim() : `${part}P`;
        const block = document.createElement('div');
        block.className = 'chart-playback-part-block';
        block.dataset.part = String(part);

        const titleEl = document.createElement('div');
        titleEl.className = 'chart-playback-part-title';
        titleEl.textContent = name;
        block.appendChild(titleEl);

        const innerGrid = document.createElement('div');
        innerGrid.className = 'chart-measures-grid chart-playback-part-grid';
        innerGrid.dataset.part = String(part);

        for (let k = 0; k < 4; k++) {
            const barIndex = winStart + k;
            const isPh = barIndex >= totalMeasures;
            innerGrid.appendChild(buildChartPlaybackMeasureCard(barIndex, isPh));
        }

        const notes = chartPartNoteSlots[part - 1] || [];
        fillPlaybackNoteChipsInGrid(innerGrid, notes);
        block.appendChild(innerGrid);
        rowsRoot.appendChild(block);
    }

    wrap.innerHTML = '';
    wrap.appendChild(rowsRoot);
}

/**
 * 全パート再生の再生ヘッドとセルハイライトを更新する
 * @param {number} timeSec
 */
function setChartPreviewPlayheadAtTimeAllParts(timeSec) {
    const scrollEl = document.getElementById('chart-measures-scroll');
    const playhead = ensureChartPreviewPlayheadEl();
    if (!scrollEl || !playhead) return;

    const rowsRoot = document.getElementById('chart-playback-multi-rows');
    if (!rowsRoot) return;

    const { barIndex, stepIndex } = timeToBarStep(timeSec, getChartTempo());
    const rowEls = rowsRoot.querySelectorAll('.chart-playback-part-block');
    const cells = [];
    for (const row of rowEls) {
        const c = row.querySelector(`.measure-cell[data-bar-index="${barIndex}"][data-step-index="${stepIndex}"]`);
        if (c && !c.classList.contains('chart-playback-cell-disabled')) cells.push(c);
    }
    if (cells.length === 0) return;

    if (chartPreviewState.activeMultiCells && chartPreviewState.activeMultiCells.length) {
        for (const el of chartPreviewState.activeMultiCells) {
            el.classList.remove('chart-preview-active-cell');
        }
    }
    chartPreviewState.activeMultiCells = cells;
    for (const c of cells) c.classList.add('chart-preview-active-cell');
    chartPreviewState.activeCellEl = cells[0];

    const scrollRect = scrollEl.getBoundingClientRect();
    const topCell = cells[0].getBoundingClientRect();
    const botCell = cells[cells.length - 1].getBoundingClientRect();
    const left = (topCell.left - scrollRect.left) + scrollEl.scrollLeft + (topCell.width / 2) - 2;
    const top = (topCell.top - scrollRect.top) + scrollEl.scrollTop;
    const height = Math.max(topCell.height, (botCell.bottom - topCell.top));
    playhead.style.height = `${height}px`;
    playhead.style.transform = `translate3d(${left}px, ${top}px, 0)`;

    cells[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * プレビュー音源を読み込み（初回のみ）
 */
async function ensureChartPreviewAudioLoaded() {
    if (chartPreviewAudioBuffers.don && chartPreviewAudioBuffers.ka) return;
    if (!chartPreviewAudioCtx) {
        chartPreviewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (chartPreviewAudioCtx.state === 'suspended') {
        await chartPreviewAudioCtx.resume();
    }
    const decode = async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.statusText);
        const buf = await res.arrayBuffer();
        return await chartPreviewAudioCtx.decodeAudioData(buf);
    };
    const [don, ka] = await Promise.all([
        chartPreviewAudioBuffers.don ? chartPreviewAudioBuffers.don : decode('/music/don_.mp3'),
        chartPreviewAudioBuffers.ka ? chartPreviewAudioBuffers.ka : decode('/music/ka_.mp3')
    ]);
    chartPreviewAudioBuffers = { don, ka };
}

/**
 * 選択中譜面のBGMを AudioBuffer にデコードする（未設定なら null）
 * @returns {Promise<AudioBuffer | null>}
 */
async function ensureChartPreviewBgmDecoded() {
    const chartId = selectedChartId;
    const c = chartId && cachedCharts[chartId];
    if (!c || c.bgmVersion == null) {
        return null;
    }
    const key = `${chartId}:${c.bgmVersion}`;
    if (chartPreviewBgmCache.key === key && chartPreviewBgmCache.buffer) {
        return chartPreviewBgmCache.buffer;
    }
    if (!chartPreviewAudioCtx) {
        chartPreviewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const url = `/chart-bgm/${encodeURIComponent(chartId)}.mp3?v=${encodeURIComponent(String(c.bgmVersion))}`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('BGMの取得に失敗しました');
    const ab = await res.arrayBuffer();
    const buf = await chartPreviewAudioCtx.decodeAudioData(ab.slice(0));
    chartPreviewBgmCache = { key, buffer: buf };
    return buf;
}

/**
 * BGMキャッシュを破棄（譜面切替・アップロード後）
 */
function invalidateChartBgmPreviewCache() {
    chartPreviewBgmCache = { key: '', buffer: null };
}

/**
 * BGM行の表示を更新する
 */
function updateChartBgmRowUi() {
    const statusEl = document.getElementById('chart-bgm-status');
    const btnImport = document.getElementById('btn-chart-bgm-import');
    const btnRemove = document.getElementById('btn-chart-bgm-remove');
    const c = selectedChartId && cachedCharts[selectedChartId];
    if (!statusEl) return;
    if (!selectedChartId || !c) {
        statusEl.textContent = '譜面を選択してください';
        if (btnImport) btnImport.disabled = true;
        if (btnRemove) btnRemove.disabled = true;
        return;
    }
    if (btnImport) btnImport.disabled = false;
    if (c.bgmVersion != null) {
        statusEl.textContent = c.bgmOriginalName ? String(c.bgmOriginalName) : 'MP3設定済み';
        if (btnRemove) btnRemove.disabled = false;
    } else {
        statusEl.textContent = '未設定（MP3をインポート）';
        if (btnRemove) btnRemove.disabled = true;
    }
}

/**
 * playhead要素を確保して返す
 */
function ensureChartPreviewPlayheadEl() {
    if (chartPreviewState.playheadEl && chartPreviewState.playheadEl.isConnected) return chartPreviewState.playheadEl;
    const scrollEl = document.getElementById('chart-measures-scroll');
    if (!scrollEl) return null;
    const el = document.createElement('div');
    el.className = 'chart-preview-playhead';
    scrollEl.appendChild(el);
    chartPreviewState.playheadEl = el;
    return el;
}

/**
 * 再生ヘッドを指定時間に合わせてセル上へ配置
 * @param {number} timeSec
 */
function setChartPreviewPlayheadAtTime(timeSec) {
    if (chartPreviewState.allPartsPlayback) {
        setChartPreviewPlayheadAtTimeAllParts(timeSec);
        return;
    }

    const scrollEl = document.getElementById('chart-measures-scroll');
    const gridEl = document.getElementById('chart-measures-grid');
    const playhead = ensureChartPreviewPlayheadEl();
    if (!scrollEl || !gridEl || !playhead) return;

    if (chartPreviewState.activeMultiCells && chartPreviewState.activeMultiCells.length) {
        for (const el of chartPreviewState.activeMultiCells) {
            el.classList.remove('chart-preview-active-cell');
        }
        chartPreviewState.activeMultiCells = null;
    }

    const { barIndex, stepIndex } = timeToBarStep(timeSec, getChartTempo());
    const cell = gridEl.querySelector(`.measure-cell[data-bar-index="${barIndex}"][data-step-index="${stepIndex}"]`);
    if (!cell) return;

    if (chartPreviewState.activeCellEl && chartPreviewState.activeCellEl !== cell) {
        chartPreviewState.activeCellEl.classList.remove('chart-preview-active-cell');
    }
    chartPreviewState.activeCellEl = cell;
    cell.classList.add('chart-preview-active-cell');

    const scrollRect = scrollEl.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const left = (cellRect.left - scrollRect.left) + scrollEl.scrollLeft + (cellRect.width / 2) - 2;
    const top = (cellRect.top - scrollRect.top) + scrollEl.scrollTop;
    playhead.style.height = `${cellRect.height}px`;
    playhead.style.transform = `translate3d(${left}px, ${top}px, 0)`;

    // 追従スクロール（近傍）
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * 譜面プレビューUI（ボタン状態/時刻表示）を更新
 */
function updateChartPreviewControlsUI() {
    const btnPlay = document.getElementById('btn-chart-preview-play');
    const btnPlayAllParts = document.getElementById('btn-chart-play-all-parts');
    const btnStop = document.getElementById('btn-chart-preview-stop');
    const timeEl = document.getElementById('chart-preview-time');
    const enabled = Boolean(selectedChartId);
    if (btnPlay) btnPlay.disabled = !enabled || chartPreviewState.playing;
    if (btnPlayAllParts) btnPlayAllParts.disabled = !enabled || chartPreviewState.playing;
    if (btnStop) btnStop.disabled = !enabled || !chartPreviewState.playing;

    const dur = getChartPreviewDurationSec();
    chartPreviewState.durationSec = dur;
    if (timeEl && !chartPreviewState.playing) {
        timeEl.textContent = `${formatChartPreviewTime(0)} / ${formatChartPreviewTime(dur)}`;
    }
}

/**
 * プレビュー用イベント列を再生する（音 + 緑バー）
 * @param {Array<{ time: number, type: 'don'|'ka', volume?: number }>} events
 * @param {number} totalDur
 * @param {number} [startFromSec=0]
 * @param {{ allPartsLayout?: boolean }} [options]
 */
async function runChartPreviewPlayback(events, totalDur, startFromSec = 0, options = {}) {
    if (!selectedChartId) return;
    const allPartsLayout = Boolean(options.allPartsLayout);
    stopChartPreview();
    const statusEl = document.getElementById('chart-status');
    try {
        await ensureChartPreviewAudioLoaded();
    } catch (e) {
        if (statusEl) statusEl.textContent = 'プレビュー音の読み込みに失敗: ' + e.message;
        return;
    }

    /** @type {AudioBuffer | null} */
    let bgmBuffer = null;
    try {
        bgmBuffer = await ensureChartPreviewBgmDecoded();
    } catch (e) {
        bgmBuffer = null;
        if (statusEl && cachedCharts[selectedChartId]?.bgmVersion != null) {
            statusEl.textContent = 'BGMを再生できません（ドン・カのみ再生）';
        }
    }

    const startSec = Math.min(Math.max(0, Number(startFromSec) || 0), totalDur);
    const wallStart = wallAtUniform(startSec);
    const wallEnd = wallAtUniform(totalDur);
    const playDurationWall = Math.max(0, wallEnd - wallStart);
    chartPreviewState.durationSec = totalDur;
    chartPreviewState.startOffsetSec = startSec;
    chartPreviewState.playDurationSec = playDurationWall;
    chartPreviewState.playbackWallAnchor = wallStart;

    if (playDurationWall <= 0) {
        updateChartPreviewControlsUI();
        return;
    }

    if (!chartPreviewAudioCtx) return;
    if (chartPreviewAudioCtx.state === 'suspended') await chartPreviewAudioCtx.resume();

    if (allPartsLayout) {
        enterChartMultiPartPlaybackView();
        syncMultiPartPlaybackWindowDom(startSec);
    }

    const baseTime = chartPreviewAudioCtx.currentTime + 0.05;

    const sources = [];
    if (bgmBuffer && bgmBuffer.duration > 0) {
        const sliceStartWall = Math.min(Math.max(0, wallStart), Math.max(0, bgmBuffer.duration - 1e-6));
        const maxFromSlice = Math.max(0, bgmBuffer.duration - sliceStartWall);
        const bgmPlayLen = Math.min(playDurationWall, maxFromSlice);
        if (bgmPlayLen > 0.02) {
            const gain = chartPreviewAudioCtx.createGain();
            gain.gain.value = 0.42;
            const bgmSrc = chartPreviewAudioCtx.createBufferSource();
            bgmSrc.buffer = bgmBuffer;
            bgmSrc.connect(gain);
            gain.connect(chartPreviewAudioCtx.destination);
            bgmSrc.start(baseTime, sliceStartWall, bgmPlayLen);
            sources.push(bgmSrc);
        }
    }
    for (const ev of events) {
        const buf = ev.type === 'don' ? chartPreviewAudioBuffers.don : chartPreviewAudioBuffers.ka;
        if (!buf) continue;
        const t = Number(ev.time ?? 0);
        if (!Number.isFinite(t) || t < startSec || t > totalDur + 0.001) continue;
        const gain = chartPreviewAudioCtx.createGain();
        gain.gain.value = clampNoteVolume(ev.volume != null ? ev.volume : 1);
        const src = chartPreviewAudioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(gain);
        gain.connect(chartPreviewAudioCtx.destination);
        const evWall = wallAtUniform(t);
        src.start(baseTime + (evWall - wallStart));
        sources.push(src);
    }

    chartPreviewState.playing = true;
    chartPreviewState.sources = sources;
    chartPreviewState.startedAtPerfMs = performance.now();
    const playhead = ensureChartPreviewPlayheadEl();
    if (playhead) playhead.classList.add('active');

    const timeEl = document.getElementById('chart-preview-time');
    const tick = () => {
        if (!chartPreviewState.playing) return;
        const elapsed = (performance.now() - chartPreviewState.startedAtPerfMs) / 1000;
        const wallNow = chartPreviewState.playbackWallAnchor + Math.min(elapsed, chartPreviewState.playDurationSec);
        const songTime = uniformAtWall(wallNow);
        if (timeEl) {
            timeEl.textContent = `${formatChartPreviewTime(songTime)} / ${formatChartPreviewTime(chartPreviewState.durationSec)}`;
        }
        if (chartPreviewState.allPartsPlayback) {
            syncMultiPartPlaybackWindowDom(songTime);
        }
        setChartPreviewPlayheadAtTime(songTime);
        if (elapsed >= chartPreviewState.playDurationSec) {
            stopChartPreview();
            return;
        }
        chartPreviewState.rafId = requestAnimationFrame(tick);
    };
    chartPreviewState.rafId = requestAnimationFrame(tick);
    updateChartPreviewControlsUI();
}

/**
 * プレビュー再生（現在編集中パートのみ）
 * @param {number} [startFromSec=0] 曲頭からの秒。指定時はその位置から終端まで再生
 */
async function playChartPreview(startFromSec = 0) {
    const events = buildChartPreviewEvents();
    const totalDur = getChartPreviewDurationSec();
    await runChartPreviewPlayback(events, totalDur, startFromSec);
}

/**
 * 1P・2P・3P をまとめて再生（未保存の編集内容はスロットへ反映してから再生）
 * @param {number} [startFromSec=0]
 */
async function playChartPreviewAllParts(startFromSec = 0) {
    flushChartPartSlot();
    const events = buildChartPreviewEventsAllParts();
    const totalDur = getChartPreviewDurationSecAllParts();
    await runChartPreviewPlayback(events, totalDur, startFromSec, { allPartsLayout: true });
}

/**
 * プレビュー停止
 */
function stopChartPreview() {
    const wasAllParts = chartPreviewState.allPartsPlayback;
    if (chartPreviewState.rafId) cancelAnimationFrame(chartPreviewState.rafId);
    chartPreviewState.rafId = 0;
    if (chartPreviewState.sources && chartPreviewState.sources.length > 0) {
        for (const s of chartPreviewState.sources) {
            try { s.stop(); } catch { /* noop */ }
        }
    }
    chartPreviewState.sources = [];
    chartPreviewState.playing = false;
    chartPreviewState.startedAtPerfMs = 0;
    chartPreviewState.startOffsetSec = 0;
    chartPreviewState.playDurationSec = 0;
    chartPreviewState.playbackWallAnchor = 0;

    const playhead = chartPreviewState.playheadEl;
    if (playhead) playhead.classList.remove('active');
    if (chartPreviewState.activeMultiCells && chartPreviewState.activeMultiCells.length) {
        for (const el of chartPreviewState.activeMultiCells) {
            el.classList.remove('chart-preview-active-cell');
        }
        chartPreviewState.activeMultiCells = null;
    }
    if (chartPreviewState.activeCellEl) {
        chartPreviewState.activeCellEl.classList.remove('chart-preview-active-cell');
        chartPreviewState.activeCellEl = null;
    }
    if (wasAllParts) {
        exitChartMultiPartPlaybackView();
    }
    updateChartPreviewControlsUI();
}

/**
 * 譜面一覧のDOMを更新し、選択状態を反映する
 * @param {Record<string, { id: string, name?: string, notes?: Array<{ time: number, type: string }> }>} charts
 */
function renderChartList(charts) {
    const listEl = document.getElementById('chart-list');
    charts = charts || cachedCharts;
    const btnDelete = document.getElementById('btn-delete-chart');
    if (!listEl) return;
    listEl.innerHTML = '';
    const ids = Object.keys(charts);
    ids.forEach((id) => {
        const c = charts[id];
        const div = document.createElement('div');
        div.className = 'item' + (id === selectedChartId ? ' selected' : '');
        div.textContent = c.name || id;
        div.dataset.id = id;
        div.addEventListener('click', () => selectChart(id));
        listEl.appendChild(div);
    });
    if (selectedChartId && charts[selectedChartId]) {
        if (btnDelete) btnDelete.disabled = false;
    } else {
        if (btnDelete) btnDelete.disabled = true;
    }
}

/**
 * 譜面を選択し、名前行と削除ボタンの状態を更新する
 * @param {string} id
 */
function selectChart(id) {
    stopChartPreview();
    selectedChartId = id;
    const c = cachedCharts[id];
    const btnDelete = document.getElementById('btn-delete-chart');
    if (btnDelete) btnDelete.disabled = !id;
    renderChartList(cachedCharts);
    if (c) {
        loadChartIntoEditor(c);
    } else {
        clearChartEditor();
    }
}

/**
 * チャートの notes / notes2 / notes3 をエディタ用（roll 展開）に変換
 * @param {Record<string, unknown>} chart
 * @param {string} field
 * @returns {Array<{ time?: number, type: string, startTime?: number, endTime?: number }>}
 */
function chartFieldToEditorNotes(chart, field) {
    let notes = Array.isArray(chart[field]) ? chart[field].slice() : [];
    return notes.flatMap((n) => {
        if (n.type === 'roll' && n.startTime != null && n.endTime != null) {
            return [
                { type: 'roll-start', time: n.startTime },
                { type: 'roll-end', time: n.endTime }
            ];
        }
        return [n];
    });
}

/**
 * 現在タブの editingNotes をスロットへ書き戻す
 */
function flushChartPartSlot() {
    chartPartNoteSlots[chartEditingPart - 1] = editingNotes.slice();
}

/**
 * 譜面パートタブを切り替える（1P/2P/3P）
 * @param {number} part 1|2|3
 */
function setChartEditingPart(part) {
    if (part < 1 || part > 3 || part === chartEditingPart) return;
    stopChartPreview();
    flushChartPartSlot();
    chartEditingPart = part;
    editingNotes = chartPartNoteSlots[part - 1].slice();
    selectedNoteIndex = -1;
    selectedNoteIndices.clear();
    document.querySelectorAll('.chart-part-tab').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.part) === part);
    });
    renderNotesStrip();
    updateChartPreviewControlsUI();
}

/**
 * 譜面を右側の編集エリアに読み込む
 * @param {{ id: string, name?: string, notes?: unknown[], notes2?: unknown[], notes3?: unknown[], difficulty?: number|string|null, tempo?: number|null }} chart
 */
function loadChartIntoEditor(chart) {
    const nameEl = document.getElementById('chart-edit-name');
    const difficultyEl = document.getElementById('chart-edit-difficulty');
    const tempoEl = document.getElementById('chart-edit-tempo');
    const endTimeEl = document.getElementById('chart-edit-end-time');
    const btnSave = document.getElementById('btn-save-chart');
    const btnPlayAllParts = document.getElementById('btn-chart-play-all-parts');
    if (nameEl) nameEl.value = chart.name || chart.id || '';
    if (difficultyEl) difficultyEl.value = chart.difficulty != null ? String(chart.difficulty) : '';
    if (tempoEl) tempoEl.value = chart.tempo != null ? String(chart.tempo) : '';
    chartMeasureBpms = (chart && chart.measureBpms && typeof chart.measureBpms === 'object') ? { ...chart.measureBpms } : {};
    if (endTimeEl) {
        const endSec = chart.endTime != null && Number.isFinite(Number(chart.endTime)) ? Number(chart.endTime) : NaN;
        if (Number.isFinite(endSec) && endSec > 0) {
            let acc = 0;
            let measures = 0;
            const maxMeasures = 2000;
            while (measures < maxMeasures && acc < endSec) {
                acc += getBarSec(getEffectiveBpmForBar(measures));
                measures += 1;
            }
            endTimeEl.value = String(Math.max(1, measures));
        } else {
            endTimeEl.value = '';
        }
    }
    const panel = document.getElementById('panel-chart');
    if (panel) panel.dataset.hasChart = 'true';

    chartPartNoteSlots[0] = chartFieldToEditorNotes(chart, 'notes');
    chartPartNoteSlots[1] = chartFieldToEditorNotes(chart, 'notes2');
    chartPartNoteSlots[2] = chartFieldToEditorNotes(chart, 'notes3');
    const pn = (chart && chart.partNames && typeof chart.partNames === 'object') ? chart.partNames : null;
    chartPartNames = {
        1: pn && typeof pn[1] === 'string' ? pn[1] : (pn && typeof pn.p1 === 'string' ? pn.p1 : ''),
        2: pn && typeof pn[2] === 'string' ? pn[2] : (pn && typeof pn.p2 === 'string' ? pn.p2 : ''),
        3: pn && typeof pn[3] === 'string' ? pn[3] : (pn && typeof pn.p3 === 'string' ? pn.p3 : ''),
    };
    const p1 = document.getElementById('chart-part-name-1');
    const p2 = document.getElementById('chart-part-name-2');
    const p3 = document.getElementById('chart-part-name-3');
    if (p1) p1.value = chartPartNames[1] || '';
    if (p2) p2.value = chartPartNames[2] || '';
    if (p3) p3.value = chartPartNames[3] || '';
    updateChartPartTabLabels();
    chartEditingPart = 1;
    editingNotes = chartPartNoteSlots[0].slice();
    document.querySelectorAll('.chart-part-tab').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.part) === 1);
    });
    selectedNoteIndex = -1;
    renderNotesStrip();
    if (btnSave) btnSave.disabled = false;
    if (btnPlayAllParts) btnPlayAllParts.disabled = false;
    invalidateChartBgmPreviewCache();
    updateChartBgmRowUi();
    updateChartPreviewControlsUI();
}

/**
 * 編集エリアをクリアする（譜面未選択時）
 */
function clearChartEditor() {
    const nameEl = document.getElementById('chart-edit-name');
    const difficultyEl = document.getElementById('chart-edit-difficulty');
    const tempoEl = document.getElementById('chart-edit-tempo');
    const endTimeEl = document.getElementById('chart-edit-end-time');
    const panel = document.getElementById('panel-chart');
    const btnSave = document.getElementById('btn-save-chart');
    const btnPlayAllParts = document.getElementById('btn-chart-play-all-parts');
    if (nameEl) nameEl.value = '';
    if (difficultyEl) difficultyEl.value = '';
    if (tempoEl) tempoEl.value = '';
    if (endTimeEl) endTimeEl.value = '';
    if (panel) delete panel.dataset.hasChart;
    editingNotes = [];
    chartPartNoteSlots = [[], [], []];
    chartEditingPart = 1;
    document.querySelectorAll('.chart-part-tab').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.part) === 1);
    });
    chartPartNames = { 1: '', 2: '', 3: '' };
    const p1 = document.getElementById('chart-part-name-1');
    const p2 = document.getElementById('chart-part-name-2');
    const p3 = document.getElementById('chart-part-name-3');
    if (p1) p1.value = '';
    if (p2) p2.value = '';
    if (p3) p3.value = '';
    updateChartPartTabLabels();
    chartMeasureBpms = {};
    selectedNoteIndex = -1;
    renderNotesStrip();
    if (btnSave) btnSave.disabled = true;
    if (btnPlayAllParts) btnPlayAllParts.disabled = true;
    invalidateChartBgmPreviewCache();
    updateChartBgmRowUi();
    updateChartPreviewControlsUI();
}

/**
 * 編集ノーツから連打区間 [{start, end}, ...] を算出
 */
function getRollSections() {
    return getRollSectionsFromNotes(editingNotes);
}

/**
 * 指定時間が連打区間内か
 */
function isTimeInRollSection(time) {
    return getRollSections().some((s) => time >= s.start && time <= s.end);
}

/**
 * 連打終了ノーツのみ表示すべきか（roll-start が未ペアで残っている）
 */
function needsRollEndOnly() {
    const starts = editingNotes.filter((n) => n.type === 'roll-start').length;
    const ends = editingNotes.filter((n) => n.type === 'roll-end').length;
    return starts > ends;
}

/**
 * メニューパレットの表示を更新（roll-end-only / over-roll-zone）
 */
function updateChartPalette(overRollZone = false) {
    const panel = document.getElementById('panel-chart');
    if (!panel) return;
    const rollEndOnly = needsRollEndOnly();
    panel.dataset.rollEndOnly = rollEndOnly ? 'true' : 'false';
    panel.dataset.overRollZone = overRollZone ? 'true' : 'false';
}

/**
 * テンポ入力から BPM を取得する（未入力時は 120）
 */
function getChartTempo() {
    const el = document.getElementById('chart-edit-tempo');
    const v = el && el.value ? Number(el.value) : NaN;
    return Number.isFinite(v) && v >= 1 && v <= 500 ? v : 120;
}

/**
 * BPMから1小節の秒数を返す（4/4固定）
 */
function getBarSec(bpm) {
    const v = Number(bpm);
    if (!Number.isFinite(v) || v <= 0) return 2;
    return (60 / v) * 4;
}

/**
 * BPM変更時に、ノーツの小節/位置（16分割）を維持したまま time(秒) を更新する
 * @param {number} oldBpm
 * @param {number} newBpm
 */
function retimeEditingNotesKeepGridPosition(oldBpm, newBpm) {
    // 互換のため関数は残すが、可変BPM対応版へ委譲する
    retimeEditingNotesKeepGridPositionVarBpm(oldBpm, newBpm);
}

/**
 * 秒timeを小節/16分割に変換する（stepは0-15）。編集グリッドはベースBPMの等間隔タイムライン。
 * @param {number} timeSec
 * @param {number} bpm
 */
function timeToBarStep(timeSec, bpm) {
    const b = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Number(bpm) : getChartTempo();
    return timeToBarStepUniformSecs(timeSec, b);
}

/**
 * 小節/16分割を秒timeに変換する（編集用・ベースBPMの等間隔）
 */
function barStepToTime(barIndex, stepIndex, bpm) {
    const b = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Number(bpm) : getChartTempo();
    return barStepToTimeUniformSecs(barIndex, stepIndex, b);
}

/**
 * 譜面編集エリアを小節グリッドで再描画する（4/4・1小節16分割）
 */
function renderNotesStrip() {
    const grid = document.getElementById('chart-measures-grid');
    const btnRemove = document.getElementById('btn-remove-selected-note');
    if (!grid) return;

    const bpm = getChartTempo();
    lastRenderedChartBpm = bpm;

    // 1行（4小節）の先頭にだけ表示する楽譜UI（ト音記号 + 4/4）用フラグ
    const staffMetaShownRows = new Set();

    const selectedNote = selectedNoteIndex >= 0 ? editingNotes[selectedNoteIndex] : null;
    editingNotes.sort((a, b) => {
        const ta = a.type === 'roll' ? a.startTime : a.time;
        const tb = b.type === 'roll' ? b.startTime : b.time;
        return (ta ?? 0) - (tb ?? 0);
    });
    selectedNoteIndex = selectedNote ? editingNotes.indexOf(selectedNote) : -1;
    // 並び替え後に selectedNoteIndices をインデックスで維持するのは不安定なので、範囲選択はセル座標ベースで行う
    // （renderNotesStrip 内では Set の整合性更新は行わない）

    const barSecBase = getBarSec(bpm);
    const getNoteMaxTime = (n) => n.type === 'roll' ? (n.endTime ?? n.startTime ?? 0) : (n.time ?? 0);
    const maxNoteTime = editingNotes.length ? Math.max(...editingNotes.map(getNoteMaxTime)) : 0;
    const maxBarFromNotes = timeToBarStepUniformSecs(maxNoteTime, bpm).barIndex + 1;
    const endEl = document.getElementById('chart-edit-end-time');
    const endMeasuresInput = endEl && endEl.value !== '' ? Number(endEl.value) : NaN;
    const endMeasures = Number.isFinite(endMeasuresInput) ? Math.max(1, Math.floor(endMeasuresInput)) : null;
    const defaultMeasures = 16;
    const totalMeasures = Math.max(endMeasures ?? defaultMeasures, maxBarFromNotes, 1);

    grid.innerHTML = '';
    for (let barIndex = 0; barIndex < totalMeasures; barIndex++) {
        const card = document.createElement('div');
        card.className = 'measure-card staff-measure';
        card.dataset.barIndex = String(barIndex);

        const header = document.createElement('div');
        header.className = 'measure-header staff-header';

        const previewPlayBtn = document.createElement('button');
        previewPlayBtn.type = 'button';
        previewPlayBtn.className = 'measure-preview-play-btn';
        previewPlayBtn.setAttribute('aria-label', `第${barIndex + 1}小節からプレビュー`);
        previewPlayBtn.title = 'この小節からプレビュー';
        previewPlayBtn.innerHTML = '<i class="bi bi-play-fill" aria-hidden="true"></i>';
        previewPlayBtn.disabled = !selectedChartId;
        previewPlayBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selectedChartId) return;
            const t0 = barStepToTime(barIndex, 0, getChartTempo());
            playChartPreview(t0);
        });
        header.appendChild(previewPlayBtn);

        const rowIndex = Math.floor(barIndex / 4);
        const isFirstInRow = barIndex % 4 === 0;
        if (isFirstInRow && !staffMetaShownRows.has(rowIndex)) {
            staffMetaShownRows.add(rowIndex);
            const meta = document.createElement('div');
            meta.className = 'staff-meta';
            const clef = document.createElement('div');
            clef.className = 'staff-clef';
            clef.textContent = '𝄞';
            const ts = document.createElement('div');
            ts.className = 'staff-time-signature';
            ts.innerHTML = '<span>4</span><span>4</span>';
            meta.appendChild(clef);
            meta.appendChild(ts);
            header.appendChild(meta);
        } else {
            // 画像のようにヘッダ情報は先頭だけ。スペース確保のみ。
            const spacer = document.createElement('div');
            spacer.className = 'staff-meta staff-meta-spacer';
            header.appendChild(spacer);
        }

        // 小節番号は薄く（編集用の目印）
        const title = document.createElement('div');
        title.className = 'measure-title staff-measure-title';
        title.textContent = String(barIndex + 1);
        header.appendChild(title);

        // 小節BPM（空欄=baseに追従、入力あり=この小節だけ固定）
        const bpmWrap = document.createElement('div');
        bpmWrap.className = 'measure-bpm-wrap';
        const bpmInput = document.createElement('input');
        bpmInput.type = 'number';
        bpmInput.className = 'measure-bpm-input';
        bpmInput.min = '1';
        bpmInput.max = '500';
        bpmInput.step = '1';
        bpmInput.placeholder = `BPM:${getChartTempo()}`;
        const key = String(barIndex);
        const hasOverride = chartMeasureBpms && Object.prototype.hasOwnProperty.call(chartMeasureBpms, key);
        if (hasOverride) {
            bpmInput.value = String(chartMeasureBpms[key]);
            bpmInput.dataset.overridden = 'true';
        } else {
            bpmInput.value = '';
            bpmInput.dataset.overridden = 'false';
        }
        bpmInput.title = 'この小節のBPM（空欄でベースBPMに追従）';
        bpmInput.addEventListener('input', () => {
            const v = bpmInput.value.trim();
            if (v === '') {
                if (chartMeasureBpms && Object.prototype.hasOwnProperty.call(chartMeasureBpms, key)) {
                    delete chartMeasureBpms[key];
                }
                bpmInput.dataset.overridden = 'false';
                renderNotesStrip();
                return;
            }
            const n = Number(v);
            if (!Number.isFinite(n) || n < 1 || n > 500) return;
            chartMeasureBpms[key] = Math.floor(n);
            bpmInput.dataset.overridden = 'true';
            renderNotesStrip();
        });
        bpmWrap.appendChild(bpmInput);
        header.appendChild(bpmWrap);

        // 小節追加/削除ボタン（隣接配置）
        const btnWrap = document.createElement('div');
        btnWrap.className = 'measure-btns';

        // 小節追加ボタン（クリックで「次の小節を挿入」して以降を後ろへずらす）
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'measure-add-btn';
        addBtn.textContent = '+';
        addBtn.title = '次の小節を追加';
        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selectedChartId) return;
            const insertAfterBarIndex = barIndex; // 0-based
            const insertTime = barStepToTime(insertAfterBarIndex + 1, 0, getChartTempo());
            const shiftSec = barSecBase; // 追加小節はbase BPM

            // 以降の小節BPM上書きを1つ後ろへずらす
            if (chartMeasureBpms && typeof chartMeasureBpms === 'object') {
                const next = {};
                for (const k of Object.keys(chartMeasureBpms)) {
                    const bi = Number(k);
                    if (!Number.isFinite(bi)) continue;
                    next[String(bi > insertAfterBarIndex ? bi + 1 : bi)] = chartMeasureBpms[k];
                }
                chartMeasureBpms = next;
            }

            editingNotes = editingNotes.map((n) => {
                if (n && (n.type === 'don' || n.type === 'ka' || n.type === 'roll-start' || n.type === 'roll-end')) {
                    const t = Number(n.time ?? 0);
                    if (t >= insertTime) return { ...n, time: t + shiftSec };
                    return n;
                }
                if (n && n.type === 'roll') {
                    const s = Number(n.startTime ?? 0);
                    const e2 = Number(n.endTime ?? n.startTime ?? 0);
                    const ns = s >= insertTime ? s + shiftSec : s;
                    const ne = e2 >= insertTime ? e2 + shiftSec : e2;
                    return { ...n, startTime: ns, endTime: ne };
                }
                return n;
            });

            const curInput = endEl && endEl.value !== '' ? Number(endEl.value) : NaN;
            const curMeasures = Number.isFinite(curInput) ? Math.max(1, Math.floor(curInput)) : totalMeasures;
            if (endEl) endEl.value = String(curMeasures + 1);
            renderNotesStrip();
        });
        btnWrap.appendChild(addBtn);

        // 小節削除ボタン（クリックで「この小節を削除」して以降を前へずらす）
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'measure-del-btn';
        delBtn.textContent = '−';
        delBtn.title = 'この小節を削除';
        delBtn.disabled = totalMeasures <= 1;
        delBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selectedChartId) return;
            if (totalMeasures <= 1) return;
            if (!confirm(`第${barIndex + 1}小節を削除しますか？（この小節内のノーツは削除され、以降は前に詰められます）`)) return;

            const deleteBarIndex = barIndex; // 0-based
            const startTime = barStepToTime(deleteBarIndex, 0, getChartTempo());
            const endTime = barStepToTime(deleteBarIndex + 1, 0, getChartTempo());
            const shiftSec = Math.max(0, endTime - startTime);

            // 小節BPM上書き: 対象を削除し、以降を前へずらす
            if (chartMeasureBpms && typeof chartMeasureBpms === 'object') {
                const next = {};
                for (const k of Object.keys(chartMeasureBpms)) {
                    const bi = Number(k);
                    if (!Number.isFinite(bi)) continue;
                    if (bi === deleteBarIndex) continue;
                    next[String(bi > deleteBarIndex ? bi - 1 : bi)] = chartMeasureBpms[k];
                }
                chartMeasureBpms = next;
            }

            editingNotes = editingNotes.flatMap((n) => {
                if (!n) return [];
                if (n.type === 'don' || n.type === 'ka' || n.type === 'roll-start' || n.type === 'roll-end') {
                    const t = Number(n.time ?? 0);
                    if (t >= startTime && t < endTime) return [];
                    if (t >= endTime) return [{ ...n, time: t - shiftSec }];
                    return [n];
                }
                if (n.type === 'roll') {
                    const s = Number(n.startTime ?? 0);
                    const e2 = Number(n.endTime ?? n.startTime ?? 0);
                    const startInside = s >= startTime && s < endTime;
                    const endInside = e2 >= startTime && e2 < endTime;
                    if (startInside || endInside) return [];
                    const ns = s >= endTime ? s - shiftSec : s;
                    const ne = e2 >= endTime ? e2 - shiftSec : e2;
                    return [{ ...n, startTime: ns, endTime: ne }];
                }
                return [n];
            });

            const curInput = endEl && endEl.value !== '' ? Number(endEl.value) : NaN;
            const curMeasures = Number.isFinite(curInput) ? Math.max(1, Math.floor(curInput)) : totalMeasures;
            if (endEl) endEl.value = String(Math.max(1, curMeasures - 1));
            selectedNoteIndex = -1;
            renderNotesStrip();
        });
        btnWrap.appendChild(delBtn);

        header.appendChild(btnWrap);

        card.appendChild(header);

        const cells = document.createElement('div');
        cells.className = 'measure-cells';
        for (let stepIndex = 0; stepIndex < 16; stepIndex++) {
            const cell = document.createElement('div');
            cell.className = 'measure-cell';
            cell.dataset.barIndex = String(barIndex);
            cell.dataset.stepIndex = String(stepIndex);
            cells.appendChild(cell);
        }
        card.appendChild(cells);
        grid.appendChild(card);
    }

    const cellMap = new Map();
    grid.querySelectorAll('.measure-cell').forEach((cell) => {
        cellMap.set(`${cell.dataset.barIndex}:${cell.dataset.stepIndex}`, cell);
    });

    editingNotes.forEach((note, i) => {
        const time = note.type === 'roll' ? (note.startTime ?? 0) : (note.time ?? 0);
        const { barIndex, stepIndex } = timeToBarStep(time, bpm);
        const key = `${barIndex}:${stepIndex}`;
        const cell = cellMap.get(key);
        if (!cell) return;

        const chip = document.createElement('div');
        const cls = note.type === 'ka' ? 'note-ka'
            : note.type === 'don' ? 'note-don'
                : note.type === 'roll-start' ? 'note-roll-start'
                    : note.type === 'roll-end' ? 'note-roll-end'
                        : 'note-don';
        chip.className = `note-chip ${cls}`
            + (i === selectedNoteIndex ? ' selected' : '')
            + (selectedNoteIndices.has(i) ? ' multi-selected' : '');
        chip.dataset.index = String(i);
        // 楽譜っぽさ優先: 短いラベル（視認性）にする
        chip.textContent = note.type === 'ka' ? 'K'
            : note.type === 'don' ? 'D'
                : note.type === 'roll-start' ? 'S'
                    : note.type === 'roll-end' ? 'E'
                        : 'D';
        if (note.type === 'don' || note.type === 'ka') {
            const vol = getNoteVolumeForEditor(note);
            chip.style.height = `${Math.max(4, 16 * vol)}px`;
            chip.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const idx = parseInt(chip.dataset.index, 10);
                const donKaInSelection = [...selectedNoteIndices].filter((i) => {
                    const n = editingNotes[i];
                    return n && (n.type === 'don' || n.type === 'ka');
                });
                const volumeResizeIndices = (selectedNoteIndices.has(idx) && donKaInSelection.length > 0)
                    ? donKaInSelection
                    : [idx];
                const startY = e.clientY;
                const startX = e.clientX;
                let didVolumeDrag = false;
                chartVolumeDragPointerId = e.pointerId;
                try {
                    chip.setPointerCapture(e.pointerId);
                } catch {
                    /* noop */
                }
                const onMove = (ev) => {
                    if (ev.pointerId !== chartVolumeDragPointerId) return;
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    if (Math.hypot(dx, dy) < CHART_NOTE_VOLUME_DRAG_THRESHOLD_PX) return;
                    if (!didVolumeDrag) {
                        didVolumeDrag = true;
                        ev.preventDefault();
                        selectedNoteIndex = idx;
                        if (volumeResizeIndices.length <= 1) {
                            selectedNoteIndices = new Set([idx]);
                        }
                    }
                    applyChartNoteVolumeFromPointer(volumeResizeIndices, ev.clientY, chip);
                };
                const onUp = (ev) => {
                    if (ev.pointerId !== chartVolumeDragPointerId) return;
                    chip.removeEventListener('pointermove', onMove);
                    chip.removeEventListener('pointerup', onUp);
                    chip.removeEventListener('pointercancel', onUp);
                    try {
                        chip.releasePointerCapture(ev.pointerId);
                    } catch {
                        /* noop */
                    }
                    chartVolumeDragPointerId = -1;
                    if (didVolumeDrag) {
                        flushChartPartSlot();
                        renderNotesStrip();
                    } else {
                        selectedNoteIndex = (selectedNoteIndex === idx) ? -1 : idx;
                        selectedNoteIndices = new Set(selectedNoteIndex >= 0 ? [selectedNoteIndex] : []);
                        renderNotesStrip();
                    }
                };
                chip.addEventListener('pointermove', onMove);
                chip.addEventListener('pointerup', onUp);
                chip.addEventListener('pointercancel', onUp);
            });
        } else {
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(chip.dataset.index, 10);
                selectedNoteIndex = (selectedNoteIndex === idx) ? -1 : idx;
                selectedNoteIndices = new Set(selectedNoteIndex >= 0 ? [selectedNoteIndex] : []);
                renderNotesStrip();
            });
        }
        cell.innerHTML = '';
        cell.appendChild(chip);
    });

    if (btnRemove) btnRemove.disabled = selectedNoteIndex < 0;
    updateChartPalette(false);
}

/**
 * 範囲選択の矩形（開始セル〜終了セル）に含まれるノーツのインデックスSetを作る
 */
function getNoteIndicesInRect(fromBar, fromStep, toBar, toStep) {
    const minBar = Math.min(fromBar, toBar);
    const maxBar = Math.max(fromBar, toBar);
    const minStep = Math.min(fromStep, toStep);
    const maxStep = Math.max(fromStep, toStep);
    const bpm = getChartTempo();
    const indices = new Set();
    for (let i = 0; i < editingNotes.length; i++) {
        const n = editingNotes[i];
        const t = n?.type === 'roll' ? (n.startTime ?? 0) : (n?.time ?? 0);
        const { barIndex, stepIndex } = timeToBarStep(t, bpm);
        if (barIndex >= minBar && barIndex <= maxBar && stepIndex >= minStep && stepIndex <= maxStep) {
            indices.add(i);
        }
    }
    return indices;
}

/**
 * 範囲選択の線形レンジ（開始セル〜終了セルの絶対ステップ範囲）に含まれるノーツのインデックスSetを作る
 */
function getNoteIndicesInAbsStepRange(fromBar, fromStep, toBar, toStep) {
    const a = (Math.max(0, Number(fromBar) || 0) * 16) + Math.max(0, Math.min(15, Number(fromStep) || 0));
    const b = (Math.max(0, Number(toBar) || 0) * 16) + Math.max(0, Math.min(15, Number(toStep) || 0));
    const minAbs = Math.min(a, b);
    const maxAbs = Math.max(a, b);
    const bpm = getChartTempo();
    const indices = new Set();
    for (let i = 0; i < editingNotes.length; i++) {
        const n = editingNotes[i];
        const t = n?.type === 'roll' ? (n.startTime ?? 0) : (n?.time ?? 0);
        const { barIndex, stepIndex } = timeToBarStep(t, bpm);
        const abs = (barIndex * 16) + stepIndex;
        if (abs >= minAbs && abs <= maxAbs) indices.add(i);
    }
    return indices;
}

/**
 * 選択ノーツを内部クリップボードへコピー（セル座標の相対位置で保持）
 */
function copySelectedNotesToClipboard() {
    if (!selectedChartId) return;
    const bpm = getChartTempo();
    const indices = selectedNoteIndices.size > 0
        ? [...selectedNoteIndices]
        : (selectedNoteIndex >= 0 ? [selectedNoteIndex] : []);
    if (indices.length === 0) return;

    const items = indices.map((i) => {
        const n = editingNotes[i];
        const t = n?.type === 'roll' ? (n.startTime ?? 0) : (n?.time ?? 0);
        const pos = timeToBarStep(t, bpm);
        const absStep = (pos.barIndex * 16) + pos.stepIndex;
        return { note: n, absStep };
    });
    const originAbsStep = Math.min(...items.map((x) => x.absStep));

    chartClipboard = {
        originAbsStep,
        items: items.map((x) => ({
            dAbsStep: x.absStep - originAbsStep,
            note: { ...x.note }
        }))
    };
}

/**
 * 内部クリップボードのノーツを指定セル位置へ貼り付け（相対位置維持）
 */
function pasteClipboardNotesAt(barIndex, stepIndex) {
    if (!selectedChartId) return;
    if (!chartClipboard || !Array.isArray(chartClipboard.items) || chartClipboard.items.length === 0) return;

    const bpm = getChartTempo();
    const baseBar = Math.max(0, Number(barIndex) || 0);
    const baseStep = Math.max(0, Math.min(15, Number(stepIndex) || 0));
    const baseAbsStep = baseBar * 16 + baseStep;
    let maxTouchedBar = baseBar;

    for (const item of chartClipboard.items) {
        const targetAbs = baseAbsStep + (item.dAbsStep || 0);
        if (targetAbs < 0) continue;
        const targetBar = Math.floor(targetAbs / 16);
        const targetStep = targetAbs % 16;
        maxTouchedBar = Math.max(maxTouchedBar, targetBar);
        const time = barStepToTime(targetBar, targetStep, bpm);
        const type = item.note?.type;
        if (type === 'roll') {
            // roll は現在UIでは直接扱っていないが、念のため start/end を同じだけ平行移動して貼る
            const s = Number(item.note.startTime ?? 0);
            const e2 = Number(item.note.endTime ?? item.note.startTime ?? 0);
            const { barIndex: ob, stepIndex: os } = timeToBarStep(s, bpm);
            const abs = ob * 16 + os;
            const dAbs = abs - (chartClipboard.originAbsStep || 0);
            const targetAbs2 = baseAbsStep + dAbs;
            if (targetAbs2 < 0) continue;
            const tb = Math.floor(targetAbs2 / 16);
            const ts = targetAbs2 % 16;
            maxTouchedBar = Math.max(maxTouchedBar, tb);
            const ns = barStepToTime(tb, ts, bpm);
            const ne = ns + Math.max(0, e2 - s);
            editingNotes.push({ type: 'roll', startTime: ns, endTime: ne });
            continue;
        }
        if (type === 'roll-start' || type === 'roll-end') {
            const replaceIndex = editingNotes.findIndex((n) => {
                if (n.type !== 'roll-start' && n.type !== 'roll-end') return false;
                const pos = timeToBarStep(n.time ?? 0, bpm);
                return pos.barIndex === targetBar && pos.stepIndex === targetStep;
            });
            if (replaceIndex >= 0) editingNotes[replaceIndex] = { type, time };
            else editingNotes.push({ type, time });
            continue;
        }
        if (type === 'don' || type === 'ka' || (!type && (item.note.time != null))) {
            const noteType = type || item.note.type || 'don';
            const replaceIndex = editingNotes.findIndex((n) => {
                if (n.type !== 'don' && n.type !== 'ka') return false;
                const pos = timeToBarStep(n.time ?? 0, bpm);
                return pos.barIndex === targetBar && pos.stepIndex === targetStep;
            });
            const base = { time, type: noteType };
            if (item.note && item.note.volume != null) base.volume = clampNoteVolume(item.note.volume);
            if (replaceIndex >= 0) editingNotes[replaceIndex] = base;
            else editingNotes.push(base);
        }
    }

    // 貼り付けで末尾が伸びた場合、表示小節数も増やす
    const endEl = document.getElementById('chart-edit-end-time');
    if (endEl) {
        const cur = endEl.value !== '' ? Number(endEl.value) : NaN;
        const curMeasures = Number.isFinite(cur) ? Math.max(1, Math.floor(cur)) : null;
        const needMeasures = Math.max(1, maxTouchedBar + 1);
        if (curMeasures == null || curMeasures < needMeasures) {
            endEl.value = String(needMeasures);
        }
    }

    editingNotes.sort((a, b) => {
        const ta = a.type === 'roll' ? a.startTime : a.time;
        const tb = b.type === 'roll' ? b.startTime : b.time;
        return (ta ?? 0) - (tb ?? 0);
    });
    selectedNoteIndex = -1;
    selectedNoteIndices = new Set();
    renderNotesStrip();
}

/**
 * 編集用ノーツのグリッド上の絶対位置（小節×16+ステップ）を返す
 * @param {{ type?: string, time?: number, startTime?: number, endTime?: number }} note
 * @returns {number}
 */
function getNoteEditorAbsStep(note) {
    if (!note) return 0;
    const t = note.type === 'roll' ? (note.startTime ?? 0) : (note.time ?? 0);
    const { barIndex, stepIndex } = timeToBarStep(t, getChartTempo());
    return barIndex * 16 + stepIndex;
}

/**
 * 選択中のノーツをグリッド上で左右に1マス移動する。移動先に別ノーツがある場合は何もしない。
 * @param {number} delta -1 で左、+1 で右
 * @returns {boolean} 移動したら true
 */
function tryMoveSelectedNotesHorizontally(delta) {
    if (!delta) return false;
    const indices = selectedNoteIndices.size > 0
        ? [...selectedNoteIndices].filter((i) => Number.isInteger(i) && i >= 0 && i < editingNotes.length)
        : (selectedNoteIndex >= 0 ? [selectedNoteIndex] : []);
    if (indices.length === 0) return false;

    const notesToMove = indices.map((i) => editingNotes[i]);
    const newAbsList = notesToMove.map((n) => getNoteEditorAbsStep(n) + delta);

    if (newAbsList.some((a) => a < 0)) return false;

    if (new Set(newAbsList).size !== newAbsList.length) return false;

    const movingSet = new Set(indices);
    for (let j = 0; j < editingNotes.length; j++) {
        if (movingSet.has(j)) continue;
        const stayAbs = getNoteEditorAbsStep(editingNotes[j]);
        if (newAbsList.includes(stayAbs)) return false;
    }

    const maxNewBar = Math.max(...newAbsList.map((a) => Math.floor(a / 16)));
    const endEl = document.getElementById('chart-edit-end-time');
    if (endEl) {
        const cur = endEl.value !== '' ? Number(endEl.value) : NaN;
        const curMeasures = Number.isFinite(cur) ? Math.max(1, Math.floor(cur)) : null;
        const needMeasures = Math.max(1, maxNewBar + 1);
        if (curMeasures == null || curMeasures < needMeasures) {
            endEl.value = String(needMeasures);
        }
    }

    const selectedRefs = notesToMove.slice();
    for (let k = 0; k < notesToMove.length; k++) {
        const n = notesToMove[k];
        const na = newAbsList[k];
        const nb = Math.floor(na / 16);
        const ns = na % 16;
        const newT = barStepToTime(nb, ns, getChartTempo());
        if (n.type === 'roll') {
            const s = Number(n.startTime ?? 0);
            const e = Number(n.endTime ?? n.startTime ?? 0);
            const d = Math.max(0, e - s);
            n.startTime = newT;
            n.endTime = newT + d;
        } else {
            n.time = newT;
        }
    }

    editingNotes.sort((a, b) => {
        const ta = a.type === 'roll' ? a.startTime : a.time;
        const tb = b.type === 'roll' ? b.startTime : b.time;
        return (ta ?? 0) - (tb ?? 0);
    });

    selectedNoteIndices = new Set();
    selectedNoteIndex = -1;
    for (let i = 0; i < editingNotes.length; i++) {
        if (selectedRefs.includes(editingNotes[i])) selectedNoteIndices.add(i);
    }
    if (selectedNoteIndices.size === 1) {
        selectedNoteIndex = [...selectedNoteIndices][0];
    }

    renderNotesStrip();
    return true;
}

/**
 * 譜面作成パネルのボタン・リストのイベントを一度だけバインドする
 */
function bindChartPanelEvents() {
    const btnAdd = document.getElementById('btn-add-chart');
    const btnDelete = document.getElementById('btn-delete-chart');
    const btnExport = document.getElementById('btn-export-charts-json');
    const statusEl = document.getElementById('chart-status');
    const btnPreviewPlay = document.getElementById('btn-chart-preview-play');
    const btnPreviewStop = document.getElementById('btn-chart-preview-stop');

    if (btnExport) {
        btnExport.addEventListener('click', () => exportChartsJson());
    }

    if (btnPreviewPlay) {
        btnPreviewPlay.addEventListener('click', async () => {
            await playChartPreview();
        });
    }
    if (btnPreviewStop) {
        btnPreviewStop.addEventListener('click', () => {
            stopChartPreview();
        });
    }
    const btnPlayAllParts = document.getElementById('btn-chart-play-all-parts');
    if (btnPlayAllParts) {
        btnPlayAllParts.addEventListener('click', async () => {
            const t0 = getChartAllPartsPlaybackStartSec();
            await playChartPreviewAllParts(t0);
        });
    }
    updateChartPreviewControlsUI();

    if (btnAdd) {
        btnAdd.addEventListener('click', async () => {
            const id = prompt('譜面ID（英数字・アンダースコア・ハイフン）', 'chart_' + Date.now());
            if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return;
            statusEl.textContent = '追加中...';
            try {
                const res = await fetch('/admin/charts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, name: id, notes: [] })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    statusEl.textContent = data.error || res.statusText;
                    return;
                }
                statusEl.textContent = '追加しました';
                selectedChartId = id;
                loadCharts();
            } catch (err) {
                statusEl.textContent = '追加失敗: ' + err.message;
            }
        });
    }

    const btnImportChart = document.getElementById('btn-import-chart-json');
    const chartImportInput = document.getElementById('chart-import-json-input');
    if (btnImportChart && chartImportInput) {
        btnImportChart.addEventListener('click', () => {
            chartImportInput.value = '';
            chartImportInput.click();
        });
        chartImportInput.addEventListener('change', async () => {
            const file = chartImportInput.files && chartImportInput.files[0];
            if (!file) return;
            if (statusEl) statusEl.textContent = 'インポート中...';
            btnImportChart.disabled = true;
            try {
                const text = await file.text();
                const { imported, lastId, message } = await importChartsFromJsonText(text, statusEl);
                if (imported > 0 && lastId) {
                    selectedChartId = lastId;
                }
                if (imported > 0) {
                    await loadCharts();
                    if (statusEl) statusEl.textContent = message;
                    if (lastId && cachedCharts[lastId]) {
                        loadChartIntoEditor(cachedCharts[lastId]);
                    }
                }
            } catch (err) {
                if (statusEl) statusEl.textContent = '読み込み失敗: ' + (err instanceof Error ? err.message : String(err));
            } finally {
                btnImportChart.disabled = false;
                chartImportInput.value = '';
            }
        });
    }

    const btnChartBgmImport = document.getElementById('btn-chart-bgm-import');
    const btnChartBgmRemove = document.getElementById('btn-chart-bgm-remove');
    const chartBgmFileInput = document.getElementById('chart-bgm-file-input');
    if (btnChartBgmImport && chartBgmFileInput) {
        btnChartBgmImport.addEventListener('click', () => {
            chartBgmFileInput.value = '';
            chartBgmFileInput.click();
        });
        chartBgmFileInput.addEventListener('change', async () => {
            const file = chartBgmFileInput.files && chartBgmFileInput.files[0];
            if (!file || !selectedChartId) return;
            const lower = (file.name || '').toLowerCase();
            if (!lower.endsWith('.mp3')) {
                if (statusEl) statusEl.textContent = 'MP3ファイルを選択してください';
                chartBgmFileInput.value = '';
                return;
            }
            if (statusEl) statusEl.textContent = 'BGMをアップロード中...';
            btnChartBgmImport.disabled = true;
            const fd = new FormData();
            fd.append('bgm', file);
            try {
                const res = await fetch('/admin/charts/' + encodeURIComponent(selectedChartId) + '/bgm', {
                    method: 'POST',
                    body: fd,
                    credentials: 'include'
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    if (statusEl) statusEl.textContent = data.error || 'BGMのアップロードに失敗しました';
                    return;
                }
                if (data.chart) {
                    cachedCharts[selectedChartId] = data.chart;
                    invalidateChartBgmPreviewCache();
                    updateChartBgmRowUi();
                }
                if (statusEl) statusEl.textContent = 'BGMを設定しました';
            } catch (err) {
                if (statusEl) statusEl.textContent = 'BGMアップロード失敗: ' + (err instanceof Error ? err.message : String(err));
            } finally {
                chartBgmFileInput.value = '';
                updateChartBgmRowUi();
            }
        });
    }
    if (btnChartBgmRemove) {
        btnChartBgmRemove.addEventListener('click', async () => {
            if (!selectedChartId) return;
            if (!confirm('この譜面のBGMを削除しますか？')) return;
            try {
                const res = await fetch('/admin/charts/' + encodeURIComponent(selectedChartId) + '/bgm', {
                    method: 'DELETE',
                    credentials: 'include'
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    if (statusEl) statusEl.textContent = data.error || '削除に失敗しました';
                    return;
                }
                if (data.chart) {
                    cachedCharts[selectedChartId] = data.chart;
                } else {
                    const c = cachedCharts[selectedChartId];
                    if (c) {
                        delete c.bgmVersion;
                        delete c.bgmOriginalName;
                    }
                }
                invalidateChartBgmPreviewCache();
                updateChartBgmRowUi();
                if (statusEl) statusEl.textContent = 'BGMを削除しました';
            } catch (e) {
                if (statusEl) statusEl.textContent = '削除失敗: ' + (e instanceof Error ? e.message : String(e));
            }
        });
    }

    const btnSave = document.getElementById('btn-save-chart');
    if (btnSave) {
        btnSave.addEventListener('click', async () => {
            if (!selectedChartId) return;
            const nameEl = document.getElementById('chart-edit-name');
            const difficultyEl = document.getElementById('chart-edit-difficulty');
            const tempoEl = document.getElementById('chart-edit-tempo');
            const endTimeEl = document.getElementById('chart-edit-end-time');
            const name = nameEl ? nameEl.value.trim() : '';
            const difficulty = difficultyEl && difficultyEl.value ? difficultyEl.value : null;
            const tempo = tempoEl && tempoEl.value ? Number(tempoEl.value) : null;
            const endMeasures = endTimeEl && endTimeEl.value !== '' ? Number(endTimeEl.value) : null;
            const bpm = tempo != null && Number.isFinite(tempo) ? tempo : getChartTempo();
            const endTime = endMeasures != null && Number.isFinite(endMeasures)
                ? Math.max(1, Math.floor(endMeasures)) * getBarSec(bpm)
                : null;
            statusEl.textContent = '保存中...';
            flushChartPartSlot();
            const n1 = chartPartNoteSlots[0];
            const n2 = chartPartNoteSlots[1];
            const n3 = chartPartNoteSlots[2];
            const pn1 = document.getElementById('chart-part-name-1')?.value?.trim?.() || '';
            const pn2 = document.getElementById('chart-part-name-2')?.value?.trim?.() || '';
            const pn3 = document.getElementById('chart-part-name-3')?.value?.trim?.() || '';
            chartPartNames = { 1: pn1.slice(0, 20), 2: pn2.slice(0, 20), 3: pn3.slice(0, 20) };
            updateChartPartTabLabels();
            try {
                const res = await fetch('/admin/charts/' + encodeURIComponent(selectedChartId), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name || selectedChartId,
                        notes: n1,
                        notes2: n2,
                        notes3: n3,
                        partNames: chartPartNames,
                        difficulty,
                        tempo,
                        endTime,
                        measureBpms: chartMeasureBpms
                    })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    statusEl.textContent = data.error || res.statusText;
                    return;
                }
                statusEl.textContent = '保存しました';
                cachedCharts[selectedChartId] = {
                    ...cachedCharts[selectedChartId],
                    name: name || selectedChartId,
                    notes: n1,
                    notes2: n2,
                    notes3: n3,
                    partNames: chartPartNames,
                    difficulty,
                    tempo,
                    endTime,
                    measureBpms: chartMeasureBpms
                };
                renderChartList(cachedCharts);
            } catch (err) {
                statusEl.textContent = '保存失敗: ' + err.message;
            }
        });
    }

    // パート名の入力変更 → タブ表示を即時更新（保存は「保存」ボタン）
    ['1', '2', '3'].forEach((n) => {
        const el = document.getElementById('chart-part-name-' + n);
        if (!el) return;
        el.addEventListener('input', () => {
            chartPartNames[Number(n)] = (el.value || '').slice(0, 20);
            updateChartPartTabLabels();
        });
    });

    document.querySelectorAll('.chart-part-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            const p = Number(btn.dataset.part);
            if (p >= 1 && p <= 3) setChartEditingPart(p);
        });
    });

    const btnRemoveNote = document.getElementById('btn-remove-selected-note');
    if (btnRemoveNote) {
        btnRemoveNote.addEventListener('click', () => {
            if (!selectedChartId) {
                if (statusEl) statusEl.textContent = '譜面を選択してください';
                return;
            }
            if (selectedNoteIndex < 0 || selectedNoteIndex >= editingNotes.length) return;
            editingNotes.splice(selectedNoteIndex, 1);
            selectedNoteIndex = -1;
            renderNotesStrip();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        const chartPanel = document.getElementById('panel-chart');
        if (!chartPanel || !chartPanel.classList.contains('active')) return;
        if (!selectedChartId) {
            if (statusEl) statusEl.textContent = '譜面を選択してください';
            return;
        }
        if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
        e.preventDefault();
        if (selectedNoteIndices && selectedNoteIndices.size > 0) {
            const indices = [...selectedNoteIndices]
                .filter((i) => Number.isInteger(i) && i >= 0 && i < editingNotes.length)
                .sort((a, b) => b - a);
            if (indices.length === 0) return;
            for (const idx of indices) {
                editingNotes.splice(idx, 1);
            }
            selectedNoteIndices = new Set();
            selectedNoteIndex = -1;
        } else {
            if (selectedNoteIndex < 0 || selectedNoteIndex >= editingNotes.length) return;
            editingNotes.splice(selectedNoteIndex, 1);
            selectedNoteIndex = -1;
        }
        renderNotesStrip();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const chartPanel = document.getElementById('panel-chart');
        if (!chartPanel || !chartPanel.classList.contains('active')) return;
        if (!selectedChartId) return;
        if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
        const hasSelection = selectedNoteIndices.size > 0
            || (selectedNoteIndex >= 0 && selectedNoteIndex < editingNotes.length);
        if (!hasSelection) return;
        e.preventDefault();
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        tryMoveSelectedNotesHorizontally(delta);
    });

    const scrollEl = document.getElementById('chart-measures-scroll');
    const gridEl = document.getElementById('chart-measures-grid');
    const paletteDon = document.querySelector('.note-palette-item.note-don');
    const paletteKa = document.querySelector('.note-palette-item.note-ka');
    const paletteRollStart = document.querySelector('.note-palette-item.note-roll-start');
    const paletteRollEnd = document.querySelector('.note-palette-item.note-roll-end');
    const paletteItems = [paletteDon, paletteKa, paletteRollStart, paletteRollEnd].filter(Boolean);
    if (scrollEl && gridEl && paletteItems.length > 0) {
        paletteItems.forEach((el) => {
            el.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', el.dataset.noteType || 'don');
                e.dataTransfer.effectAllowed = 'copy';
            });
        });
        gridEl.addEventListener('dragover', (e) => {
            const cell = e.target.closest('.measure-cell');
            if (!cell) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            cell.classList.add('drag-over');
        });
        gridEl.addEventListener('dragleave', (e) => {
            const cell = e.target.closest('.measure-cell');
            if (!cell) return;
            if (!cell.contains(e.relatedTarget)) {
                cell.classList.remove('drag-over');
            }
        });
        scrollEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            scrollEl.classList.add('drag-over');
            const cell = e.target.closest('.measure-cell');
            if (!cell) return;
            const barIndex = parseInt(cell.dataset.barIndex, 10);
            const stepIndex = parseInt(cell.dataset.stepIndex, 10);
            const time = barStepToTime(barIndex, stepIndex, getChartTempo());
            updateChartPalette(isTimeInRollSection(time));
        });
        scrollEl.addEventListener('dragleave', (e) => {
            if (!scrollEl.contains(e.relatedTarget)) {
                scrollEl.classList.remove('drag-over');
                updateChartPalette(false);
            }
        });
        scrollEl.addEventListener('drop', (e) => {
            e.preventDefault();
            scrollEl.classList.remove('drag-over');
            updateChartPalette(false);
            if (!selectedChartId) {
                if (statusEl) statusEl.textContent = '譜面を選択してください';
                return;
            }
            const type = (e.dataTransfer.getData('text/plain') || 'don').trim();
            const cell = e.target.closest('.measure-cell');
            if (!cell) return;
            cell.classList.remove('drag-over');
            const barIndex = parseInt(cell.dataset.barIndex, 10);
            const stepIndex = parseInt(cell.dataset.stepIndex, 10);
            const time = barStepToTime(barIndex, stepIndex, getChartTempo());

            if (type === 'roll-start' || type === 'roll-end') {
                const { barIndex: bi, stepIndex: si } = timeToBarStep(time, getChartTempo());
                const qTime = barStepToTime(bi, si, getChartTempo());
                const replaceIndex = editingNotes.findIndex((n) => {
                    if (n.type !== 'roll-start' && n.type !== 'roll-end') return false;
                    const { barIndex: nbi, stepIndex: nsi } = timeToBarStep(n.time ?? 0, getChartTempo());
                    return nbi === bi && nsi === si;
                });
                if (replaceIndex >= 0) {
                    editingNotes[replaceIndex] = { type, time: qTime };
                } else {
                    editingNotes.push({ type, time: qTime });
                }
            } else if (type === 'ka' || type === 'don') {
                if (isTimeInRollSection(time)) {
                    if (statusEl) statusEl.textContent = '連打区間内にはドン・カを設置できません';
                    return;
                }
                const { barIndex: bi, stepIndex: si } = timeToBarStep(time, getChartTempo());
                const qTime = barStepToTime(bi, si, getChartTempo());
                const replaceIndex = editingNotes.findIndex((n) => {
                    if (n.type !== 'don' && n.type !== 'ka') return false;
                    const { barIndex: nbi, stepIndex: nsi } = timeToBarStep(n.time ?? 0, getChartTempo());
                    return nbi === bi && nsi === si;
                });
                if (replaceIndex >= 0) {
                    editingNotes[replaceIndex] = { ...editingNotes[replaceIndex], time: qTime, type };
                } else {
                    editingNotes.push({ time: qTime, type });
                }
            } else {
                return;
            }
            editingNotes.sort((a, b) => {
                const ta = a.type === 'roll' ? a.startTime : a.time;
                const tb = b.type === 'roll' ? b.startTime : b.time;
                return ta - tb;
            });
            selectedNoteIndex = -1;
            renderNotesStrip();
            if (statusEl && (type === 'roll-start' || type === 'roll-end')) statusEl.textContent = '';
        });
        const tempoEl = document.getElementById('chart-edit-tempo');
        if (tempoEl) {
            tempoEl.addEventListener('input', () => {
                const oldBpm = lastRenderedChartBpm ?? getChartTempo();
                const newBpm = getChartTempo();
                retimeEditingNotesKeepGridPositionVarBpm(oldBpm, newBpm);
                renderNotesStrip();
                updateChartPreviewControlsUI();
            });
        }
    }

    // 範囲選択（ドラッグ） + コピー（Ctrl+C） + 右クリックペースト
    if (gridEl) {
        let selecting = false;
        let startCell = null;
        let lastCell = null;

        function clearRangeHighlight() {
            gridEl.querySelectorAll('.measure-cell.range-selected').forEach((c) => c.classList.remove('range-selected'));
        }

        function applyRangeHighlight(a, b) {
            if (!a || !b) return;
            const aBar = parseInt(a.dataset.barIndex, 10);
            const aStep = parseInt(a.dataset.stepIndex, 10);
            const bBar = parseInt(b.dataset.barIndex, 10);
            const bStep = parseInt(b.dataset.stepIndex, 10);
            const aAbs = aBar * 16 + aStep;
            const bAbs = bBar * 16 + bStep;
            const minAbs = Math.min(aAbs, bAbs);
            const maxAbs = Math.max(aAbs, bAbs);
            gridEl.querySelectorAll('.measure-cell').forEach((cell) => {
                const bi = parseInt(cell.dataset.barIndex, 10);
                const si = parseInt(cell.dataset.stepIndex, 10);
                const abs = bi * 16 + si;
                const inRange = abs >= minAbs && abs <= maxAbs;
                cell.classList.toggle('range-selected', inRange);
            });
            selectedNoteIndices = getNoteIndicesInAbsStepRange(aBar, aStep, bBar, bStep);
            selectedNoteIndex = -1;
            renderNotesStrip();
        }

        gridEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // ノーツチップ上は範囲選択にしない（ドン・カの音量ドラッグと DOM 再生成の競合を防ぐ）
            if (e.target.closest('.note-chip')) return;
            const cell = e.target.closest('.measure-cell');
            if (!cell) return;
            if (!selectedChartId) return;
            selecting = true;
            startCell = cell;
            lastCell = cell;
            clearRangeHighlight();
            selectedNoteIndices = getNoteIndicesInAbsStepRange(
                parseInt(cell.dataset.barIndex, 10),
                parseInt(cell.dataset.stepIndex, 10),
                parseInt(cell.dataset.barIndex, 10),
                parseInt(cell.dataset.stepIndex, 10)
            );
            selectedNoteIndex = -1;
            renderNotesStrip();
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!selecting) return;
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const cell = el ? el.closest?.('.measure-cell') : null;
            if (!cell || cell === lastCell) return;
            lastCell = cell;
            clearRangeHighlight();
            applyRangeHighlight(startCell, lastCell);
        });

        document.addEventListener('mouseup', () => {
            if (!selecting) return;
            selecting = false;
        });

        gridEl.addEventListener('contextmenu', (e) => {
            const cell = e.target.closest('.measure-cell');
            if (!cell) return;
            e.preventDefault();
            if (!selectedChartId) return;
            const bi = parseInt(cell.dataset.barIndex, 10);
            const si = parseInt(cell.dataset.stepIndex, 10);
            pasteClipboardNotesAt(bi, si);
        });

        document.addEventListener('keydown', (e) => {
            const chartPanel = document.getElementById('panel-chart');
            if (!chartPanel || !chartPanel.classList.contains('active')) return;
            if (!selectedChartId) return;
            if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
                if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
                e.preventDefault();
                copySelectedNotesToClipboard();
            }
        });
    }

    if (btnDelete) {
        btnDelete.addEventListener('click', async () => {
            if (!selectedChartId) return;
            if (!confirm('譜面「' + selectedChartId + '」を削除しますか？')) return;
            statusEl.textContent = '削除中...';
            try {
                const res = await fetch('/admin/charts/' + encodeURIComponent(selectedChartId), { method: 'DELETE' });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    statusEl.textContent = data.error || res.statusText;
                    return;
                }
                statusEl.textContent = '削除しました';
                selectedChartId = null;
                loadCharts();
            } catch (err) {
                statusEl.textContent = '削除失敗: ' + err.message;
            }
        });
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem(ADMIN_THEME_KEY);
    applyAdminTheme(savedTheme === 'dark');

    // 左サイドバー: ホバー中だけ展開し、外れると収納
    const adminSidebar = document.querySelector('.admin-sidebar');
    if (adminSidebar) {
        adminSidebar.classList.add('collapsed');
        adminSidebar.addEventListener('mouseenter', () => adminSidebar.classList.remove('collapsed'));
        adminSidebar.addEventListener('mouseleave', () => adminSidebar.classList.add('collapsed'));
    }

    document.getElementById('admin-theme-toggle')?.addEventListener('click', () => {
        const isDark = !document.body.classList.contains('admin-dark');
        localStorage.setItem(ADMIN_THEME_KEY, isDark ? 'dark' : 'light');
        applyAdminTheme(isDark);
    });

    // サイドメニュー: クリックでパネル切り替え
    document.querySelectorAll('.admin-nav-item').forEach((btn) => {
        btn.addEventListener('click', () => {
            const panelId = btn.getAttribute('data-panel');
            if (panelId) switchPanel(panelId);
        });
    });

    // URL の ?panel= で初期表示パネルを指定（例: ?panel=world-edit）
    const params = new URLSearchParams(location.search);
    const initialPanel = params.get('panel');
    const validPanels = ['panel-status', 'panel-players', 'panel-comm', 'panel-logs', 'panel-user-register', 'panel-world-edit', 'panel-chart'];
    if (initialPanel && validPanels.includes(initialPanel)) {
        switchPanel(initialPanel);
    }

    loadStats();
    loadPlayers();
    loadWorldsForCompletion();
    loadLogs();
    loadChatLogs();
    updateRoomFilter();

    // Auto-refresh
    setInterval(() => {
        loadStats();
        loadPlayers();
        loadWorldsForCompletion();
        loadLogs();
        loadChatLogs();
        if (document.getElementById('panel-user-register')?.classList.contains('active')) {
            loadUsers();
        }
        if (document.getElementById('panel-logs')?.classList.contains('active')) {
            loadLoginUsers(currentLoginUsersPage);
        }
    }, UPDATE_INTERVAL);

    // 通信帯域グラフ用（1秒ごと）
    updateBandwidth();
    setInterval(updateBandwidth, BANDWIDTH_POLL_INTERVAL);
    
    // Alert modal handlers
    setupAlertModal();
    
    // Chat logs controls
    document.getElementById('room-filter').addEventListener('change', () => {
        loadChatLogs();
    });
    document.getElementById('refresh-chat-logs').addEventListener('click', () => {
        loadChatLogs();
    });

    document.getElementById('chat-logs-container').addEventListener('click', (e) => {
        const btn = e.target.closest('.chat-log-username-link');
        if (btn && btn.dataset.username) {
            e.preventDefault();
            openUserSessionModal(btn.dataset.username);
        }
    });

    document.getElementById('refresh-login-users').addEventListener('click', () => loadLoginUsers(currentLoginUsersPage));
    document.getElementById('login-users-prev').addEventListener('click', () => {
        if (currentLoginUsersPage > 1) loadLoginUsers(currentLoginUsersPage - 1);
    });
    document.getElementById('login-users-next').addEventListener('click', () => {
        loadLoginUsers(currentLoginUsersPage + 1);
    });
    document.getElementById('user-session-modal-close').addEventListener('click', () => {
        document.getElementById('user-session-modal').classList.remove('show');
    });
    document.getElementById('user-session-modal').addEventListener('click', (e) => {
        if (e.target.id === 'user-session-modal') document.getElementById('user-session-modal').classList.remove('show');
    });
    document.getElementById('login-users-tbody')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.login-user-name-link');
        if (btn && btn.dataset.username) {
            e.preventDefault();
            openUserSessionModal(btn.dataset.username);
        }
    });

    // ユーザー登録パネル: 新規登録・編集・削除
    setupUserRegisterPanel();

    // Command execution (Enter to execute) + selector tab completion
    setupCommandCompletion();

    // メタバースへ入る（管理者）: Basic認証済みでトークン取得しメタバースへ遷移
    document.getElementById('back-to-metaverse').addEventListener('click', async () => {
        const btn = document.getElementById('back-to-metaverse');
        btn.disabled = true;
        btn.textContent = '読み込み中...';
        try {
            const res = await fetch('/admin/enter-metaverse', { credentials: 'include' });
            if (!res.ok) {
                alert('認証に失敗しました。再度ログインしてください。');
                btn.disabled = false;
                btn.textContent = 'メタバースへ入る（管理者）';
                return;
            }
            const { token, username } = await res.json();
            sessionStorage.setItem('metaverseAdminToken', token);
            localStorage.setItem('username', username);
            window.location.href = '/admin';
        } catch (err) {
            console.error('Failed to enter metaverse as admin:', err);
            alert('メタバースへの入室に失敗しました。');
            btn.disabled = false;
            btn.textContent = 'メタバースへ入る（管理者）';
        }
    });
});

function updateLastUpdateTime() {
    const now = new Date();
    document.getElementById('last-update').textContent = now.toLocaleTimeString('ja-JP');
}

async function loadStats() {
    try {
        const response = await fetch('/admin/stats', { credentials: 'include' });
        const data = await response.json();
        
        document.getElementById('total-players').textContent = data.totalPlayers;
        document.getElementById('total-rooms').textContent = data.totalRooms;
        document.getElementById('vc-rooms').textContent = data.activeVCRooms;
        document.getElementById('vc-peers').textContent = data.activeVCPeers;
        document.getElementById('bytes-sent').textContent = data.traffic.bytesSentFormatted;
        document.getElementById('bytes-received').textContent = data.traffic.bytesReceivedFormatted;
        document.getElementById('packets-sent').textContent = data.traffic.packetsSent.toLocaleString();
        document.getElementById('packets-received').textContent = data.traffic.packetsReceived.toLocaleString();

        const cpuEl = document.getElementById('cpu-usage');
        const ramEl = document.getElementById('ram-usage');
        const degEl = document.getElementById('degradation-index');
        if (cpuEl) cpuEl.textContent = data.cpuUsagePercent != null ? `${data.cpuUsagePercent.toFixed(1)}%` : '-';
        if (ramEl) ramEl.textContent = data.ramUsagePercent != null ? `${data.ramUsagePercent.toFixed(1)}%` : '-';
        if (degEl) degEl.textContent = data.degradationIndex != null ? data.degradationIndex.toFixed(2) : '-';
        
        // Update VC ports
        const portList = document.getElementById('port-list');
        const portCount = document.getElementById('port-count');
        portCount.textContent = data.vcPorts.portCount;
        portList.innerHTML = (data.vcPorts.uniquePorts.length > 0)
            ? data.vcPorts.uniquePorts.map(port => `<span class="port-badge">${port}</span>`).join('')
            : '<span style="color: #999;">使用中のポートなし</span>';

        // Update PDF VC ports
        const pdfPortList = document.getElementById('pdf-port-list');
        const pdfPortCount = document.getElementById('pdf-port-count');
        if (pdfPortList && pdfPortCount) {
            pdfPortCount.textContent = data.pdfVcPorts?.portCount ?? 0;
            pdfPortList.innerHTML = (data.pdfVcPorts?.uniquePorts?.length > 0)
                ? data.pdfVcPorts.uniquePorts.map(port => `<span class="port-badge">${port}</span>`).join('')
                : '<span style="color: #999;">使用中のポートなし</span>';
        }

        // Update Video VC ports
        const videoPortList = document.getElementById('video-port-list');
        const videoPortCount = document.getElementById('video-port-count');
        if (videoPortList && videoPortCount) {
            videoPortCount.textContent = data.videoVcPorts?.portCount ?? 0;
            videoPortList.innerHTML = (data.videoVcPorts?.uniquePorts?.length > 0)
                ? data.videoVcPorts.uniquePorts.map(port => `<span class="port-badge">${port}</span>`).join('')
                : '<span style="color: #999;">使用中のポートなし</span>';
        }

        updateLastUpdateTime();
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

function formatBps(bps) {
    if (bps >= 1e6) return (bps / 1e6).toFixed(2) + ' MB/s';
    if (bps >= 1e3) return (bps / 1e3).toFixed(2) + ' KB/s';
    return Math.round(bps) + ' B/s';
}

function updateBandwidthFromStats(data) {
    const now = Date.now();
    const sent = data.traffic.bytesSent;
    const recv = data.traffic.bytesReceived;
    const limitBps = data.bandwidthLimitBps || 1;

    let sentBps = 0, recvBps = 0;
    if (lastTrafficSample) {
        const dtSec = (now - lastTrafficSample.ts) / 1000;
        if (dtSec > 0) {
            sentBps = (sent - lastTrafficSample.bytesSent) / dtSec;
            recvBps = (recv - lastTrafficSample.bytesReceived) / dtSec;
        }
    }
    lastTrafficSample = { bytesSent: sent, bytesReceived: recv, ts: now };

    bandwidthHistory.push({
        t: now,
        sentBps: Math.max(0, sentBps),
        recvBps: Math.max(0, recvBps)
    });
    if (bandwidthHistory.length > BANDWIDTH_HISTORY_MAX) {
        bandwidthHistory.shift();
    }

    const totalBps = sentBps + recvBps;
    const usagePct = Math.min(100, (totalBps / limitBps) * 100);

    document.getElementById('bandwidth-limit').textContent = formatBps(limitBps) + ' (' + (data.bandwidthLimitMbps || 0) + ' Mbps)';
    document.getElementById('bandwidth-current').textContent = formatBps(totalBps);
    const usageEl = document.getElementById('bandwidth-usage');
    usageEl.textContent = usagePct.toFixed(1) + '%';
    usageEl.className = 'bandwidth-value bandwidth-usage-' + (usagePct >= 90 ? 'high' : usagePct >= 50 ? 'mid' : 'low');

    drawBandwidthGraph(limitBps);
}

function updateBandwidth() {
    fetch('/admin/stats', { credentials: 'include' })
        .then(r => r.json())
        .then(data => {
            if (data.bandwidthLimitBps != null && data.traffic) {
                updateBandwidthFromStats(data);
            }
        })
        .catch(() => {});
}

function drawBandwidthGraph(limitBps) {
    const canvas = document.getElementById('bandwidth-graph');
    if (!canvas || bandwidthHistory.length < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const padding = { top: 20, right: 20, bottom: 24, left: 50 };
    const graphW = w - padding.left - padding.right;
    const graphH = h - padding.top - padding.bottom;

    const isDark = document.body.classList.contains('admin-dark');
    ctx.fillStyle = isDark ? '#1f1e19' : '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // 縦軸オートスケール: 実データの最大値に余白を加算
    const dataMax = Math.max(...bandwidthHistory.flatMap(p => [p.sentBps + p.recvBps, p.sentBps, p.recvBps]), 1);
    const maxBps = dataMax * 1.1;
    const scale = graphH / maxBps;

    // Grid
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
        const y = padding.top + graphH - (graphH * i / 5);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(padding.left + graphW, y);
        ctx.stroke();
    }

    // Limit line (データ範囲内にある場合のみ表示)
    const limitY = padding.top + graphH - (limitBps * scale);
    if (limitY > padding.top && limitY < padding.top + graphH && limitBps <= maxBps) {
        ctx.strokeStyle = 'rgba(2, 136, 209, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padding.left, limitY);
        ctx.lineTo(padding.left + graphW, limitY);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    const firstT = bandwidthHistory[0].t;
    const lastT = bandwidthHistory[bandwidthHistory.length - 1].t;
    const timeSpan = Math.max(1, lastT - firstT);

    function xFor(i) {
        return padding.left + (bandwidthHistory[i].t - firstT) / timeSpan * graphW;
    }

    // Recv area (bottom, アクセントブルー)
    ctx.fillStyle = 'rgba(2, 136, 209, 0.3)';
    ctx.beginPath();
    ctx.moveTo(xFor(0), padding.top + graphH);
    for (let i = 0; i < bandwidthHistory.length; i++) {
        const y = padding.top + graphH - bandwidthHistory[i].recvBps * scale;
        ctx.lineTo(xFor(i), y);
    }
    ctx.lineTo(xFor(bandwidthHistory.length - 1), padding.top + graphH);
    ctx.closePath();
    ctx.fill();

    // Sent area (top, ブルー濃淡)
    ctx.fillStyle = 'rgba(2, 136, 209, 0.5)';
    ctx.beginPath();
    ctx.moveTo(xFor(0), padding.top + graphH);
    for (let i = 0; i < bandwidthHistory.length; i++) {
        const stacked = bandwidthHistory[i].recvBps + bandwidthHistory[i].sentBps;
        const y = padding.top + graphH - stacked * scale;
        ctx.lineTo(xFor(i), y);
    }
    ctx.lineTo(xFor(bandwidthHistory.length - 1), padding.top + graphH);
    ctx.closePath();
    ctx.fill();

    // Recv line (アクセントブルー)
    ctx.strokeStyle = '#0288d1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xFor(0), padding.top + graphH - bandwidthHistory[0].recvBps * scale);
    for (let i = 1; i < bandwidthHistory.length; i++) {
        ctx.lineTo(xFor(i), padding.top + graphH - bandwidthHistory[i].recvBps * scale);
    }
    ctx.stroke();

    // Sent line (stacked, アクセントブルー濃いめ)
    ctx.strokeStyle = '#01579b';
    ctx.beginPath();
    let sy0 = padding.top + graphH - (bandwidthHistory[0].recvBps + bandwidthHistory[0].sentBps) * scale;
    ctx.moveTo(xFor(0), sy0);
    for (let i = 1; i < bandwidthHistory.length; i++) {
        const sy = padding.top + graphH - (bandwidthHistory[i].recvBps + bandwidthHistory[i].sentBps) * scale;
        ctx.lineTo(xFor(i), sy);
    }
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = isDark ? 'rgba(230,228,223,0.8)' : 'rgba(0,0,0,0.6)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
        const val = (maxBps * (5 - i) / 5);
        const lab = formatBps(val);
        ctx.fillText(lab, padding.left - 8, padding.top + graphH * i / 5 + 4);
    }
}

async function loadWorldsForCompletion() {
    try {
        const response = await fetch('/admin/worlds', { credentials: 'include' });
        const worlds = await response.json();
        cachedWorldIdsForCompletion = Object.keys(worlds || {}).sort();
    } catch (e) {
        cachedWorldIdsForCompletion = [];
    }
}

async function loadPlayers() {
    try {
        const response = await fetch('/admin/players', { credentials: 'include' });
        const players = await response.json();
        cachedPlayersForCompletion = players;

        const tbody = document.getElementById('players-tbody');

        if (players.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="loading">接続中のプレイヤーなし</td></tr>';
            // Update room filter when players are loaded
            updateRoomFilter();
            return;
        }
        
        tbody.innerHTML = players.map(player => {
            const connectedTime = formatDuration(player.connectedDuration);
            
            let vcStatus = '<span class="vc-badge mic-off"><i class="bi bi-mic-mute"></i> マイクOFF</span>';
            if (player.vcMicOn) {
                vcStatus = '<span class="vc-badge mic-on"><i class="bi bi-mic"></i> マイクON</span>';
            }
            
            if (player.vcSpeakerOn) {
                vcStatus += '<span class="vc-badge speaker-on"><i class="bi bi-megaphone"></i> スピーカーON</span>';
            } else {
                vcStatus += '<span class="vc-badge speaker-off"><i class="bi bi-megaphone-fill"></i> スピーカーOFF</span>';
            }

            const ping = player.pingMs != null ? player.pingMs : null;
            const pingClass = ping == null ? 'ping-none' : (ping <= 100 ? 'ping-green' : ping <= 300 ? 'ping-yellow' : 'ping-red');
            const pingText = ping != null ? `${ping}ms` : '応答なし';
            const pingCell = `<span class="ping-badge ${pingClass}">${pingText}</span>`;

            const roleLabel = player.role === 'student' ? '[生徒]' : player.role === 'teacher' ? '[教師]' : player.role === 'admin' ? '[管理者]' : '';

            return `
                <tr>
                    <td><span class="socket-id">${player.socketId}</span></td>
                    <td><span class="username">${escapeHtml(player.username)}</span></td>
                    <td><span class="room-badge">${escapeHtml(player.room)}</span></td>
                    <td>${connectedTime}</td>
                    <td>${pingCell}</td>
                    <td><span class="role-badge">${roleLabel}</span></td>
                    <td><div class="vc-status">${vcStatus}</div></td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn btn-kick" onclick="kickPlayer('${player.socketId}')">Kick</button>
                            <button class="btn btn-mute" onclick="muteMic('${player.socketId}')" ${!player.vcMicOn ? 'disabled' : ''}>強制ミュート</button>
                            <button class="btn btn-alert" onclick="showAlertModal('${player.socketId}')">メッセージ</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        
        // Update room filter after loading players
        updateRoomFilter();
    } catch (error) {
        console.error('Failed to load players:', error);
        document.getElementById('players-tbody').innerHTML = 
            '<tr><td colspan="8" class="loading">エラー: プレイヤー情報の取得に失敗しました</td></tr>';
    }
}

async function loadChatLogs() {
    try {
        const roomFilter = document.getElementById('room-filter').value;
        const url = roomFilter 
            ? `/admin/chat-logs?room=${encodeURIComponent(roomFilter)}&limit=200`
            : '/admin/chat-logs?limit=200';
        
        const response = await fetch(url, { credentials: 'include' });
        const logs = await response.json();
        
        const container = document.getElementById('chat-logs-container');
        
        if (logs.length === 0) {
            container.innerHTML = '<div class="loading">チャットログなし</div>';
            return;
        }
        
        container.innerHTML = logs.map(log => {
            const timestamp = new Date(log.timestamp).toLocaleTimeString('ja-JP', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            const roomId = log.roomId || 'unknown';
            const name = escapeHtml(log.senderName);
            const usernameAttr = escapeHtml(log.senderName).replace(/"/g, '&quot;');
            return `
                <div class="chat-log-entry">
                    <span class="chat-log-timestamp">${timestamp}</span>
                    <span class="chat-log-room">[${escapeHtml(roomId)}]</span>
                    <button type="button" class="chat-log-username-link" data-username="${usernameAttr}" title="ユーザー情報を表示">${name}</button>
                    <span class="chat-log-message">${escapeHtml(log.message)}</span>
                </div>
            `;
        }).join('');
        
        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
    } catch (error) {
        console.error('Failed to load chat logs:', error);
        document.getElementById('chat-logs-container').innerHTML = 
            '<div class="loading">エラー: チャットログの取得に失敗しました</div>';
    }
}

/**
 * チャットログのユーザー名クリック時: ユーザー情報（ログイン時間・IP・ブラウザ・OS）を取得してモーダル表示
 */
async function openUserSessionModal(username) {
    const modal = document.getElementById('user-session-modal');
    const titleEl = document.getElementById('user-session-modal-title');
    const emptyEl = document.getElementById('user-session-empty');
    const dlEl = document.getElementById('user-session-dl');
    titleEl.textContent = `ユーザー情報: ${escapeHtml(username)}`;
    emptyEl.style.display = 'block';
    dlEl.style.display = 'none';
    modal.classList.add('show');

    try {
        const res = await fetch(`/admin/user-sessions/by-username/${encodeURIComponent(username)}`, { credentials: 'include' });
        const session = await res.json();
        if (session && session.login_time != null) {
            emptyEl.style.display = 'none';
            dlEl.style.display = '';
            document.getElementById('user-session-username').textContent = session.username || '-';
            document.getElementById('user-session-login-time').textContent = new Date(session.login_time).toLocaleString('ja-JP');
            document.getElementById('user-session-ip').textContent = session.ip || '-';
            document.getElementById('user-session-browser').textContent = session.browser || '-';
            document.getElementById('user-session-os').textContent = session.os || '-';
        }
    } catch (err) {
        console.error('Failed to load user session:', err);
    }
}

/**
 * ログインユーザー一覧を取得して表示（ページネーション対応・最大50件/ページ）
 */
async function loadLoginUsers(page) {
    const tbody = document.getElementById('login-users-tbody');
    const infoEl = document.getElementById('login-users-pagination-info');
    const prevBtn = document.getElementById('login-users-prev');
    const nextBtn = document.getElementById('login-users-next');
    if (!tbody) return;

    currentLoginUsersPage = Math.max(1, parseInt(page, 10) || 1);

    try {
        const res = await fetch(
            `/admin/user-sessions?page=${currentLoginUsersPage}&limit=${LOGIN_USERS_PAGE_SIZE}`,
            { credentials: 'include' }
        );
        const data = await res.json();
        const { sessions, total } = data;

        if (!sessions || sessions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="loading">ログインユーザーはいません</td></tr>';
        } else {
            tbody.innerHTML = sessions.map((s) => {
                const loginTime = new Date(s.login_time).toLocaleString('ja-JP');
                return `
                    <tr>
                        <td><button type="button" class="login-user-name-link" data-username="${escapeHtml(s.username).replace(/"/g, '&quot;')}">${escapeHtml(s.username)}</button></td>
                        <td>${escapeHtml(loginTime)}</td>
                        <td>${escapeHtml(s.ip)}</td>
                        <td>${escapeHtml(s.browser)}</td>
                        <td>${escapeHtml(s.os)}</td>
                    </tr>
                `;
            }).join('');
        }

        const from = total === 0 ? 0 : (currentLoginUsersPage - 1) * LOGIN_USERS_PAGE_SIZE + 1;
        const to = Math.min(currentLoginUsersPage * LOGIN_USERS_PAGE_SIZE, total);
        infoEl.textContent = `全 ${total} 件中 ${from}–${to} 件目`;
        prevBtn.disabled = currentLoginUsersPage <= 1;
        nextBtn.disabled = to >= total;
    } catch (err) {
        console.error('Failed to load login users:', err);
        tbody.innerHTML = '<tr><td colspan="5" class="loading">エラー: 取得に失敗しました</td></tr>';
    }
}

/** ユーザー登録パネル: 取得した生徒・教師一覧のキャッシュ（検索フィルタ用） */
let cachedStudentList = [];
let cachedTeacherList = [];

/** ユーザー一覧で現在表示している種別（'student' | 'teacher'） */
let currentUserListRole = 'student';

/** 一斉選択用: 選択中のユーザー "role:id" の Set */
let selectedUserIds = new Set();

/** 現在表示中の行の並び（Shift範囲選択用） */
let visibleUserList = [];

/** Shift+クリック用の最後にクリックした行インデックス */
let lastClickedRowIndex = null;

/**
 * 1件のユーザーを行のHTMLに変換する（先頭にチェック列を付与）
 */
function renderUserRow(u, role, rowIndex) {
    const created = u.created_at ? new Date(u.created_at).toLocaleDateString('ja-JP') : '-';
    const key = `${role}:${u.id}`;
    const checked = selectedUserIds.has(key) ? ' checked' : '';
    return `
        <tr data-role="${role}" data-id="${u.id}" data-row-index="${rowIndex}">
            <td class="td-checkbox"><input type="checkbox" class="user-row-cb" data-role="${role}" data-id="${u.id}" data-row-index="${rowIndex}"${checked}></td>
            <td>${u.id}</td>
            <td><span class="username">${escapeHtml(u.username)}</span></td>
            <td>${escapeHtml(u.display_name)}</td>
            <td>${created}</td>
            <td>
                <div class="action-buttons">
                    <button type="button" class="btn-edit" data-role="${role}" data-id="${u.id}" data-username="${escapeHtml(u.username)}" data-display-name="${escapeHtml(u.display_name)}">編集</button>
                    <button type="button" class="btn-delete" data-role="${role}" data-id="${u.id}">削除</button>
                </div>
            </td>
        </tr>
    `;
}

/**
 * 検索キーワードでユーザー配列をフィルタする（ログインID・表示名の部分一致）
 */
function filterUsersBySearch(users, searchTerm) {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return users;
    return users.filter((u) => {
        const un = (u.username || '').toLowerCase();
        const dn = (u.display_name || '').toLowerCase();
        return un.includes(term) || dn.includes(term);
    });
}

/**
 * 選択状態に合わせてチェックボックス・一斉選択・一斉削除バーの表示を更新する
 */
function updateUserSelectionUI() {
    const selectAll = document.getElementById('user-select-all');
    const bulkActions = document.getElementById('user-bulk-actions');
    const selectionCount = document.getElementById('user-selection-count');
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;

    const rowCbs = tbody.querySelectorAll('.user-row-cb');
    rowCbs.forEach((cb) => {
        const key = `${cb.getAttribute('data-role')}:${cb.getAttribute('data-id')}`;
        cb.checked = selectedUserIds.has(key);
    });

    if (selectAll) {
        const visibleKeys = visibleUserList.map((u) => `${u.role}:${u.id}`);
        const visibleSelected = visibleKeys.filter((k) => selectedUserIds.has(k)).length;
        selectAll.checked = visibleKeys.length > 0 && visibleSelected === visibleKeys.length;
        selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleKeys.length;
    }

    const total = selectedUserIds.size;
    if (bulkActions && selectionCount) {
        if (total > 0) {
            bulkActions.style.display = 'flex';
            selectionCount.textContent = `${total}件選択中`;
        } else {
            bulkActions.style.display = 'none';
        }
    }
}

/**
 * キャッシュと検索キーワードに基づき、現在選択中の種別のユーザー一覧テーブルを描画する
 */
function renderUserTables(searchTerm) {
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;

    const list = currentUserListRole === 'teacher' ? cachedTeacherList : cachedStudentList;
    const filtered = filterUsersBySearch(list, searchTerm);
    const label = currentUserListRole === 'teacher' ? '教師' : '生徒';

    visibleUserList = filtered.map((u) => ({ role: currentUserListRole, id: u.id }));

    if (filtered.length === 0) {
        const emptyMsg = list.length === 0 ? `${label}はいません` : `該当する${label}がいません`;
        tbody.innerHTML = '<tr><td colspan="6" class="loading">' + emptyMsg + '</td></tr>';
    } else {
        tbody.innerHTML = filtered.map((u, i) => renderUserRow(u, currentUserListRole, i)).join('');
    }
    updateUserSelectionUI();
}

/**
 * ユーザー登録パネル: 生徒・教師一覧の読み込み
 */
async function loadUsers() {
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;

    try {
        const [studentsRes, teachersRes] = await Promise.all([
            fetch('/admin/users/students', { credentials: 'include' }),
            fetch('/admin/users/teachers', { credentials: 'include' })
        ]);
        cachedStudentList = studentsRes.ok ? await studentsRes.json() : [];
        cachedTeacherList = teachersRes.ok ? await teachersRes.json() : [];

        const searchInput = document.getElementById('user-search');
        const searchTerm = searchInput ? searchInput.value : '';
        renderUserTables(searchTerm);
    } catch (error) {
        console.error('Failed to load users:', error);
        cachedStudentList = [];
        cachedTeacherList = [];
        tbody.innerHTML = '<tr><td colspan="6" class="loading">エラー: 取得に失敗しました</td></tr>';
    }
}

/**
 * CSV 1行をパースする（ダブルクォート囲み・エスケープ対応）
 */
function parseCSVLine(line) {
    const result = [];
    let i = 0;
    while (i < line.length) {
        if (line[i] === '"') {
            let end = i + 1;
            let s = '';
            while (end < line.length) {
                if (line[end] === '"') {
                    if (line[end + 1] === '"') {
                        s += '"';
                        end += 2;
                        continue;
                    }
                    break;
                }
                s += line[end];
                end++;
            }
            result.push(s);
            i = end + 1;
            if (line[i] === ',') i++;
        } else {
            let end = line.indexOf(',', i);
            if (end === -1) end = line.length;
            result.push(line.slice(i, end).trim());
            i = end + 1;
        }
    }
    return result;
}

/**
 * インポート用CSVテキストをパースし、{ role, username, password, display_name } の配列を返す
 */
function parseCSVForImport(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
    const roleIdx = header.indexOf('role');
    const userIdx = header.indexOf('username');
    const passIdx = header.indexOf('password');
    const dispIdx = header.indexOf('display_name');
    if (roleIdx === -1 || userIdx === -1 || passIdx === -1) return [];
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const arr = parseCSVLine(lines[i]);
        const role = (arr[roleIdx] || '').trim().toLowerCase();
        const username = (arr[userIdx] || '').trim();
        const password = (arr[passIdx] || '').trim();
        const displayName = dispIdx >= 0 ? (arr[dispIdx] || '').trim() : '';
        if (username && password && (role === 'student' || role === 'teacher')) {
            rows.push({ role, username, password, displayName });
        }
    }
    return rows;
}

/**
 * CSVフィールドをエスケープ（改行・カンマ・ダブルクォートを含む場合は囲む）
 */
function escapeCSVField(str) {
    const s = String(str ?? '');
    if (/[\r\n,"]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

/**
 * CSV一斉追加: ファイルを読み取りパースし、1件ずつAPIで登録する
 */
async function handleCsvImport(fileInput, statusEl, btnEl) {
    const file = fileInput.files?.[0];
    if (!file) {
        statusEl.textContent = 'ファイルを選択してください';
        statusEl.className = 'status-text error';
        return;
    }
    btnEl.disabled = true;
    statusEl.textContent = '読み込み中...';
    statusEl.className = 'status-text';
    let text;
    try {
        text = await file.text();
    } catch (e) {
        statusEl.textContent = 'ファイルの読み込みに失敗しました';
        statusEl.className = 'status-text error';
        btnEl.disabled = false;
        return;
    }
    const rows = parseCSVForImport(text);
    if (rows.length === 0) {
        statusEl.textContent = '有効な行がありません。形式: role,username,password,display_name（1行目ヘッダー、roleはstudent/teacher）';
        statusEl.className = 'status-text error';
        btnEl.disabled = false;
        return;
    }
    statusEl.textContent = `登録中 (0/${rows.length})...`;
    let ok = 0;
    let ng = 0;
    let firstError = '';
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const url = r.role === 'teacher' ? '/admin/users/teacher' : '/admin/users/student';
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    username: r.username,
                    password: r.password,
                    displayName: r.displayName || undefined
                })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                ok++;
            } else {
                ng++;
                if (!firstError) firstError = data.error === 'username_exists' ? `${r.username}: 既に登録済み` : (data.error || '登録失敗');
            }
        } catch (err) {
            ng++;
            if (!firstError) firstError = '通信エラー';
        }
        statusEl.textContent = `登録中 (${i + 1}/${rows.length})...`;
    }
    if (ng === 0) {
        statusEl.textContent = `${ok}件を登録しました`;
        statusEl.className = 'status-text success';
        fileInput.value = '';
        document.getElementById('user-csv-filename').textContent = '';
        btnEl.disabled = true;
        loadUsers();
    } else {
        statusEl.textContent = `完了: 成功 ${ok}件、失敗 ${ng}件${firstError ? '（例: ' + firstError + '）' : ''}`;
        statusEl.className = 'status-text error';
        loadUsers();
    }
    btnEl.disabled = false;
    if (statusEl.className.includes('success')) {
        setTimeout(() => { statusEl.textContent = ''; }, 4000);
    }
}

/**
 * 既存ユーザー一覧をCSVでダウンロードする
 */
async function handleCsvExport() {
    const btn = document.getElementById('btn-export-csv');
    if (btn) btn.disabled = true;
    try {
        const [studentsRes, teachersRes] = await Promise.all([
            fetch('/admin/users/students', { credentials: 'include' }),
            fetch('/admin/users/teachers', { credentials: 'include' })
        ]);
        const students = studentsRes.ok ? await studentsRes.json() : [];
        const teachers = teachersRes.ok ? await teachersRes.json() : [];
        const header = ['role', 'id', 'username', 'display_name', 'created_at'];
        const lines = [header.map(escapeCSVField).join(',')];
        for (const u of students) {
            lines.push(['student', u.id, u.username, u.display_name, u.created_at ?? ''].map(escapeCSVField).join(','));
        }
        for (const u of teachers) {
            lines.push(['teacher', u.id, u.username, u.display_name, u.created_at ?? ''].map(escapeCSVField).join(','));
        }
        const csv = lines.join('\r\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `users_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (err) {
        console.error('CSV export failed:', err);
        const statusEl = document.getElementById('user-csv-import-status');
        if (statusEl) {
            statusEl.textContent = 'エクスポートに失敗しました';
            statusEl.className = 'status-text error';
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * ユーザー登録パネル: 新規登録・編集モーダル・削除のイベント設定
 */
function setupUserRegisterPanel() {
    const searchInput = document.getElementById('user-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            renderUserTables(searchInput.value);
        });
    }

    /** 画面全体の種別を切り替え（左パネル・ユーザー一覧を同期） */
    function applyUserRegisterRole(role) {
        if (role !== 'student' && role !== 'teacher') return;
        currentUserListRole = role;
        document.querySelectorAll('.ur-category-btn').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-ur-category') === role);
        });
        const term = searchInput ? searchInput.value : '';
        renderUserTables(term);
    }

    document.querySelectorAll('.ur-category-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const category = btn.getAttribute('data-ur-category');
            applyUserRegisterRole(category);
        });
    });

    const btnAdd = document.getElementById('btn-add-user');
    const statusAdd = document.getElementById('user-add-status');
    const modal = document.getElementById('user-edit-modal');
    const editId = document.getElementById('user-edit-id');
    const editRole = document.getElementById('user-edit-role');
    const editUsername = document.getElementById('user-edit-username');
    const editDisplayName = document.getElementById('user-edit-display-name');
    const editPassword = document.getElementById('user-edit-password');
    const editStatus = document.getElementById('user-edit-status');
    const editSaveBtn = document.getElementById('user-edit-save-btn');
    const editCancelBtn = document.getElementById('user-edit-cancel-btn');

    if (btnAdd) {
        btnAdd.addEventListener('click', async () => {
            const role = currentUserListRole;
            const username = document.getElementById('new-username').value.trim();
            const password = document.getElementById('new-password').value;
            const displayName = document.getElementById('new-display-name').value.trim();

            if (!username || !password) {
                statusAdd.textContent = 'ログインIDとパスワードを入力してください';
                statusAdd.className = 'status-text error';
                return;
            }

            btnAdd.disabled = true;
            statusAdd.textContent = '登録中...';
            statusAdd.className = 'status-text';

            try {
                const url = role === 'teacher' ? '/admin/users/teacher' : '/admin/users/student';
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ username, password, displayName: displayName || undefined })
                });
                const data = await res.json();

                if (res.ok && data.success) {
                    statusAdd.textContent = '登録しました';
                    statusAdd.className = 'status-text success';
                    document.getElementById('new-username').value = '';
                    document.getElementById('new-password').value = '';
                    document.getElementById('new-display-name').value = '';
                    loadUsers();
                } else {
                    statusAdd.textContent = data.error === 'username_exists' ? 'このログインIDは既に使われています' : (data.error || '登録に失敗しました');
                    statusAdd.className = 'status-text error';
                }
            } catch (err) {
                statusAdd.textContent = '通信エラー';
                statusAdd.className = 'status-text error';
            } finally {
                btnAdd.disabled = false;
                if (statusAdd.textContent && statusAdd.className.includes('success')) {
                    setTimeout(() => { statusAdd.textContent = ''; }, 3000);
                }
            }
        });
    }

    if (modal) {
        editCancelBtn?.addEventListener('click', () => {
            modal.classList.remove('show');
            editPassword.value = '';
            editStatus.textContent = '';
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('show');
                editPassword.value = '';
            }
        });

        editSaveBtn?.addEventListener('click', async () => {
            const id = editId.value;
            const role = editRole.value;
            const username = editUsername.value.trim();
            const displayName = editDisplayName.value.trim();
            const password = editPassword.value;

            if (!username) {
                editStatus.textContent = 'ログインIDを入力してください';
                editStatus.className = 'status-text error';
                return;
            }

            editSaveBtn.disabled = true;
            editStatus.textContent = '保存中...';
            editStatus.className = 'status-text';

            try {
                const url = role === 'teacher' ? `/admin/users/teacher/${id}` : `/admin/users/student/${id}`;
                const body = { username, displayName: displayName || username };
                if (password) body.password = password;

                const res = await fetch(url, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(body)
                });
                const data = await res.json();

                if (res.ok && data.success) {
                    editStatus.textContent = '保存しました';
                    editStatus.className = 'status-text success';
                    loadUsers();
                    setTimeout(() => {
                        modal.classList.remove('show');
                        editPassword.value = '';
                        editStatus.textContent = '';
                    }, 800);
                } else {
                    editStatus.textContent = data.error === 'username_exists' ? 'このログインIDは既に使われています' : (data.error || '保存に失敗しました');
                    editStatus.className = 'status-text error';
                }
            } catch (err) {
                editStatus.textContent = '通信エラー';
                editStatus.className = 'status-text error';
            } finally {
                editSaveBtn.disabled = false;
            }
        });
    }

    // CSV一斉追加: ファイル選択
    const csvFileInput = document.getElementById('user-csv-file');
    const btnChooseCsv = document.getElementById('btn-choose-csv');
    const csvFilenameSpan = document.getElementById('user-csv-filename');
    const btnImportCsv = document.getElementById('btn-import-csv');
    const csvImportStatus = document.getElementById('user-csv-import-status');
    if (btnChooseCsv && csvFileInput) {
        btnChooseCsv.addEventListener('click', () => csvFileInput.click());
        csvFileInput.addEventListener('change', () => {
            const file = csvFileInput.files?.[0];
            if (file) {
                csvFilenameSpan.textContent = file.name;
                btnImportCsv.disabled = false;
            } else {
                csvFilenameSpan.textContent = '';
                btnImportCsv.disabled = true;
            }
        });
    }
    if (btnImportCsv && csvFileInput) {
        btnImportCsv.addEventListener('click', () => handleCsvImport(csvFileInput, csvImportStatus, btnImportCsv));
    }
    const btnExportCsv = document.getElementById('btn-export-csv');
    if (btnExportCsv) {
        btnExportCsv.addEventListener('click', handleCsvExport);
    }

    // 一斉選択チェックボックス
    const selectAllEl = document.getElementById('user-select-all');
    if (selectAllEl) {
        selectAllEl.addEventListener('change', () => {
            const visibleKeys = visibleUserList.map((u) => `${u.role}:${u.id}`);
            if (selectAllEl.checked) {
                visibleKeys.forEach((k) => selectedUserIds.add(k));
            } else {
                visibleKeys.forEach((k) => selectedUserIds.delete(k));
            }
            lastClickedRowIndex = null;
            updateUserSelectionUI();
        });
    }

    // 行チェック: クリックでトグル、Shift+クリックで範囲選択
    document.getElementById('panel-user-register')?.addEventListener('click', (e) => {
        const rowCb = e.target.closest('.user-row-cb');
        if (rowCb) {
            e.preventDefault();
            const role = rowCb.getAttribute('data-role');
            const id = rowCb.getAttribute('data-id');
            const key = `${role}:${id}`;
            const rowIndex = parseInt(rowCb.getAttribute('data-row-index'), 10);

            if (e.shiftKey && lastClickedRowIndex !== null) {
                const from = Math.min(lastClickedRowIndex, rowIndex);
                const to = Math.max(lastClickedRowIndex, rowIndex);
                for (let i = from; i <= to; i++) {
                    const u = visibleUserList[i];
                    if (u) selectedUserIds.add(`${u.role}:${u.id}`);
                }
            } else {
                if (selectedUserIds.has(key)) {
                    selectedUserIds.delete(key);
                } else {
                    selectedUserIds.add(key);
                }
            }
            lastClickedRowIndex = rowIndex;
            updateUserSelectionUI();
            return;
        }

        const btn = e.target.closest('.btn-edit');
        const delBtn = e.target.closest('.btn-delete');
        if (btn) {
            const role = btn.getAttribute('data-role');
            const id = btn.getAttribute('data-id');
            const username = btn.getAttribute('data-username') || '';
            const displayName = btn.getAttribute('data-display-name') || '';
            editId.value = id;
            editRole.value = role;
            editUsername.value = username;
            editDisplayName.value = displayName;
            editPassword.value = '';
            editStatus.textContent = '';
            document.getElementById('user-edit-modal-title').textContent = (role === 'teacher' ? '教師' : '生徒') + 'の編集';
            modal.classList.add('show');
        } else if (delBtn) {
            const role = delBtn.getAttribute('data-role');
            const id = delBtn.getAttribute('data-id');
            const label = role === 'teacher' ? '教師' : '生徒';
            if (!confirm(`この${label}を削除してもよろしいですか？`)) return;
            (async () => {
                try {
                    const url = role === 'teacher' ? `/admin/users/teacher/${id}` : `/admin/users/student/${id}`;
                    const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
                    if (res.ok) loadUsers();
                    else alert('削除に失敗しました');
                } catch (err) {
                    alert('通信エラー');
                }
            })();
        }
    });

    // 選択したユーザーを一斉削除
    const btnBulkDelete = document.getElementById('btn-bulk-delete-users');
    if (btnBulkDelete) {
        btnBulkDelete.addEventListener('click', async () => {
            const n = selectedUserIds.size;
            if (n === 0) return;
            if (!confirm(`選択した${n}件のユーザーを削除してもよろしいですか？`)) return;
            btnBulkDelete.disabled = true;
            const toDelete = [...selectedUserIds];
            let ok = 0;
            let ng = 0;
            for (const key of toDelete) {
                const [role, id] = key.split(':');
                try {
                    const url = role === 'teacher' ? `/admin/users/teacher/${id}` : `/admin/users/student/${id}`;
                    const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
                    if (res.ok) {
                        ok++;
                        selectedUserIds.delete(key);
                    } else {
                        ng++;
                    }
                } catch (err) {
                    ng++;
                }
            }
            btnBulkDelete.disabled = false;
            loadUsers();
            updateUserSelectionUI();
            if (ng > 0) alert(`${ok}件削除しました。${ng}件は削除に失敗しました。`);
        });
    }
}

async function updateRoomFilter() {
    try {
        const response = await fetch('/admin/stats', { credentials: 'include' });
        const data = await response.json();
        
        // Get unique rooms from players
        const playersResponse = await fetch('/admin/players', { credentials: 'include' });
        const players = await playersResponse.json();
        const rooms = [...new Set(players.map(p => p.room))].sort();
        
        const filterSelect = document.getElementById('room-filter');
        const currentValue = filterSelect.value;
        
        // Clear existing options except "全ルーム"
        filterSelect.innerHTML = '<option value="">全ルーム</option>';
        
        // Add room options
        rooms.forEach(room => {
            const option = document.createElement('option');
            option.value = room;
            option.textContent = room;
            filterSelect.appendChild(option);
        });
        
        // Restore previous selection
        if (currentValue) {
            filterSelect.value = currentValue;
        }
    } catch (error) {
        console.error('Failed to update room filter:', error);
    }
}

async function loadLogs() {
    try {
        const response = await fetch('/admin/logs?limit=100', { credentials: 'include' });
        const logs = await response.json();
        
        const container = document.getElementById('logs-container');
        
        if (logs.length === 0) {
            container.innerHTML = '<div class="loading">ログなし</div>';
            return;
        }
        
        container.innerHTML = logs.map(log => {
            const timestamp = new Date(log.timestamp).toLocaleTimeString('ja-JP');
            return `
                <div class="log-entry ${log.level}">
                    <span class="log-timestamp">[${timestamp}]</span>
                    <span>${escapeHtml(log.message)}</span>
                </div>
            `;
        }).join('');
        
        const scrollEl = container.closest('.server-console-scroll');
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    } catch (error) {
        console.error('Failed to load logs:', error);
        document.getElementById('logs-container').innerHTML = 
            '<div class="loading">エラー: ログの取得に失敗しました</div>';
    }
}

function kickPlayer(socketId) {
    if (!confirm(`プレイヤー ${socketId} をキックしますか？`)) {
        return;
    }
    
    fetch('/admin/kick', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ socketId })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('プレイヤーをキックしました');
            loadPlayers();
        } else {
            alert('エラー: ' + (data.error || 'キックに失敗しました'));
        }
    })
    .catch(error => {
        console.error('Kick error:', error);
        alert('エラー: キックに失敗しました');
    });
}

function muteMic(socketId) {
    if (!confirm('このプレイヤーのマイクを強制ミュートしますか？')) {
        return;
    }
    
    fetch('/admin/mute-mic', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ socketId })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('マイクを強制ミュートしました');
            loadPlayers();
        } else {
            alert('エラー: ' + (data.error || 'ミュートに失敗しました'));
        }
    })
    .catch(error => {
        console.error('Mute error:', error);
        alert('エラー: ミュートに失敗しました');
    });
}

function showAlertModal(socketId) {
    currentAlertTarget = socketId;
    document.getElementById('alert-modal').classList.add('show');
    document.getElementById('alert-message').value = '';
    document.getElementById('alert-message').focus();
}

function setupAlertModal() {
    const modal = document.getElementById('alert-modal');
    const sendBtn = document.getElementById('alert-send-btn');
    const cancelBtn = document.getElementById('alert-cancel-btn');
    const messageInput = document.getElementById('alert-message');
    
    sendBtn.addEventListener('click', () => {
        const message = messageInput.value.trim();
        if (!message) {
            alert('メッセージを入力してください');
            return;
        }
        
        sendAlert(currentAlertTarget, message);
        modal.classList.remove('show');
        currentAlertTarget = null;
    });
    
    cancelBtn.addEventListener('click', () => {
        modal.classList.remove('show');
        currentAlertTarget = null;
    });
    
    // Close on background click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('show');
            currentAlertTarget = null;
        }
    });
    
    // Enter key to send
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendBtn.click();
        }
    });
}

function sendAlert(socketId, message) {
    fetch('/admin/send-alert', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ socketId, message })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('メッセージを送信しました');
        } else {
            alert('エラー: ' + (data.error || '送信に失敗しました'));
        }
    })
    .catch(error => {
        console.error('Send alert error:', error);
        alert('エラー: 送信に失敗しました');
    });
}

function formatDuration(seconds) {
    if (seconds < 60) {
        return `${seconds}秒`;
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${minutes}分${secs}秒`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}時間${minutes}分`;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * JSONをダウンロードする（UTF-8）
 */
function downloadJson(filename, data) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

/**
 * 譜面（全件/選択中）をJSONでエクスポートする
 */
async function exportChartsJson() {
    const statusEl = document.getElementById('chart-status');
    const btn = document.getElementById('btn-export-charts-json');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/admin/charts', { credentials: 'include' });
        if (!res.ok) throw new Error(res.statusText);
        const charts = await res.json();
        const payload = {
            exportedAt: new Date().toISOString(),
            selectedChartId: selectedChartId || null,
            charts,
        };
        const safeId = (selectedChartId && /^[a-zA-Z0-9_-]+$/.test(selectedChartId)) ? selectedChartId : 'all';
        downloadJson(`charts_${safeId}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, payload);
        if (statusEl) statusEl.textContent = 'JSONをエクスポートしました';
    } catch (err) {
        if (statusEl) statusEl.textContent = 'エクスポート失敗: ' + err.message;
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * インポートJSONのルートから譜面オブジェクトの配列を取り出す（エクスポート形式・charts.json形式・配列を許容）
 * @param {unknown} root
 * @returns {Array<Record<string, unknown>>}
 */
function extractChartsFromImportJson(root) {
    if (Array.isArray(root)) {
        return root.filter((v) => isChartLikeForImport(v));
    }
    if (!root || typeof root !== 'object') return [];
    const o = /** @type {Record<string, unknown>} */ (root);
    if (o.charts != null && typeof o.charts === 'object') {
        if (Array.isArray(o.charts)) {
            return o.charts.filter((v) => isChartLikeForImport(v));
        }
        return Object.values(o.charts).filter((v) => isChartLikeForImport(v));
    }
    const skip = new Set(['exportedAt', 'selectedChartId']);
    const out = [];
    for (const [k, v] of Object.entries(o)) {
        if (skip.has(k)) continue;
        if (isChartLikeForImport(v)) out.push(/** @type {Record<string, unknown>} */ (v));
    }
    return out;
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isChartLikeForImport(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v)
        && typeof /** @type {{ id?: unknown }} */ (v).id === 'string';
}

/**
 * 譜面IDをPOST用に正規化（不正ならタイムスタンプベース）
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeImportChartId(raw) {
    const s = String(raw ?? '').trim();
    if (/^[a-zA-Z0-9_-]+$/.test(s) && s.length > 0) return s;
    return 'chart_' + Date.now();
}

/**
 * 既存IDと重複しない譜面IDを割り当てる
 * @param {string} baseId
 * @param {Set<string>} used
 * @returns {string}
 */
function allocateUniqueChartIdForImport(baseId, used) {
    let id = sanitizeImportChartId(baseId);
    if (!used.has(id)) {
        used.add(id);
        return id;
    }
    let n = 1;
    while (used.has(`${id}_${n}`)) n += 1;
    const out = `${id}_${n}`;
    used.add(out);
    return out;
}

/**
 * JSONテキストを解析し譜面をサーバーに新規作成する
 * @param {string} jsonText
 * @param {HTMLElement | null} statusEl
 * @returns {Promise<{ imported: number, failed: number, lastId: string | null, message: string }>}
 */
async function importChartsFromJsonText(jsonText, statusEl) {
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        const msg = 'JSONの解析に失敗しました';
        if (statusEl) statusEl.textContent = msg;
        return { imported: 0, failed: 0, lastId: null, message: msg };
    }
    const list = extractChartsFromImportJson(parsed);
    if (list.length === 0) {
        const msg = '譜面データが見つかりません（形式を確認してください）';
        if (statusEl) statusEl.textContent = msg;
        return { imported: 0, failed: 0, lastId: null, message: msg };
    }
    const resList = await fetch('/admin/charts', { credentials: 'include' });
    const existing = resList.ok ? await resList.json().catch(() => ({})) : {};
    const used = new Set(Object.keys(existing && typeof existing === 'object' ? existing : {}));
    let imported = 0;
    let failed = 0;
    /** @type {string | null} */
    let lastId = null;
    const errors = [];
    for (const chart of list) {
        const srcId = String(chart.id ?? '').trim() || 'chart';
        const newId = allocateUniqueChartIdForImport(srcId, used);
        const name = typeof chart.name === 'string' && chart.name.trim() ? chart.name.trim() : newId;
        const notes = Array.isArray(chart.notes) ? chart.notes : [];
        const difficulty = chart.difficulty != null ? chart.difficulty : null;
        const tempo = chart.tempo != null && Number.isFinite(Number(chart.tempo)) ? Number(chart.tempo) : null;
        const endTime = chart.endTime != null && chart.endTime !== '' && Number.isFinite(Number(chart.endTime))
            ? Number(chart.endTime)
            : null;
        const measureBpms = chart.measureBpms != null ? chart.measureBpms : null;
        try {
            const res = await fetch('/admin/charts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    id: newId,
                    name,
                    notes,
                    notes2: Array.isArray(chart.notes2) ? chart.notes2 : [],
                    notes3: Array.isArray(chart.notes3) ? chart.notes3 : [],
                    difficulty,
                    tempo,
                    endTime,
                    measureBpms,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                failed += 1;
                errors.push(`${newId}: ${data.error || res.statusText}`);
                used.delete(newId);
                continue;
            }
            imported += 1;
            lastId = newId;
        } catch (err) {
            failed += 1;
            errors.push(`${newId}: ${err instanceof Error ? err.message : String(err)}`);
            used.delete(newId);
        }
    }
    /** @type {string} */
    let message = '';
    if (imported > 0 && failed === 0) {
        message = `インポート完了（${imported}件）`;
    } else if (imported > 0) {
        message = `インポート: 成功${imported}件、失敗${failed}件` + (errors[0] ? ` — ${errors[0]}` : '');
    } else {
        message = failed > 0 ? `インポート失敗（${errors[0] || '不明なエラー'}）` : 'インポートできませんでした';
    }
    if (statusEl) statusEl.textContent = message;
    return { imported, failed, lastId, message };
}

/** 利用可能なコマンド名（Tab補完用）。 */
const COMMAND_NAMES = ['ban', 'help', 'list', 'tell', 'tp'];

/** コマンド名補完の候補を返す。prefix に一致するコマンドを返す（空なら全件）。 */
function getCommandCompletions(prefix) {
    const pre = prefix.toLowerCase();
    return COMMAND_NAMES.filter((name) => name.startsWith(pre));
}

/** ワールドID補完の候補を返す。prefix に一致するワールドIDを返す。 */
function getWorldCompletions(prefix) {
    const pre = prefix.toLowerCase();
    return cachedWorldIdsForCompletion.filter((id) => id.toLowerCase().startsWith(pre));
}

/** セレクター補完の候補を返す。prefix は @ の後ろの文字列（小文字で渡す）。返却は @ 付きの文字列の配列。 */
function getSelectorCompletions(prefix) {
    const options = [];
    const pre = prefix.toLowerCase();
    if (pre === '' || 'a'.startsWith(pre)) {
        options.push('@a');
    }
    const usernames = [...new Set(cachedPlayersForCompletion.map((p) => p.username))].sort((a, b) => a.localeCompare(b));
    const maxNoPrefix = 4;
    const maxWithPrefix = 8;
    const max = pre === '' ? maxNoPrefix : maxWithPrefix;

    for (const name of usernames) {
        if (options.length >= max) break;
        if (pre === '' || name.toLowerCase().startsWith(pre)) {
            options.push('@' + name);
        }
    }
    if (pre !== '') {
        for (const p of cachedPlayersForCompletion) {
            if (options.length >= max) break;
            if (p.socketId.startsWith(prefix) && !options.includes('@' + p.socketId)) {
                options.push('@' + p.socketId);
            }
        }
    }
    return options.slice(0, max);
}

/** 入力欄でカーソルを含む単語の範囲とトークン位置を返す。 */
function getCurrentSelectorWord(input) {
    const value = input.value || '';
    const pos = input.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    const wordStart = before.lastIndexOf(' ') + 1;
    const word = value.slice(wordStart, pos);
    const parts = before.split(/\s+/);
    const tokenIndex = Math.max(0, parts.length - 1);
    const commandName = (parts[0] || '').toLowerCase();
    return { word, wordStart, wordEnd: pos, tokenIndex, commandName };
}

/** コマンド入力のセレクター補完（@ + Tab/Space）を初期化する。 */
function setupCommandCompletion() {
    const input = document.getElementById('command-input');
    const dropdown = document.getElementById('command-completion-dropdown');
    let completionOptions = [];
    let selectedIndex = 0;

    function hideDropdown() {
        dropdown.setAttribute('aria-hidden', 'true');
        dropdown.innerHTML = '';
        completionOptions = [];
    }

    function showDropdown(options) {
        completionOptions = options;
        selectedIndex = 0;
        dropdown.innerHTML = options.map((opt, i) => {
            const escaped = escapeHtml(opt);
            const sel = i === 0 ? ' selected' : '';
            return `<div class="command-completion-item${sel}" role="option">${escaped}</div>`;
        }).join('');
        dropdown.setAttribute('aria-hidden', 'false');
    }

    function updateSelection(newIndex) {
        const items = dropdown.querySelectorAll('.command-completion-item');
        if (items.length === 0) return;
        selectedIndex = ((newIndex % items.length) + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
    }

    function confirmSelection() {
        if (completionOptions.length === 0) return;
        const sel = completionOptions[selectedIndex];
        const { wordStart, wordEnd } = getCurrentSelectorWord(input);
        const before = input.value.slice(0, wordStart);
        const after = input.value.slice(wordEnd);
        const newValue = before + sel + ' ' + after;
        input.value = newValue;
        input.selectionStart = input.selectionEnd = wordStart + sel.length + 1;
        hideDropdown();
    }

    function updateCompletionFromInput() {
        const { word, wordStart, tokenIndex, commandName } = getCurrentSelectorWord(input);
        if (tokenIndex === 0) {
            const options = getCommandCompletions(word);
            if (options.length > 0) {
                showDropdown(options);
                return;
            }
        }
        if (tokenIndex === 1 && word.startsWith('@')) {
            const prefix = word.slice(1);
            const options = getSelectorCompletions(prefix);
            if (options.length > 0) {
                showDropdown(options);
                return;
            }
        }
        if (tokenIndex === 2 && commandName === 'tp') {
            const options = getWorldCompletions(word);
            if (options.length > 0) {
                showDropdown(options);
                return;
            }
        }
        hideDropdown();
    }

    input.addEventListener('focus', () => {
        updateCompletionFromInput();
    });

    input.addEventListener('blur', () => {
        hideDropdown();
    });

    input.addEventListener('input', () => {
        updateCompletionFromInput();
    });

    input.addEventListener('keydown', (e) => {
        const visible = dropdown.getAttribute('aria-hidden') !== 'true' && completionOptions.length > 0;

        if (visible) {
            if (e.key === 'Tab') {
                e.preventDefault();
                updateSelection(selectedIndex + 1);
                return;
            }
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                confirmSelection();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideDropdown();
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                updateSelection(selectedIndex + 1);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                updateSelection(selectedIndex - 1);
                return;
            }
        }

        if (e.key === 'Enter') {
            executeCommand();
        }
    });
}

function appendCommandOutput(text, isError = false) {
    const output = document.getElementById('command-output');
    const line = document.createElement('div');
    line.className = isError ? 'command-output-line error' : 'command-output-line';
    line.textContent = text;
    output.appendChild(line);
    const scrollEl = output.closest('.server-console-scroll');
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
}

async function executeCommand() {
    const input = document.getElementById('command-input');
    const raw = (input.value || '').trim();
    if (!raw) return;
    input.value = '';
    try {
        const res = await fetch('/admin/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: raw }),
            credentials: 'include'
        });
        const data = await res.json();
        loadLogs();
    } catch (e) {
        loadLogs();
    }
}
