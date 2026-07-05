/**
 * サーバー側で生成した WAV を優先し、なければ MP3（chart-bgm-fetch.js と同じロジック）
 * @param {string} basePath 拡張子なし
 * @param {string|number} version
 * @returns {Promise<ArrayBuffer>}
 */
async function chartBgmFetchArrayBuffer(basePath, version) {
    const v = encodeURIComponent(String(version));
    const tryExt = async (ext) => {
        const res = await fetch(`${basePath}${ext}?v=${v}`, { credentials: 'same-origin' });
        if (!res.ok) return null;
        return res.arrayBuffer();
    };
    const wav = await tryExt('.wav');
    if (wav) return wav;
    const mp3 = await tryExt('.mp3');
    if (mp3) return mp3;
    throw new Error('BGMの取得に失敗しました');
}

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
let aircraftAdminInitialized = false;
let databaseAdminInitialized = false;
let chartPanelInitialized = false;
let securityPanelInitialized = false;
/** アバター管理: GET /admin/avatars のキャッシュ（パネル内 UI 用） */
let adminAvatarRegistryCache = null;
/** アバター管理: フォーム編集中のエントリ ID */
let adminAvatarEditId = null;
/** GET /admin/avatars の scalableAnimationSlots（avator-scalable-animations） */
let adminAvatarScalableSlots = [];
/** サーバー ENABLE_CHART_FEATURES（/api/client-config および /admin/stats で更新） */
let adminChartFeaturesEnabled = true;
/** 譜面作成パネルで選択中の譜面ID */
let selectedChartId = null;
/** 「保存」済みとみなす譜面 PUT ペイロードの JSON 文字列（未選択・エディタクリア時は ''） */
let chartEditorSavedPayloadJson = '';
/** 譜面一覧のキャッシュ（renderChartList/selectChart で参照） */
let cachedCharts = {};
/** loadCharts 同時実行時、古い完了でオーバーレイを閉じないための世代 */
let chartListLoadGen = 0;
/** selectChart 連打時の同様の世代 */
let chartSelectLoadGen = 0;
/** 編集中のノーツ配列（don/ka: volume、連打は開始チップ roll-start に volume）。譜面編集エリアと同期 */
let editingNotes = [];
/** 譜面エディタ: ノーツ音量ドラッグ中の pointerId。-1 はなし */
let chartVolumeDragPointerId = -1;
/** ドン・カノーツの音量倍率（1.0=100%、0.1〜3.0） */
const NOTE_VOLUME_MIN = 0.1;
const NOTE_VOLUME_MAX = 3;
/** 縦移動がこの px を超えたら音量ドラッグとみなす（クリック選択と区別） */
const CHART_NOTE_VOLUME_DRAG_THRESHOLD_PX = 4;
/** Shift＋連打音量ドラッグ時、周囲の don/ka を引き寄せる距離（16分音符ステップ数） */
const CHART_ROLL_NEIGHBOR_PULL_RADIUS_STEPS = 12;
/** 連打「間」マスの音量を離散調整する際の1段階（五線上の1マス相当） */
const CHART_ROLL_CELL_VOLUME_QUANT_STEP = (NOTE_VOLUME_MAX - NOTE_VOLUME_MIN) / 16;
/** Shift 時、ドラッグ中の間マスから左右に引き寄せる連打間マス数（各側） */
const CHART_ROLL_MIDDLE_NEIGHBOR_RADIUS_STEPS = 2;
/** Shift＋連打「間」ガウス風ブレンドの σ（16分ステップ距離）。大きいほど遠くまで寄る */
const CHART_ROLL_MIDDLE_GAUSS_SIGMA_STEPS = 0.9;

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
 * エディタ表示・保存用の音量（don/ka/連打開始。既定 1）
 * @param {{ type?: string, volume?: unknown } | null | undefined} note
 * @returns {number}
 */
function getNoteVolumeForEditor(note) {
    if (!note || (note.type !== 'don' && note.type !== 'ka' && note.type !== 'roll-start' && note.type !== 'roll')) return 1;
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
 * 編集グリッド上の絶対ステップ（小節×16+ステップ）を返す
 * @param {number} timeSec
 * @param {number} bpm
 * @returns {number}
 */
function chartEditorAbsStepFromTime(timeSec, bpm) {
    const { barIndex, stepIndex } = timeToBarStep(timeSec, bpm);
    return barIndex * 16 + stepIndex;
}

/**
 * Shift＋連打音量調整時、近傍の don/ka の音量を連打音量へ重み付きで寄せる
 * @param {number} vRoll
 * @param {{ start: number, end: number }} section
 * @param {number} bpm
 */
function applyNeighborVolumePullTowardRoll(vRoll, section, bpm) {
    const s = Number(section.start);
    const e = Number(section.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return;
    const sAbs = chartEditorAbsStepFromTime(s, bpm);
    const eAbs = chartEditorAbsStepFromTime(e, bpm);
    const grid = document.getElementById('chart-measures-grid');
    const r = Math.max(1, CHART_ROLL_NEIGHBOR_PULL_RADIUS_STEPS);
    for (let i = 0; i < editingNotes.length; i++) {
        const n = editingNotes[i];
        if (!n || (n.type !== 'don' && n.type !== 'ka')) continue;
        const t = Number(n.time ?? 0);
        if (!Number.isFinite(t)) continue;
        if (isTimeInRollSection(t)) continue;
        const nAbs = chartEditorAbsStepFromTime(t, bpm);
        let dist;
        if (nAbs < sAbs) dist = sAbs - nAbs;
        else if (nAbs > eAbs) dist = nAbs - eAbs;
        else continue;
        const w = Math.max(0, 1 - dist / r);
        if (w <= 0) continue;
        const oldV = getNoteVolumeForEditor(n);
        n.volume = clampNoteVolume(oldV + w * (vRoll - oldV));
        if (grid) {
            const el = grid.querySelector(`.note-chip[data-index="${i}"]`);
            if (el) el.style.height = `${Math.max(4, 16 * n.volume)}px`;
        }
    }
}

/**
 * 音量を連打セル用の離散ステップへ丸める（1マス分相当）
 * @param {number} v
 * @returns {number}
 */
function quantizeRollCellVolumeStep(v) {
    const step = Math.max(1e-6, CHART_ROLL_CELL_VOLUME_QUANT_STEP);
    const q = Math.round((v - NOTE_VOLUME_MIN) / step) * step + NOTE_VOLUME_MIN;
    return clampNoteVolume(q);
}

/**
 * 連打区間内のセル (barIndex,stepIndex) が開始・終了・中間のいずれか
 * @returns {'start'|'end'|'middle'|'out'}
 */
function rollBarCellKind(barIndex, stepIndex, sec, bpm) {
    const a = barIndex * 16 + stepIndex;
    const sa = chartEditorAbsStepFromTime(sec.start, bpm);
    const ea = chartEditorAbsStepFromTime(sec.end, bpm);
    if (a < sa || a > ea) return 'out';
    if (a === sa) return 'start';
    if (a === ea) return 'end';
    return 'middle';
}

/**
 * 連打「間」かつ中心セルから±radiusSteps 以内のセルキー（開始・終了マスは含めない）
 * @param {{ start: number, end: number }} sec
 * @param {number} bpm
 * @param {number} centerBi
 * @param {number} centerSi
 * @param {number} [radiusSteps=2]
 * @returns {string[]}
 */
function getRollMiddleNeighborKeysAround(sec, bpm, centerBi, centerSi, radiusSteps = CHART_ROLL_MIDDLE_NEIGHBOR_RADIUS_STEPS) {
    const sa = chartEditorAbsStepFromTime(sec.start, bpm);
    const ea = chartEditorAbsStepFromTime(sec.end, bpm);
    const curAbs = centerBi * 16 + centerSi;
    const r = Math.max(0, Number(radiusSteps) || 0);
    /** @type {string[]} */
    const keys = [];
    for (let d = -r; d <= r; d++) {
        const a = curAbs + d;
        if (a <= sa || a >= ea) continue;
        keys.push(`${Math.floor(a / 16)}:${a % 16}`);
    }
    return keys;
}

/**
 * 16分距離 d に対するガウス重み exp(-d²/(2σ²))（中心で 1）
 * @param {number} dSteps
 * @param {number} sigma
 * @returns {number}
 */
function rollMiddleGaussianWeight(dSteps, sigma) {
    const s = Math.max(1e-6, Number(sigma) || 0.9);
    const d = Number(dSteps) || 0;
    return Math.exp(-(d * d) / (2 * s * s));
}

/**
 * ドラッグ開始時の音量スナップショット（連打間・±radius のキーのみ）
 * @param {{ type?: string, rollCellVolumes?: Record<string, number> }} rs
 * @param {{ start: number, end: number }} sec
 * @param {number} bpm
 * @param {number} centerBi
 * @param {number} centerSi
 * @returns {Map<string, number>}
 */
function captureRollMiddleNeighborVolumeSnapshot(rs, sec, bpm, centerBi, centerSi) {
    const snap = new Map();
    if (!rs || (rs.type !== 'roll-start' && rs.type !== 'roll')) return snap;
    ensureRollCellVolumesMap(rs);
    const keys = getRollMiddleNeighborKeysAround(sec, bpm, centerBi, centerSi, CHART_ROLL_MIDDLE_NEIGHBOR_RADIUS_STEPS);
    for (const k of keys) {
        const v = rs.rollCellVolumes[k] != null
            ? clampNoteVolume(Number(rs.rollCellVolumes[k]))
            : getNoteVolumeForEditor(rs);
        snap.set(k, v);
    }
    return snap;
}

/**
 * 連打「間」±radius マスを、スナップショット音量から targetCenterVol へガウス重みで補間する
 * @param {{ type?: string, rollCellVolumes?: Record<string, number> }} rs
 * @param {{ start: number, end: number, rollStartIndex: number }} sec
 * @param {number} bpm
 * @param {number} targetCenterVol 中心マスが目指す音量（ドラッグ中は連続値可）
 * @param {number} centerBi
 * @param {number} centerSi
 * @param {Map<string, number>} snapshot key -> 操作前の音量
 * @param {boolean} [quantizeAfter=false] 各マスを離散ステップへ丸める（ホイール1ティック時など）
 */
function applyGaussianBlendRollMiddleNeighbors(rs, sec, bpm, targetCenterVol, centerBi, centerSi, snapshot, quantizeAfter) {
    if (!rs || (rs.type !== 'roll-start' && rs.type !== 'roll')) return;
    if (!snapshot || snapshot.size === 0) return;
    ensureRollCellVolumesMap(rs);
    const keys = getRollMiddleNeighborKeysAround(sec, bpm, centerBi, centerSi, CHART_ROLL_MIDDLE_NEIGHBOR_RADIUS_STEPS);
    const centerAbs = centerBi * 16 + centerSi;
    const sigma = CHART_ROLL_MIDDLE_GAUSS_SIGMA_STEPS;
    const tgt = clampNoteVolume(targetCenterVol);
    const keySet = new Set(keys);
    for (const key of keys) {
        const v0 = snapshot.get(key);
        if (v0 === undefined) continue;
        const parts = key.split(':');
        const bi = parseInt(parts[0], 10);
        const si = parseInt(parts[1], 10);
        const d = Math.abs(bi * 16 + si - centerAbs);
        const w = rollMiddleGaussianWeight(d, sigma);
        let vi = clampNoteVolume(v0 + w * (tgt - v0));
        if (quantizeAfter) vi = quantizeRollCellVolumeStep(vi);
        rs.rollCellVolumes[key] = vi;
    }
    flushChartPartSlot();
    const grid = document.getElementById('chart-measures-grid');
    if (!grid) return;
    grid.querySelectorAll(`.note-roll-span-bar[data-roll-start-index="${sec.rollStartIndex}"]`).forEach((el) => {
        const bi = parseInt(el.dataset.cellBarIndex, 10);
        const si = parseInt(el.dataset.cellStepIndex, 10);
        const k = `${bi}:${si}`;
        if (!keySet.has(k)) return;
        const vv = rs.rollCellVolumes[k] != null ? clampNoteVolume(Number(rs.rollCellVolumes[k])) : getNoteVolumeForEditor(rs);
        el.style.height = `${Math.max(4, 16 * vv)}px`;
    });
}

/**
 * roll-start / type:roll に rollCellVolumes マップを確保する
 * @param {{ type?: string, rollCellVolumes?: Record<string, number> }} rs
 */
function ensureRollCellVolumesMap(rs) {
    if (!rs || (rs.type !== 'roll-start' && rs.type !== 'roll')) return;
    if (!rs.rollCellVolumes || typeof rs.rollCellVolumes !== 'object') rs.rollCellVolumes = {};
}

/**
 * 指定小節・ステップに他ノーツがいるか（roll のみ除外インデックス）
 * @param {Set<number>} ignoreIndices
 */
function chartEditorCellOccupiedByOther(barIndex, stepIndex, bpm, ignoreIndices) {
    const bi = Math.max(0, Number(barIndex) || 0);
    const si = Math.max(0, Math.min(15, Number(stepIndex) || 0));
    for (let i = 0; i < editingNotes.length; i++) {
        if (ignoreIndices.has(i)) continue;
        const n = editingNotes[i];
        if (!n) continue;
        const t = n.type === 'roll' ? (n.startTime ?? 0) : (n.time ?? 0);
        const p = timeToBarStep(t, bpm);
        if (p.barIndex === bi && p.stepIndex === si) return true;
    }
    return false;
}

/**
 * 連打終了を deltaSteps だけ16分移動（正で後ろへ）
 * @param {number} rollStartIndex
 * @param {number} rollEndIndex
 * @param {number} deltaSteps
 * @param {number} bpm
 * @returns {boolean}
 */
function tryResizeRollEndBySteps(rollStartIndex, rollEndIndex, deltaSteps, bpm) {
    if (!deltaSteps) return false;
    const rs = editingNotes[rollStartIndex];
    const re = editingNotes[rollEndIndex];
    if (!rs || rs.type !== 'roll-start' || !re || re.type !== 'roll-end') return false;
    const startAbs = chartEditorAbsStepFromTime(rs.time ?? 0, bpm);
    const { barIndex: eb, stepIndex: es } = timeToBarStep(re.time ?? 0, bpm);
    const newEndAbs = eb * 16 + es + deltaSteps;
    if (newEndAbs <= startAbs) return false;
    const nb = Math.floor(newEndAbs / 16);
    const ns = newEndAbs % 16;
    const ign = new Set([rollStartIndex, rollEndIndex]);
    if (chartEditorCellOccupiedByOther(nb, ns, bpm, ign)) return false;
    re.time = barStepToTime(nb, ns, bpm);
    return true;
}

/**
 * 連打開始を deltaSteps だけ16分移動（正で後ろへ）
 * @returns {boolean}
 */
function tryResizeRollStartBySteps(rollStartIndex, rollEndIndex, deltaSteps, bpm) {
    if (!deltaSteps) return false;
    const rs = editingNotes[rollStartIndex];
    const re = editingNotes[rollEndIndex];
    if (!rs || rs.type !== 'roll-start' || !re || re.type !== 'roll-end') return false;
    const endAbs = chartEditorAbsStepFromTime(re.time ?? 0, bpm);
    const { barIndex: sb, stepIndex: ss } = timeToBarStep(rs.time ?? 0, bpm);
    const newStartAbs = sb * 16 + ss + deltaSteps;
    if (newStartAbs >= endAbs) return false;
    if (newStartAbs < 0) return false;
    const nb = Math.floor(newStartAbs / 16);
    const ns = newStartAbs % 16;
    const ign = new Set([rollStartIndex, rollEndIndex]);
    if (chartEditorCellOccupiedByOther(nb, ns, bpm, ign)) return false;
    rs.time = barStepToTime(nb, ns, bpm);
    return true;
}

/**
 * Shift＋横方向: 開始を2マス・終了を2マスずつ対称に広げる／縮める
 * @param {boolean} expand true で開始を2マス前・終了を2マス後へ
 * @returns {boolean}
 */
function trySymmetricResizeRollTwoEachSide(rollStartIndex, rollEndIndex, expand, bpm) {
    const rs = editingNotes[rollStartIndex];
    const re = editingNotes[rollEndIndex];
    if (!rs || rs.type !== 'roll-start' || !re || re.type !== 'roll-end') return false;
    const d = expand ? 1 : -1;
    const startDelta = -2 * d;
    const endDelta = 2 * d;
    const { barIndex: sb, stepIndex: ss } = timeToBarStep(rs.time ?? 0, bpm);
    const { barIndex: eb, stepIndex: es } = timeToBarStep(re.time ?? 0, bpm);
    const newStartAbs = sb * 16 + ss + startDelta;
    const newEndAbs = eb * 16 + es + endDelta;
    if (newStartAbs < 0 || newEndAbs <= newStartAbs) return false;
    const nsb = Math.floor(newStartAbs / 16);
    const nss = newStartAbs % 16;
    const neb = Math.floor(newEndAbs / 16);
    const nes = newEndAbs % 16;
    const ign = new Set([rollStartIndex, rollEndIndex]);
    if (chartEditorCellOccupiedByOther(nsb, nss, bpm, ign)) return false;
    if (chartEditorCellOccupiedByOther(neb, nes, bpm, ign)) return false;
    rs.time = barStepToTime(nsb, nss, bpm);
    re.time = barStepToTime(neb, nes, bpm);
    return true;
}

/**
 * Alt 時の連打周囲音量連動オプションを組み立てる（Shift は連打長さ用に空ける）
 * @param {boolean} altKey
 * @param {number} anchorNoteIndex editingNotes 上の roll-start または roll
 * @returns {{ neighborPull: boolean, rollSection: { start: number, end: number } } | undefined}
 */
function buildRollVolumeNeighborDragOpts(altKey, anchorNoteIndex) {
    if (!altKey) return undefined;
    const n = editingNotes[anchorNoteIndex];
    if (!n || (n.type !== 'roll-start' && n.type !== 'roll')) return undefined;
    const sec = getRollSectionsFromNotes(editingNotes).find((x) => x.rollStartIndex === anchorNoteIndex);
    if (!sec) return undefined;
    return { neighborPull: true, rollSection: { start: sec.start, end: sec.end } };
}

/**
 * ドラッグ中の Y から音量を決め、指定インデックスのノーツに volume を適用する
 * @param {number | number[]} noteIndices 単一インデックスまたは配列
 * @param {number} clientY
 * @param {DOMRect} volumeRect 音量マッピング用の矩形（セルまたは measure-cells と同等の高さ）
 * @param {{ neighborPull?: boolean, rollSection?: { start: number, end: number } } | undefined} [dragOpts] 連打＋Alt で周囲 don/ka を引き寄せる
 */
function applyChartNoteVolumeFromPointer(noteIndices, clientY, volumeRect, dragOpts) {
    if (!volumeRect) return;
    const vol = clampNoteVolume(chartNoteVolumeFromPointerY(clientY, volumeRect));
    const list = Array.isArray(noteIndices) ? noteIndices : [noteIndices];
    for (const ni of list) {
        const n = editingNotes[ni];
        if (!n || (n.type !== 'don' && n.type !== 'ka' && n.type !== 'roll-start' && n.type !== 'roll')) continue;
        n.volume = vol;
    }
    flushChartPartSlot();
    const grid = document.getElementById('chart-measures-grid');
    if (grid) {
        for (const ni of list) {
            const n = editingNotes[ni];
            if (!n || (n.type !== 'don' && n.type !== 'ka' && n.type !== 'roll-start' && n.type !== 'roll')) continue;
            const el = grid.querySelector(`.note-chip[data-index="${ni}"]`);
            if (el) el.style.height = `${Math.max(4, 16 * vol)}px`;
            if (n.type === 'roll-start' || n.type === 'roll') {
                const m = n.rollCellVolumes;
                grid.querySelectorAll(`.note-roll-span-bar[data-roll-start-index="${ni}"]`).forEach((barEl) => {
                    const bi = parseInt(barEl.dataset.cellBarIndex, 10);
                    const si = parseInt(barEl.dataset.cellStepIndex, 10);
                    const key = `${bi}:${si}`;
                    const vv = m && m[key] != null ? clampNoteVolume(Number(m[key])) : vol;
                    barEl.style.height = `${Math.max(4, 16 * vv)}px`;
                });
            }
        }
    }
    if (dragOpts?.neighborPull && dragOpts.rollSection) {
        applyNeighborVolumePullTowardRoll(vol, dragOpts.rollSection, getChartTempo());
    }
}

/**
 * type: roll 1件の開始・終了を16分ステップで移動する
 * @param {number} rollIndex
 * @param {number} dStart
 * @param {number} dEnd
 * @param {number} bpm
 * @returns {boolean}
 */
function tryResizeCompactRollEdges(rollIndex, dStart, dEnd, bpm) {
    if (!dStart && !dEnd) return false;
    const n = editingNotes[rollIndex];
    if (!n || n.type !== 'roll') return false;
    const ign = new Set([rollIndex]);
    const { barIndex: sb, stepIndex: ss } = timeToBarStep(n.startTime ?? 0, bpm);
    const { barIndex: eb, stepIndex: es } = timeToBarStep(n.endTime ?? n.startTime ?? 0, bpm);
    const newStartAbs = sb * 16 + ss + dStart;
    const newEndAbs = eb * 16 + es + dEnd;
    if (newStartAbs < 0 || newEndAbs <= newStartAbs) return false;
    const nsb = Math.floor(newStartAbs / 16);
    const nss = newStartAbs % 16;
    const neb = Math.floor(newEndAbs / 16);
    const nes = newEndAbs % 16;
    if (chartEditorCellOccupiedByOther(nsb, nss, bpm, ign)) return false;
    if (chartEditorCellOccupiedByOther(neb, nes, bpm, ign)) return false;
    n.startTime = barStepToTime(nsb, nss, bpm);
    n.endTime = barStepToTime(neb, nes, bpm);
    return true;
}

/**
 * 横方向1ティック分の連打長さ変更（通常±1マス、Shift で±2マス対称）
 * @param {{ start: number, end: number, rollStartIndex: number, rollEndIndex?: number }} sec
 * @param {number} cellBi
 * @param {number} cellSi
 * @param {number} directionSign 右へドラッグで +1
 * @param {boolean} shiftKey
 * @param {number} bpm
 * @returns {boolean}
 */
function applyRollHorizontalResizeTick(sec, cellBi, cellSi, directionSign, shiftKey, bpm) {
    const rsi = sec.rollStartIndex;
    const rei = sec.rollEndIndex != null ? sec.rollEndIndex : rsi;
    const rs = editingNotes[rsi];
    if (rs && rs.type === 'roll') {
        if (shiftKey) {
            const d = directionSign > 0 ? 1 : -1;
            return tryResizeCompactRollEdges(rsi, -2 * d, 2 * d, bpm);
        }
        const kind = rollBarCellKind(cellBi, cellSi, sec, bpm);
        if (kind === 'start') {
            return tryResizeCompactRollEdges(rsi, directionSign > 0 ? 1 : -1, 0, bpm);
        }
        return tryResizeCompactRollEdges(rsi, 0, directionSign > 0 ? 1 : -1, bpm);
    }
    if (shiftKey) {
        return trySymmetricResizeRollTwoEachSide(rsi, rei, directionSign > 0, bpm);
    }
    const kind = rollBarCellKind(cellBi, cellSi, sec, bpm);
    if (kind === 'start') {
        return tryResizeRollStartBySteps(rsi, rei, directionSign > 0 ? 1 : -1, bpm);
    }
    return tryResizeRollEndBySteps(rsi, rei, directionSign > 0 ? 1 : -1, bpm);
}

/**
 * 連打開始の譜面アンカー時刻から editingNotes 上のインデックスを検索（ソート後も同一定位）
 * @param {number} anchorTime
 * @returns {number}
 */
function findRollStartIndexByAnchorTime(anchorTime) {
    const t = Number(anchorTime);
    if (!Number.isFinite(t)) return -1;
    for (let i = 0; i < editingNotes.length; i++) {
        const n = editingNotes[i];
        if (!n) continue;
        if (n.type === 'roll-start' && Number(n.time ?? 0) === t) return i;
        if (n.type === 'roll' && Number(n.startTime ?? 0) === t) return i;
    }
    return -1;
}

/**
 * 連打感セル選択キー（アンカー時刻|小節:ステップ）
 * @param {number} anchorTime
 * @param {number} cellBi
 * @param {number} cellSi
 * @returns {string}
 */
function chartRollFeelSelectionKey(anchorTime, cellBi, cellSi) {
    return `${Number(anchorTime)}|${cellBi}:${cellSi}`;
}

/**
 * 絶対16分レンジ内で連打区間と重なるマスを連打感選択キーにまとめる
 * @param {number} fromBar
 * @param {number} fromStep
 * @param {number} toBar
 * @param {number} toStep
 * @param {number} bpm
 * @returns {Set<string>}
 */
function getRollFeelCellKeysInAbsRange(fromBar, fromStep, toBar, toStep, bpm) {
    const keys = new Set();
    const a = (Math.max(0, Number(fromBar) || 0) * 16) + Math.max(0, Math.min(15, Number(fromStep) || 0));
    const b = (Math.max(0, Number(toBar) || 0) * 16) + Math.max(0, Math.min(15, Number(toStep) || 0));
    const minAbs = Math.min(a, b);
    const maxAbs = Math.max(a, b);
    const sections = getRollSectionsFromNotes(editingNotes);
    const stepSec = getBarSec(bpm) / 16;
    for (let abs = minAbs; abs <= maxAbs; abs++) {
        const bi = Math.floor(abs / 16);
        const si = abs % 16;
        const t0 = barStepToTime(bi, si, bpm);
        const t1 = t0 + stepSec;
        for (const sec of sections) {
            const rs = editingNotes[sec.rollStartIndex];
            if (!rs || (rs.type !== 'roll-start' && rs.type !== 'roll')) continue;
            const ra = Number(sec.start ?? 0);
            const rb = Number(sec.end ?? 0);
            if (!Number.isFinite(ra) || !Number.isFinite(rb) || rb <= ra) continue;
            if (t1 > ra && t0 <= rb) {
                const anchor = rs.type === 'roll' ? Number(rs.startTime ?? 0) : Number(rs.time ?? 0);
                keys.add(chartRollFeelSelectionKey(anchor, bi, si));
                break;
            }
        }
    }
    return keys;
}

/**
 * 連打帯の数値%入力モードの状態だけを消す
 */
function clearChartRollFeelDigitInput() {
    chartRollFeelSelectionKeys.clear();
    chartRollFeelInputBuffer = '';
}

/**
 * chart-status に連打感数値入力の案内を出す
 */
function syncChartRollFeelHintStatus() {
    const st = document.getElementById('chart-status');
    if (!st || chartRollFeelSelectionKeys.size === 0) return;
    const n = chartRollFeelSelectionKeys.size;
    if (chartRollFeelInputBuffer) {
        st.textContent = `連打感（${n}マス）: ${chartRollFeelInputBuffer}%（Enter で確定、Esc でやめる）`;
    } else {
        st.textContent = `連打感 ${n}マス選択中 — 0〜300の整数（%）入力後 Enter（Esc でやめる）`;
    }
}

/**
 * 連打感選択中のバッファを % として解釈し、選択マスすべてに適用する（Enter 確定）
 */
function applyChartRollFeelPercentFromBuffer() {
    const st = document.getElementById('chart-status');
    const keysSnapshot = [...chartRollFeelSelectionKeys];
    const raw = chartRollFeelInputBuffer.trim();
    if (keysSnapshot.length === 0) {
        chartRollFeelInputBuffer = '';
        renderNotesStrip();
        return;
    }
    if (raw === '') {
        chartRollFeelInputBuffer = '';
        syncChartRollFeelHintStatus();
        renderNotesStrip();
        return;
    }
    chartRollFeelInputBuffer = '';
    chartRollFeelSelectionKeys.clear();
    const keysToApply = keysSnapshot;
    const pct = parseInt(raw, 10);
    if (!Number.isFinite(pct) || pct < 0 || pct > 300) {
        if (st) st.textContent = '0〜300の整数を入力してください';
        renderNotesStrip();
        return;
    }
    const vol = pct === 0 ? NOTE_VOLUME_MIN : clampNoteVolume(pct / 100);
    const bpm = getChartTempo();
    let applied = 0;
    for (const selKey of keysToApply) {
        const pipe = selKey.indexOf('|');
        if (pipe < 0) continue;
        const anchor = Number(selKey.slice(0, pipe));
        const rest = selKey.slice(pipe + 1);
        const colon = rest.indexOf(':');
        if (colon < 0) continue;
        const cellBi = parseInt(rest.slice(0, colon), 10);
        const cellSi = parseInt(rest.slice(colon + 1), 10);
        if (!Number.isFinite(anchor) || !Number.isFinite(cellBi) || !Number.isFinite(cellSi)) continue;
        const rollStartIndex = findRollStartIndexByAnchorTime(anchor);
        if (rollStartIndex < 0) continue;
        const rs = editingNotes[rollStartIndex];
        if (!rs || (rs.type !== 'roll-start' && rs.type !== 'roll')) continue;
        const sec = getRollSectionsFromNotes(editingNotes).find((s) => s.rollStartIndex === rollStartIndex);
        if (!sec) continue;
        const kind = rollBarCellKind(cellBi, cellSi, sec, bpm);
        if (kind === 'middle') {
            ensureRollCellVolumesMap(rs);
            rs.rollCellVolumes[`${cellBi}:${cellSi}`] = vol;
        } else {
            rs.volume = vol;
        }
        applied += 1;
    }
    if (st) {
        if (applied <= 0) {
            st.textContent = '連打ノーツに適用できませんでした（選択し直してください）';
        } else if (pct === 0) {
            st.textContent = `連打感を最小（10%）に設定しました（${applied}マス）`;
        } else {
            st.textContent = `連打感を ${pct}% に設定しました（${applied}マス）`;
        }
    }
    flushChartPartSlot();
    renderNotesStrip();
}

/**
 * セル内の連打帯: 縦＝音量（中間はセル別・離散）、横＝長さ（Shift で±2マス対称）、ホイールで中間セル音量を1段階
 * @param {HTMLElement} barEl
 * @param {{ start: number, end: number, rollStartIndex: number, rollEndIndex?: number }} sec
 * @param {number} cellBi
 * @param {number} cellSi
 * @param {HTMLElement} cellEl
 */
function bindChartRollSpanBarVolumePointer(barEl, sec, cellBi, cellSi, cellEl) {
    const rollStartIndex = sec.rollStartIndex;
    barEl.addEventListener('wheel', (e) => {
        const bpmW = getChartTempo();
        if (rollBarCellKind(cellBi, cellSi, sec, bpmW) !== 'middle') return;
        e.preventDefault();
        clearChartRollFeelDigitInput();
        const stWheel = document.getElementById('chart-status');
        if (stWheel && /^連打感:/.test(stWheel.textContent)) stWheel.textContent = '';
        const rs = editingNotes[rollStartIndex];
        if (!rs || (rs.type !== 'roll-start' && rs.type !== 'roll')) return;
        ensureRollCellVolumesMap(rs);
        const key = `${cellBi}:${cellSi}`;
        const cur = rs.rollCellVolumes[key] != null
            ? clampNoteVolume(Number(rs.rollCellVolumes[key]))
            : getNoteVolumeForEditor(rs);
        const dir = e.deltaY < 0 ? 1 : -1;
        const next = quantizeRollCellVolumeStep(cur + dir * CHART_ROLL_CELL_VOLUME_QUANT_STEP);
        const neighKeys = getRollMiddleNeighborKeysAround(sec, bpmW, cellBi, cellSi);
        if (e.shiftKey && neighKeys.length > 0) {
            const snap = captureRollMiddleNeighborVolumeSnapshot(rs, sec, bpmW, cellBi, cellSi);
            applyGaussianBlendRollMiddleNeighbors(rs, sec, bpmW, next, cellBi, cellSi, snap, true);
        } else {
            rs.rollCellVolumes[key] = next;
            flushChartPartSlot();
            barEl.style.height = `${Math.max(4, 16 * next)}px`;
        }
    }, { passive: false });

    barEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const rsDown = editingNotes[rollStartIndex];
        const anchorDown = rsDown && (rsDown.type === 'roll' ? Number(rsDown.startTime ?? 0) : Number(rsDown.time ?? 0));
        const mySelKey = chartRollFeelSelectionKey(anchorDown, cellBi, cellSi);
        const sameDigitFocus = chartRollFeelSelectionKeys.size === 1 && chartRollFeelSelectionKeys.has(mySelKey);
        if (chartRollFeelSelectionKeys.size > 0 && !sameDigitFocus) {
            clearChartRollFeelDigitInput();
            const st0 = document.getElementById('chart-status');
            if (st0 && /^連打感:/.test(st0.textContent)) st0.textContent = '';
        } else if (sameDigitFocus) {
            chartRollFeelInputBuffer = '';
            syncChartRollFeelHintStatus();
        }
        const measureCellsRow = cellEl.closest('.measure-cells');
        const startY = e.clientY;
        const startX = e.clientX;
        let lastX = e.clientX;
        let didAct = false;
        /** @type {'none'|'vol'|'len'} */
        let dragMode = 'none';
        let accHoriz = 0;
        chartVolumeDragPointerId = e.pointerId;
        const bpm = getChartTempo();
        const kindAtDown = rollBarCellKind(cellBi, cellSi, sec, bpm);
        /** @type {Map<string, number> | null} */
        let middleDragVolSnapshot = null;
        /** @type {string[] | null} */
        let middleDragNeighborKeys = null;
        let didShiftMiddleGaussianVol = false;
        if (kindAtDown === 'middle') {
            const rs0 = editingNotes[rollStartIndex];
            if (rs0 && (rs0.type === 'roll-start' || rs0.type === 'roll')) {
                middleDragNeighborKeys = getRollMiddleNeighborKeysAround(sec, bpm, cellBi, cellSi);
                middleDragVolSnapshot = captureRollMiddleNeighborVolumeSnapshot(rs0, sec, bpm, cellBi, cellSi);
            }
        }
        try {
            barEl.setPointerCapture(e.pointerId);
        } catch {
            /* noop */
        }
        const onMove = (ev) => {
            if (ev.pointerId !== chartVolumeDragPointerId) return;
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (dragMode === 'none' && Math.hypot(dx, dy) < CHART_NOTE_VOLUME_DRAG_THRESHOLD_PX) return;
            if (dragMode === 'none') {
                dragMode = Math.abs(dx) >= Math.abs(dy) ? 'len' : 'vol';
                clearChartRollFeelDigitInput();
                const stDrag = document.getElementById('chart-status');
                if (stDrag && /^連打感:/.test(stDrag.textContent)) stDrag.textContent = '';
                if (dragMode === 'len') {
                    ev.preventDefault();
                    didAct = true;
                    selectedNoteIndex = rollStartIndex;
                    selectedNoteIndices = new Set([rollStartIndex]);
                }
            }
            if (dragMode === 'len') {
                ev.preventDefault();
                const cw = cellEl.getBoundingClientRect().width;
                const threshold = Math.max(10, cw * 0.45);
                accHoriz += ev.clientX - lastX;
                lastX = ev.clientX;
                let changed = false;
                while (accHoriz >= threshold) {
                    if (applyRollHorizontalResizeTick(sec, cellBi, cellSi, 1, ev.shiftKey, bpm)) changed = true;
                    accHoriz -= threshold;
                }
                while (accHoriz <= -threshold) {
                    if (applyRollHorizontalResizeTick(sec, cellBi, cellSi, -1, ev.shiftKey, bpm)) changed = true;
                    accHoriz += threshold;
                }
                if (changed) {
                    flushChartPartSlot();
                    scheduleRenderNotesStrip();
                }
                return;
            }
            if (dragMode === 'vol') {
                ev.preventDefault();
                if (!didAct) {
                    didAct = true;
                    selectedNoteIndex = rollStartIndex;
                    selectedNoteIndices = new Set([rollStartIndex]);
                }
                const rect = measureCellsRow?.getBoundingClientRect() || cellEl.getBoundingClientRect();
                if (kindAtDown === 'middle'
                    && (editingNotes[rollStartIndex]?.type === 'roll-start'
                        || editingNotes[rollStartIndex]?.type === 'roll')) {
                    const rsN = editingNotes[rollStartIndex];
                    const raw = chartNoteVolumeFromPointerY(ev.clientY, rect);
                    const neighKeys = getRollMiddleNeighborKeysAround(sec, bpm, cellBi, cellSi);
                    if (ev.shiftKey && neighKeys.length > 0 && middleDragVolSnapshot) {
                        const targetCenter = clampNoteVolume(raw);
                        applyGaussianBlendRollMiddleNeighbors(
                            rsN, sec, bpm, targetCenter, cellBi, cellSi, middleDragVolSnapshot, false
                        );
                        didShiftMiddleGaussianVol = true;
                    } else {
                        const v = quantizeRollCellVolumeStep(raw);
                        ensureRollCellVolumesMap(rsN);
                        const key = `${cellBi}:${cellSi}`;
                        rsN.rollCellVolumes[key] = v;
                        flushChartPartSlot();
                        barEl.style.height = `${Math.max(4, 16 * v)}px`;
                    }
                    return;
                }
                applyChartNoteVolumeFromPointer(
                    [rollStartIndex],
                    ev.clientY,
                    rect,
                    buildRollVolumeNeighborDragOpts(ev.altKey, rollStartIndex)
                );
            }
        };
        const onUp = (ev) => {
            if (ev.pointerId !== chartVolumeDragPointerId) return;
            barEl.removeEventListener('pointermove', onMove);
            barEl.removeEventListener('pointerup', onUp);
            barEl.removeEventListener('pointercancel', onUp);
            try {
                barEl.releasePointerCapture(ev.pointerId);
            } catch {
                /* noop */
            }
            chartVolumeDragPointerId = -1;
            if (didShiftMiddleGaussianVol && middleDragNeighborKeys) {
                const rsUp = editingNotes[rollStartIndex];
                if (rsUp && rsUp.rollCellVolumes) {
                    for (const k of middleDragNeighborKeys) {
                        if (rsUp.rollCellVolumes[k] != null) {
                            rsUp.rollCellVolumes[k] = quantizeRollCellVolumeStep(Number(rsUp.rollCellVolumes[k]));
                        }
                    }
                }
                didAct = true;
            }
            if (didAct) {
                flushChartPartSlot();
                renderNotesStrip();
            } else if (ev.type !== 'pointercancel') {
                const rsUp = editingNotes[rollStartIndex];
                if (rsUp && (rsUp.type === 'roll-start' || rsUp.type === 'roll')) {
                    const rollAnchorTime = rsUp.type === 'roll' ? Number(rsUp.startTime ?? 0) : Number(rsUp.time ?? 0);
                    chartRollFeelSelectionKeys.clear();
                    chartRollFeelSelectionKeys.add(chartRollFeelSelectionKey(rollAnchorTime, cellBi, cellSi));
                    chartRollFeelInputBuffer = '';
                    selectedNoteIndex = rollStartIndex;
                    selectedNoteIndices = new Set([rollStartIndex]);
                    syncChartRollFeelHintStatus();
                    renderNotesStrip();
                }
            }
        };
        barEl.addEventListener('pointermove', onMove);
        barEl.addEventListener('pointerup', onUp);
        barEl.addEventListener('pointercancel', onUp);
    });
}
/** マルチプレイ用 1P/2P/3P の切替（1..3） */
let chartEditingPart = 1;
/** 選択中譜面のパート別ノーツ（インデックス 0=1P,1=2P,2=3P） */
let chartPartNoteSlots = [[], [], []];
/** 選択中譜面のパート名（1..3） */
let chartPartNames = { 1: '', 2: '', 3: '' };

/** ヒット音MP3インポート直前の帯インデックス(0–4)と don|ka */
let chartHitSoundPending = { bucket: 0, kind: /** @type {'don'|'ka'} */ ('don') };

/** ノーツ音量10〜300%を5等分した帯の表示ラベル（サーバー・ゲームと同順） */
const HIT_SOUND_VOLUME_BAND_LABELS = ['0〜20%', '20〜40%', '40〜60%', '60〜80%', '80〜100%'];

/**
 * プレビュー・ヒット音帯判定用（taiko-game-manager の taikoVolumeToHitBucket と同式）
 * @param {number} volumeMultiplier
 * @returns {number} 0..4
 */
function chartVolumeToHitBucketForPreview(volumeMultiplier) {
    const n = HIT_SOUND_VOLUME_BAND_LABELS.length;
    const x = clampNoteVolume(volumeMultiplier);
    const pct = ((x - NOTE_VOLUME_MIN) / (NOTE_VOLUME_MAX - NOTE_VOLUME_MIN)) * 100;
    const b = Math.floor(pct / (100 / n));
    return Math.min(n - 1, Math.max(0, b));
}

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
/** 連打感のマス選択（キーは chartRollFeelSelectionKey） */
let chartRollFeelSelectionKeys = /** @type {Set<string>} */ (new Set());
/** 連打感%入力中の数字バッファ（最大3桁） */
let chartRollFeelInputBuffer = '';
/** コピーされたノーツ（範囲選択/単体選択）を保持する内部クリップボード */
let chartClipboard = null;
/** BPM入力の変更前後でグリッド位置を維持するため、直近の描画BPMを保持する */
let lastRenderedChartBpm = null;
/** 譜面グリッド再描画を次の animation frame に1回にまとめる */
let chartNotesStripRafId = 0;
/** 小節下 measure-spec 波形の遅延描画用（グリッド再構築のたびに即描画しない） */
let chartMeasureWaveformIdleTimer = 0;
const CHART_MEASURE_WAVEFORM_IDLE_MS = 240;
/** 小節下波形: 直近で全描画したときの「タイミング署名」（BPM/小節BPM/BGM/パート）。ノーツのみの変更では変わらない */
let lastMeasureStripWaveformChartId = null;
let lastMeasureStripWaveformTimingSig = '';
let lastMeasureStripWaveformTotalMeasures = 0;
/** 小節下波形: 正規化ピーク列のキャッシュ（キー barIndex:pixelW）。タイミング署名が変わると破棄 */
let measureStripWavePeaksCacheSig = '';
/** @type {Map<string, Float32Array>} */
const measureStripWaveNormPeaks = new Map();
/** 小節ヘッダ BPM 入力のデバウンス（ms） */
let chartMeasureBpmInputDebounceTimer = 0;
/** ベーステンポ入力のデバウンス（ms） */
let chartTempoInputDebounceTimer = 0;

/**
 * メインスレッドを一度譲り、ローダー文言の描画を先に反映させる
 * @returns {Promise<void>}
 */
function yieldToBrowser() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

/**
 * 譜面グリッドの再描画を次フレームに1回にまとめる（ドラッグ・連打リサイズなど高頻度用）
 */
function scheduleRenderNotesStrip() {
    if (chartNotesStripRafId) return;
    chartNotesStripRafId = requestAnimationFrame(() => {
        chartNotesStripRafId = 0;
        renderNotesStrip();
    });
}

/**
 * 小節下 measure-spec の BGM 波形を、操作が落ち着いてから1回だけ描く（毎回の全 canvas 更新を避ける）
 */
function schedulePaintMeasureWaveformIdle() {
    if (chartMeasureWaveformIdleTimer) clearTimeout(chartMeasureWaveformIdleTimer);
    chartMeasureWaveformIdleTimer = setTimeout(() => {
        chartMeasureWaveformIdleTimer = 0;
        paintAllMeasureBgmWaveformCanvases();
    }, CHART_MEASURE_WAVEFORM_IDLE_MS);
}

/**
 * BGM デコード直後など、小節下波形を即描画する（待ちの遅延描画はキャンセル）
 */
function flushPaintMeasureWaveformNow() {
    if (chartMeasureWaveformIdleTimer) {
        clearTimeout(chartMeasureWaveformIdleTimer);
        chartMeasureWaveformIdleTimer = 0;
    }
    paintAllMeasureBgmWaveformCanvases();
}

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
/** プレビュー用カスタムヒット音 key: chartId|part|bucket|don|ka */
let chartPreviewHitSoundBuffers = new Map();
/** プレビュー用BGMデコード済みバッファ（chartId:bgmVersion で無効化） */
let chartPreviewBgmCache = { key: '', buffer: /** @type {AudioBuffer | null} */ (null) };
/** プレビュー停止・再開時に runChartPreviewPlayback の await 後続を打ち切る */
let chartPreviewCancelToken = 0;

/** ログインユーザー一覧の現在ページ（1始まり） */
let currentLoginUsersPage = 1;
const LOGIN_USERS_PAGE_SIZE = 50;

/**
 * サーバーの譜面機能フラグを取得し、ストレージUI等を合わせる
 */
async function refreshAdminChartFeaturesFlag() {
    try {
        const r = await fetch('/api/client-config');
        if (r.ok) {
            const j = await r.json();
            if (typeof j.chartFeaturesEnabled === 'boolean') {
                adminChartFeaturesEnabled = j.chartFeaturesEnabled;
            }
        }
    } catch (_) {
        /* 既定 true */
    }
    applyChartFeaturesAdminChrome();
}

/**
 * 譜面無効時にファイル管理の譜面BGMボタンを隠す
 */
function applyChartFeaturesAdminChrome() {
    document.querySelectorAll('.storage-files-store-btn[data-storage-store="chart-bgm"]').forEach((el) => {
        el.style.display = adminChartFeaturesEnabled ? '' : 'none';
    });
}

/** ワールド編集の import 用に /api/client-config を 1 回だけキャッシュする */
let cachedClientConfigForModules = null;

/**
 * client-config を取得する（モジュール import フォールバック用）
 * @returns {Promise<Record<string, unknown>>}
 */
async function getClientConfigForModules() {
    if (cachedClientConfigForModules) return cachedClientConfigForModules;
    try {
        const r = await fetch('/api/client-config');
        if (r.ok) cachedClientConfigForModules = await r.json();
        else cachedClientConfigForModules = {};
    } catch {
        cachedClientConfigForModules = {};
    }
    return cachedClientConfigForModules;
}

/**
 * setting.js を dynamic import。ページオリジンで失敗したら moduleScriptOrigin とキャッシュバストで再試行する。
 * setting.js をデプロイし直したらこの版を上げる（ブラウザ・中間キャッシュが古いモジュールを掴み続けるのを避ける）
 */
const SETTING_EDITOR_MODULE_VER = '6';
/** 強制再読込後に setting.js の import URL を一意にする（sessionStorage） */
const SETTING_EDITOR_MODULE_BUST_KEY = 'ADMIN_JS_MODULE_BUST';

/**
 * @returns {Promise<{ initSettingEditor: () => Promise<void> }>}
 */
async function importSettingEditorModule() {
    const cfg = await getClientConfigForModules();
    let modOrigin = '';
    if (cfg && typeof cfg.moduleScriptOrigin === 'string') {
        const t = cfg.moduleScriptOrigin.trim().replace(/\/$/, '');
        try {
            const u = new URL(t);
            modOrigin = `${u.protocol}//${u.host}`;
        } catch {
            modOrigin = '';
        }
    }

    const bases = [window.location.origin];
    if (modOrigin && !bases.includes(modOrigin)) bases.push(modOrigin);

    let lastErr = null;
    const moduleBust = (() => {
        try {
            return sessionStorage.getItem(SETTING_EDITOR_MODULE_BUST_KEY);
        } catch {
            return null;
        }
    })();
    const bustSuffix = moduleBust != null && moduleBust !== '' ? `&mb=${encodeURIComponent(moduleBust)}` : '';
    for (const base of bases) {
        for (const bust of [false, true]) {
            const qs = bust ? `&t=${Date.now()}` : '';
            const url = `${base}/js/setting.js?v=${SETTING_EDITOR_MODULE_VER}${bustSuffix}${qs}`;
            try {
                return await import(/* @vite-ignore */ url);
            } catch (e) {
                lastErr = e;
            }
        }
    }
    throw lastErr;
}

/**
 * セキュリティパネル: NG ワード入力行を追加する
 * @param {string} [value]
 */
function ensureSecurityNgRow(value = '') {
    const ul = document.getElementById('sec-chat-ng-list');
    if (!ul) return null;
    const li = document.createElement('li');
    li.className = 'sec-ng-item';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'sec-ng-input';
    inp.placeholder = '禁止語句';
    inp.value = value;
    inp.maxLength = 256;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-secondary sec-ng-del';
    del.textContent = '削除';
    del.addEventListener('click', () => {
        li.remove();
        const u = document.getElementById('sec-chat-ng-list');
        if (u && u.children.length === 0) ensureSecurityNgRow('');
    });
    li.appendChild(inp);
    li.appendChild(del);
    ul.appendChild(li);
    return li;
}

/**
 * NG ワード一覧を DOM から収集する
 * @returns {string[]}
 */
function collectNgWordsFromDom() {
    const ul = document.getElementById('sec-chat-ng-list');
    if (!ul) return [];
    return [...ul.querySelectorAll('.sec-ng-input')]
        .map((i) => String(i.value || '').trim())
        .filter(Boolean);
}

/**
 * セキュリティ「チャット」タブのデータをサーバーから読み込む
 */
/**
 * 閲覧用 pre にモデレーション用システム指示（現在の NG 込み）を反映する
 * @param {{ chatModeration?: string, usernameModeration?: string }} p
 */
function applySecurityModerationPromptsToDom(p) {
    if (!p || typeof p !== 'object') return;
    const pc = document.getElementById('sec-prompt-chat');
    const pu = document.getElementById('sec-prompt-username');
    if (pc) pc.textContent = p.chatModeration || '';
    if (pu) pu.textContent = p.usernameModeration || '';
}

async function loadSecurityPanelChat() {
    const st = document.getElementById('sec-chat-ng-status');
    try {
        const [wRes, pRes] = await Promise.all([
            fetch('/admin/security/chat-ng-words', { credentials: 'same-origin' }),
            fetch('/admin/security/chat-moderation-prompts', { credentials: 'same-origin' }),
        ]);
        if (!wRes.ok) throw new Error('NG list load failed');
        if (!pRes.ok) throw new Error('prompt load failed');
        const w = await wRes.json();
        const p = await pRes.json();
        const ul = document.getElementById('sec-chat-ng-list');
        if (ul) {
            ul.innerHTML = '';
            const words = Array.isArray(w.words) ? w.words : [];
            if (words.length === 0) {
                ensureSecurityNgRow('');
            } else {
                for (const word of words) ensureSecurityNgRow(word);
            }
        }
        applySecurityModerationPromptsToDom(p);
        if (st) st.textContent = '';
    } catch (e) {
        console.error(e);
        if (st) st.textContent = '読み込みに失敗しました';
    }
}

/**
 * セキュリティパネルの一度だけイベント登録
 */
function initSecurityPanelOnce() {
    if (securityPanelInitialized) return;
    securityPanelInitialized = true;
    document.getElementById('sec-chat-ng-add')?.addEventListener('click', () => {
        ensureSecurityNgRow('');
        const lastInp = document.getElementById('sec-chat-ng-list')?.lastElementChild?.querySelector('input');
        if (lastInp) lastInp.focus();
    });
    document.getElementById('sec-chat-ng-save')?.addEventListener('click', async () => {
        const statusEl = document.getElementById('sec-chat-ng-status');
        const words = collectNgWordsFromDom();
        try {
            const res = await fetch('/admin/security/chat-ng-words', {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ words }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'save failed');
            if (statusEl) statusEl.textContent = '保存しました';
            const ul = document.getElementById('sec-chat-ng-list');
            if (ul && Array.isArray(data.words)) {
                ul.innerHTML = '';
                if (data.words.length === 0) ensureSecurityNgRow('');
                else for (const word of data.words) ensureSecurityNgRow(word);
            }
            const promptRes = await fetch('/admin/security/chat-moderation-prompts', { credentials: 'same-origin' });
            if (promptRes.ok) {
                const refreshed = await promptRes.json();
                applySecurityModerationPromptsToDom(refreshed);
            }
        } catch (e) {
            console.error(e);
            if (statusEl) statusEl.textContent = '保存に失敗しました';
        }
    });
    document.querySelectorAll('.sec-left-nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const pane = btn.getAttribute('data-sec-pane');
            document.querySelectorAll('.sec-left-nav-btn').forEach((b) => {
                b.classList.toggle('active', b === btn);
            });
            document.querySelectorAll('.sec-pane').forEach((p) => {
                p.classList.toggle('active', p.id === pane);
            });
        });
    });
}

const ADMIN_AVATAR_MAP_KEYS = ['idle', 'walk', 'jump', 'run'];

/**
 * 管理パネル用: アバターがログイン候補として十分か（4 モーション）
 * @param {object} entry
 */
function adminAvatarEntryIsSelectable(entry) {
    const clips = entry && Array.isArray(entry.animationClips) ? entry.animationClips : [];
    const m = entry && entry.animationMap && typeof entry.animationMap === 'object' ? entry.animationMap : {};
    if (clips.length === 0) return false;
    for (const k of ADMIN_AVATAR_MAP_KEYS) {
        const v = m[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) return false;
        const ii = Math.trunc(v);
        if (ii < 0 || ii >= clips.length) return false;
    }
    return true;
}

/**
 * アニメ割当セレクトをクリップ一覧で埋める
 * @param {HTMLSelectElement|null} sel
 * @param {{ index: number, label?: string, name?: string }[]} clips
 * @param {number|null|undefined} selectedIndex
 */
function fillAdminAvatarMapSelect(sel, clips, selectedIndex) {
    if (!sel) return;
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '—選択—';
    sel.appendChild(ph);
    for (const c of clips) {
        const opt = document.createElement('option');
        opt.value = String(c.index);
        opt.textContent = c.label || c.name || `clip_${c.index}`;
        sel.appendChild(opt);
    }
    const want =
        typeof selectedIndex === 'number' && Number.isFinite(selectedIndex)
            ? String(Math.trunc(selectedIndex))
            : '';
    if (want !== '' && [...sel.options].some((o) => o.value === want)) sel.value = want;
    else sel.value = '';
}

/**
 * avator-scalable-animations のスロット用セレクトを描画する。
 * @param {object} entry
 */
function renderAdminScalableAvatarMapRows(entry) {
    const mount = document.getElementById('admin-avatar-map-scalable-mount');
    if (!mount) return;
    mount.innerHTML = '';
    const clips = Array.isArray(entry.animationClips) ? entry.animationClips : [];
    const m = entry.animationMap && typeof entry.animationMap === 'object' ? entry.animationMap : {};
    if (!adminAvatarScalableSlots.length) return;

    const title = document.createElement('p');
    title.className = 'hint';
    title.style.marginTop = '10px';
    title.textContent = '追加モーション（avator-scalable-animations / 環境変数 bindings に対応）';
    mount.appendChild(title);

    for (const slot of adminAvatarScalableSlots) {
        const row = document.createElement('div');
        row.className = 'field-row';
        const selId = `admin-avatar-map-${slot.slotKey}`;
        const label = document.createElement('label');
        label.className = 'prop-label';
        label.setAttribute('for', selId);
        const keyHint = slot.key != null && String(slot.key).trim() !== '' ? `（操作キー: ${String(slot.key)}）` : '';
        label.textContent = `${String(slot.name || slot.slotKey)}${keyHint}`;
        const sel = document.createElement('select');
        sel.id = selId;
        sel.className = 'prop-input full';
        row.appendChild(label);
        row.appendChild(sel);
        mount.appendChild(row);
        const ix = m[slot.slotKey];
        fillAdminAvatarMapSelect(sel, clips, typeof ix === 'number' ? ix : undefined);
    }
}

/**
 * アバター行を選択しマッピング UI を開く
 * @param {object} entry
 * @param {number} registryVersion
 */
function openAdminAvatarEditor(entry, registryVersion) {
    const editor = document.getElementById('admin-avatar-editor');
    const metaEl = document.getElementById('admin-avatar-editor-meta');
    if (!editor || !metaEl || !entry) return;
    adminAvatarEditId = entry.id;
    metaEl.innerHTML = `ID: <code>${escapeHtml(String(entry.id))}</code><br>ファイル: <code>${escapeHtml(String(entry.glbFilename || ''))}</code><br>registryVersion: <strong>${escapeHtml(String(registryVersion))}</strong>`;
    const clips = Array.isArray(entry.animationClips) ? entry.animationClips : [];
    const m = entry.animationMap || {};
    fillAdminAvatarMapSelect(document.getElementById('admin-avatar-map-idle'), clips, m.idle);
    fillAdminAvatarMapSelect(document.getElementById('admin-avatar-map-walk'), clips, m.walk);
    fillAdminAvatarMapSelect(document.getElementById('admin-avatar-map-jump'), clips, m.jump);
    fillAdminAvatarMapSelect(document.getElementById('admin-avatar-map-run'), clips, m.run);
    renderAdminScalableAvatarMapRows(entry);
    const scaleInp = document.getElementById('admin-avatar-display-scale');
    if (scaleInp) {
        const d = entry.displayScale;
        scaleInp.value = String(typeof d === 'number' && Number.isFinite(d) ? d : 1);
    }
    const st = document.getElementById('admin-avatar-editor-status');
    if (st) st.textContent = '';
    editor.hidden = false;
}

/**
 * 管理パネル: アバター一覧を再読込する
 */
async function refreshAdminAvatarManagementPanel() {
    const mount = document.getElementById('admin-avatar-list-mount');
    if (!mount) return;
    mount.textContent = '読み込み中…';
    try {
        const r = await fetch('/admin/avatars', { credentials: 'include' });
        const reg = await r.json().catch(() => null);
        if (!r.ok || !reg || !Array.isArray(reg.avatars)) {
            mount.textContent = '一覧の取得に失敗しました。';
            adminAvatarRegistryCache = null;
            adminAvatarScalableSlots = [];
            return;
        }
        adminAvatarRegistryCache = reg;
        adminAvatarScalableSlots = Array.isArray(reg.scalableAnimationSlots) ? reg.scalableAnimationSlots : [];
        mount.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'admin-avatar-rows';
        for (const a of reg.avatars) {
            const row = document.createElement('div');
            row.className = 'admin-avatar-row';
            if (a.isDefault) row.classList.add('admin-avatar-row-default');
            if (!adminAvatarEntryIsSelectable(a)) row.classList.add('admin-avatar-row-incomplete');
            const selBtn = document.createElement('button');
            selBtn.type = 'button';
            selBtn.className = 'btn btn-secondary';
            selBtn.textContent = '選択・編集';
            selBtn.addEventListener('click', () => openAdminAvatarEditor(a, reg.registryVersion));
            const fname = document.createElement('span');
            fname.innerHTML = `<strong>${escapeHtml(String(a.glbFilename || ''))}</strong>`;
            const st = document.createElement('span');
            st.className = 'admin-avatar-row-status';
            st.textContent = adminAvatarEntryIsSelectable(a) ? 'ログイン候補: 準備済み' : 'ログイン候補: 4モーション未設定';
            row.appendChild(fname);
            row.appendChild(st);
            row.appendChild(selBtn);
            wrap.appendChild(row);
        }
        mount.appendChild(wrap);
        if (adminAvatarEditId) {
            const still = reg.avatars.find((x) => x.id === adminAvatarEditId);
            if (still) openAdminAvatarEditor(still, reg.registryVersion);
        }
    } catch (e) {
        console.error('[admin avatar]', e);
        mount.textContent = '一覧の取得に失敗しました。';
        adminAvatarScalableSlots = [];
    }
}

/**
 * アバター管理パネルのボタンを一度だけ紐付けする
 */
function setupAdminAvatarManagementPanel() {
    const btnUp = document.getElementById('btn-admin-avatar-upload');
    const inp = document.getElementById('admin-avatar-upload-file');
    const chk = document.getElementById('admin-avatar-upload-default');
    const st = document.getElementById('admin-avatar-upload-status');
    if (btnUp && inp && !btnUp.dataset.bound) {
        btnUp.dataset.bound = '1';
        btnUp.addEventListener('click', async () => {
            const f = inp.files && inp.files[0];
            if (!f) {
                if (st) st.textContent = 'ファイルを選択してください。';
                return;
            }
            if (st) st.textContent = 'アップロード中…';
            const fd = new FormData();
            fd.append('avatar', f);
            const q = chk && chk.checked ? '?makeDefault=1' : '';
            try {
                const r = await fetch(`/admin/avatars${q}`, { method: 'POST', body: fd, credentials: 'include' });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) {
                    if (st) st.textContent = j.detail || j.error || 'アップロードに失敗しました。';
                    return;
                }
                inp.value = '';
                if (st) st.textContent = 'アップロードしました。';
                await refreshAdminAvatarManagementPanel();
            } catch (e) {
                if (st) st.textContent = '通信エラー';
                console.error(e);
            }
        });
    }
    const btnSave = document.getElementById('btn-admin-avatar-save-map');
    if (btnSave && !btnSave.dataset.bound) {
        btnSave.dataset.bound = '1';
        btnSave.addEventListener('click', async () => {
            const stEd = document.getElementById('admin-avatar-editor-status');
            if (!adminAvatarEditId || !adminAvatarRegistryCache) {
                if (stEd) stEd.textContent = '先にアバターを選択してください。';
                return;
            }
            const regV = adminAvatarRegistryCache.registryVersion;
            const readSel = (id) => {
                const el = document.getElementById(id);
                if (!el) return NaN;
                const n = parseInt(String(el.value), 10);
                return n;
            };
            const animationMap = {
                idle: readSel('admin-avatar-map-idle'),
                walk: readSel('admin-avatar-map-walk'),
                jump: readSel('admin-avatar-map-jump'),
                run: readSel('admin-avatar-map-run'),
            };
            for (const slot of adminAvatarScalableSlots) {
                const el = document.getElementById(`admin-avatar-map-${slot.slotKey}`);
                if (!el) continue;
                const v = el.value;
                if (v === '' || v == null) {
                    animationMap[slot.slotKey] = null;
                } else {
                    const n = parseInt(String(v), 10);
                    if (Number.isFinite(n)) animationMap[slot.slotKey] = n;
                }
            }
            if (!['idle', 'walk', 'jump', 'run'].every((k) => Number.isFinite(animationMap[k]))) {
                if (stEd) stEd.textContent = 'idle / walk / jump / run をすべて選択してください。';
                return;
            }
            if (stEd) stEd.textContent = '保存中…';
            const scaleInp = document.getElementById('admin-avatar-display-scale');
            const scaleNum = scaleInp ? parseFloat(String(scaleInp.value)) : NaN;
            const displayScale = Number.isFinite(scaleNum) ? scaleNum : 1;
            try {
                const r = await fetch(`/admin/avatars/${encodeURIComponent(adminAvatarEditId)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ registryVersion: regV, animationMap, displayScale }),
                });
                const j = await r.json().catch(() => ({}));
                if (r.status === 409) {
                    if (stEd) stEd.textContent = '他で更新されています。一覧を再読み込みしました。';
                    await refreshAdminAvatarManagementPanel();
                    return;
                }
                if (!r.ok) {
                    if (stEd) stEd.textContent = j.error || '保存に失敗しました。';
                    return;
                }
                adminAvatarRegistryCache = { ...adminAvatarRegistryCache, registryVersion: j.registryVersion };
                if (stEd) stEd.textContent = '保存しました。';
                await refreshAdminAvatarManagementPanel();
            } catch (e) {
                console.error(e);
                if (stEd) stEd.textContent = '通信エラー';
            }
        });
    }
    const btnSaveScale = document.getElementById('btn-admin-avatar-save-scale');
    if (btnSaveScale && !btnSaveScale.dataset.bound) {
        btnSaveScale.dataset.bound = '1';
        btnSaveScale.addEventListener('click', async () => {
            const stEd = document.getElementById('admin-avatar-editor-status');
            if (!adminAvatarEditId || !adminAvatarRegistryCache) {
                if (stEd) stEd.textContent = '先にアバターを選択してください。';
                return;
            }
            const regV = adminAvatarRegistryCache.registryVersion;
            const scaleInp = document.getElementById('admin-avatar-display-scale');
            const scaleNum = scaleInp ? parseFloat(String(scaleInp.value)) : NaN;
            if (!Number.isFinite(scaleNum)) {
                if (stEd) stEd.textContent = '表示倍率に数値を入力してください。';
                return;
            }
            if (stEd) stEd.textContent = '保存中…';
            try {
                const r = await fetch(`/admin/avatars/${encodeURIComponent(adminAvatarEditId)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ registryVersion: regV, displayScale: scaleNum }),
                });
                const j = await r.json().catch(() => ({}));
                if (r.status === 409) {
                    if (stEd) stEd.textContent = '他で更新されています。一覧を再読み込みしました。';
                    await refreshAdminAvatarManagementPanel();
                    return;
                }
                if (!r.ok) {
                    if (stEd) stEd.textContent = j.error || '保存に失敗しました。';
                    return;
                }
                adminAvatarRegistryCache = { ...adminAvatarRegistryCache, registryVersion: j.registryVersion };
                if (stEd) stEd.textContent = '表示倍率を保存しました。';
                await refreshAdminAvatarManagementPanel();
            } catch (e) {
                console.error(e);
                if (stEd) stEd.textContent = '通信エラー';
            }
        });
    }
    const btnDef = document.getElementById('btn-admin-avatar-set-default');
    if (btnDef && !btnDef.dataset.bound) {
        btnDef.dataset.bound = '1';
        btnDef.addEventListener('click', async () => {
            const stEd = document.getElementById('admin-avatar-editor-status');
            if (!adminAvatarEditId) {
                if (stEd) stEd.textContent = '先にアバターを選択してください。';
                return;
            }
            if (stEd) stEd.textContent = 'デフォルトに設定中…';
            try {
                const r = await fetch(`/admin/avatars/${encodeURIComponent(adminAvatarEditId)}/default`, {
                    method: 'POST',
                    credentials: 'include',
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) {
                    if (stEd) stEd.textContent = j.message || j.error || '設定に失敗しました。';
                    return;
                }
                if (stEd) stEd.textContent = 'デフォルトにしました。';
                adminAvatarRegistryCache = adminAvatarRegistryCache
                    ? { ...adminAvatarRegistryCache, registryVersion: j.registryVersion }
                    : null;
                await refreshAdminAvatarManagementPanel();
            } catch (e) {
                console.error(e);
                if (stEd) stEd.textContent = '通信エラー';
            }
        });
    }
    const btnDel = document.getElementById('btn-admin-avatar-delete');
    if (btnDel && !btnDel.dataset.bound) {
        btnDel.dataset.bound = '1';
        // 選択中エントリの GLB をレジストリ・ストレージから削除する
        btnDel.addEventListener('click', async () => {
            const stEd = document.getElementById('admin-avatar-editor-status');
            const metaEl = document.getElementById('admin-avatar-editor-meta');
            if (!adminAvatarEditId) {
                if (stEd) stEd.textContent = '先にアバターを選択してください。';
                return;
            }
            const selected =
                adminAvatarRegistryCache &&
                Array.isArray(adminAvatarRegistryCache.avatars)
                    ? adminAvatarRegistryCache.avatars.find((x) => x.id === adminAvatarEditId)
                    : null;
            const glbName = selected && selected.glbFilename ? String(selected.glbFilename) : '';
            const msg = glbName
                ? `このアバターの GLB（${glbName}）を削除します。よろしいですか？`
                : 'このアバターの GLB を削除します。よろしいですか？';
            if (!confirm(msg)) return;
            if (stEd) stEd.textContent = '削除中…';
            try {
                const r = await fetch(`/admin/avatars/${encodeURIComponent(adminAvatarEditId)}`, {
                    method: 'DELETE',
                    credentials: 'include',
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) {
                    if (stEd) stEd.textContent = j.error || '削除に失敗しました。';
                    return;
                }
                adminAvatarEditId = null;
                const editor = document.getElementById('admin-avatar-editor');
                if (editor) editor.hidden = true;
                if (metaEl) metaEl.textContent = '';
                if (stEd) stEd.textContent = '削除しました。';
                await refreshAdminAvatarManagementPanel();
            } catch (e) {
                console.error(e);
                if (stEd) stEd.textContent = '通信エラー';
            }
        });
    }
}

/**
 * 指定したパネル ID を表示し、サイドメニューの active を更新する。
 * ワールド編集パネルは初表示時に setting.js を動的 import して init する。
 */
function switchPanel(panelId) {
    const requestedPanelId = panelId;
    const resolvedPanelId = (panelId === 'panel-chart' && !adminChartFeaturesEnabled)
        ? 'panel-chart-inactive'
        : panelId;
    const activePanel = document.querySelector('.admin-panel.active');
    const currentPanelId = activePanel ? activePanel.id : null;
    if (currentPanelId === 'panel-chart' && resolvedPanelId !== 'panel-chart' && isChartEditorDirty()) {
        if (!confirm('譜面を編集中です（未保存の変更があります）。このまま別の画面に移動しますか？')) {
            return;
        }
    }
    document.querySelectorAll('.admin-panel').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.admin-nav-item').forEach((el) => el.classList.remove('active'));
    const panel = document.getElementById(resolvedPanelId);
    const navItem = document.querySelector(`.admin-nav-item[data-panel="${requestedPanelId}"]`);
    if (panel) panel.classList.add('active');
    if (navItem) navItem.classList.add('active');
    document.dispatchEvent(new CustomEvent('admin-panel-activated', { detail: { panelId: resolvedPanelId } }));

    if (currentPanelId === 'panel-chart' && resolvedPanelId !== 'panel-chart') {
        stopChartPreview();
        clearChartRollFeelDigitInput();
        const stSw = document.getElementById('chart-status');
        if (stSw && /^連打感:/.test(stSw.textContent)) stSw.textContent = '';
    }

    if (panelId === 'panel-world-edit' && !worldEditInitialized) {
        worldEditInitialized = true;
        const weOverlay = document.getElementById('world-edit-loading-overlay');
        const weMsg = weOverlay?.querySelector('.world-edit-loading-message');
        if (weOverlay) {
            weOverlay.classList.add('show');
            weOverlay.setAttribute('aria-hidden', 'false');
            if (weMsg) weMsg.textContent = 'ワールド編集を起動しています…';
        }
        importSettingEditorModule()
            .then((m) => m.initSettingEditor())
            .then(() => {
                try {
                    sessionStorage.removeItem(SETTING_EDITOR_MODULE_BUST_KEY);
                } catch (_) { /* ignore */ }
            })
            .catch((e) => {
                console.error('Setting editor init failed:', e);
                worldEditInitialized = false;
                if (weOverlay) {
                    weOverlay.classList.remove('show');
                    weOverlay.setAttribute('aria-hidden', 'true');
                }
            });
    }
    if (panelId === 'panel-user-register') {
        loadUsers();
    }
    if (panelId === 'panel-logs') {
        loadLoginUsers(currentLoginUsersPage);
    }
    if (requestedPanelId === 'panel-chart' && adminChartFeaturesEnabled) {
        loadCharts();
        if (!chartPanelInitialized) {
            chartPanelInitialized = true;
            bindChartPanelEvents();
        }
    }
    if (panelId === 'panel-security') {
        initSecurityPanelOnce();
        loadSecurityPanelChat();
    }
    if (panelId === 'panel-addons') {
        loadAddonCatalog();
    }
    if (panelId === 'panel-aircraft' && !aircraftAdminInitialized) {
        aircraftAdminInitialized = true;
        import('/js/aircraft/admin-panel.js')
            .then((m) => {
                m.initAircraftAdminPanel();
            })
            .catch((e) => {
                console.error('Aircraft admin panel init failed:', e);
                aircraftAdminInitialized = false;
            });
    }
    if (panelId === 'panel-database' && !databaseAdminInitialized) {
        databaseAdminInitialized = true;
        import('/js/database-admin-panel.js')
            .then((m) => {
                m.initDatabaseAdminPanel();
            })
            .catch((e) => {
                console.error('Database admin panel init failed:', e);
                databaseAdminInitialized = false;
            });
    }
    if (panelId === 'panel-avatar-management') {
        void refreshAdminAvatarManagementPanel();
    }
}

/**
 * アドオン設定エントリを .env 風テキスト（KEY=VALUE）に整形する
 * @param {Array<{ key: string, value: string }>} entries
 * @returns {string}
 */
function addonConfigEntriesToEnvText(entries) {
    const list = [...entries].sort((a, b) => String(a.key).localeCompare(String(b.key)));
    return list.map((e) => `${String(e.key)}=${String(e.value ?? '')}`).join('\n');
}

/**
 * .env 風テキストをパースしてキー→値の Map とエラー一覧を返す（空行・# コメントは無視、先頭の export を許容）
 * @param {string} text
 * @returns {{ map: Map<string, string>, errors: Array<{ line: number, message: string }> }}
 */
function parseAddonEnvText(text) {
    const lines = text.split(/\r?\n/);
    /** @type {Map<string, string>} */
    const map = new Map();
    /** @type {Array<{ line: number, message: string }>} */
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        let work = trimmed.replace(/^export\s+/i, '').trimStart();
        const eq = work.indexOf('=');
        if (eq < 0) {
            errors.push({ line: lineNum, message: '「KEY=VALUE」形式である必要があります（= がありません）。' });
            continue;
        }
        const key = work.slice(0, eq).trim();
        const value = work.slice(eq + 1);
        if (!key) {
            errors.push({ line: lineNum, message: 'キーが空です。' });
            continue;
        }
        map.set(key, value);
    }
    return { map, errors };
}

/**
 * アドオン設定モーダル（.env 風エディタ）の DOM を一度だけ生成する
 */
function ensureAddonConfigModal() {
    const existing = document.getElementById('addon-config-modal');
    if (existing) return existing;
    const modal = document.createElement('div');
    modal.id = 'addon-config-modal';
    modal.className = 'addon-config-modal';
    modal.hidden = true;
    modal.innerHTML = `
        <div class="addon-config-dialog" role="dialog" aria-modal="true" aria-labelledby="addon-config-modal-title">
            <div class="addon-config-header">
                <h3 id="addon-config-modal-title">アドオン設定</h3>
                <button type="button" class="btn btn-icon" id="addon-config-modal-close" aria-label="閉じる">×</button>
            </div>
            <p class="hint" id="addon-config-hint-primary">1行に1つ <code>KEY=VALUE</code>（.env と同様）。空行と <code>#</code> 始まりの行はコメントです。保存後は Node 再起動で反映されます。</p>
            <p class="hint" id="addon-config-hint-plugin" hidden></p>
            <div class="addon-config-editor-toolbar">
                <button type="button" class="btn btn-primary" id="addon-config-save-btn">保存</button>
                <button type="button" class="btn btn-secondary" id="addon-config-reload-btn">再読込</button>
            </div>
            <div class="addon-config-editor-wrap">
                <textarea id="addon-config-editor-text" class="addon-config-editor-text" aria-label="アドオン環境変数（KEY=VALUE）" spellcheck="false" wrap="off" rows="16" placeholder="# 例&#10;systemdServiceName=my-service&#10;MY_KEY=value"></textarea>
            </div>
            <p id="addon-config-modal-status" class="status-text" role="status"></p>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.hidden = true;
    });
    document.getElementById('addon-config-modal-close')?.addEventListener('click', () => {
        modal.hidden = true;
    });
    return modal;
}

function setAddonCatalogStatusText(message) {
    const statusEl = document.getElementById('addons-catalog-status');
    if (statusEl) statusEl.textContent = message;
}

async function fetchAddonConfigEntries(pluginId) {
    const res = await fetch(`/admin/addons/config?pluginId=${encodeURIComponent(pluginId)}`, {
        credentials: 'same-origin',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || res.statusText);
    return Array.isArray(body.entries) ? body.entries : [];
}

async function saveAddonConfigEntry(pluginId, key, value) {
    const res = await fetch('/admin/addons/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pluginId, key, value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || res.statusText);
    return body;
}

async function deleteAddonConfigEntry(pluginId, key) {
    const res = await fetch('/admin/addons/config', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pluginId, key }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || res.statusText);
    return body;
}

/**
 * エディタ内容を検証し、DB 上のキーと差分同期する
 * @param {string} pluginId
 * @param {string} text
 * @param {HTMLElement} statusEl
 */
async function saveAddonConfigFromEnvEditor(pluginId, text, statusEl) {
    const { map, errors } = parseAddonEnvText(text);
    if (errors.length) {
        const slice = errors.slice(0, 6);
        statusEl.textContent =
            slice.map((e) => `行${e.line}: ${e.message}`).join(' ') + (errors.length > slice.length ? ' …' : '');
        return;
    }
    let previous;
    try {
        previous = await fetchAddonConfigEntries(pluginId);
    } catch (e) {
        statusEl.textContent = String(e.message || e);
        return;
    }
    const oldMap = new Map(previous.map((p) => [p.key, p.value]));
    try {
        for (const k of oldMap.keys()) {
            if (!map.has(k)) await deleteAddonConfigEntry(pluginId, k);
        }
        for (const [k, v] of map) {
            if (oldMap.get(k) !== v) await saveAddonConfigEntry(pluginId, k, v);
        }
        statusEl.textContent = '保存しました。Node を再起動してください。';
        setAddonCatalogStatusText('アドオン設定を保存しました。Node を再起動してください。');
        const fresh = await fetchAddonConfigEntries(pluginId);
        const ta = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('addon-config-editor-text'));
        if (ta) ta.value = addonConfigEntriesToEnvText(fresh);
    } catch (e) {
        statusEl.textContent = String(e.message || e);
    }
}

async function openAddonConfigModal(pluginId) {
    const modal = ensureAddonConfigModal();
    const titleEl = document.getElementById('addon-config-modal-title');
    const statusEl = document.getElementById('addon-config-modal-status');
    const textEl = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('addon-config-editor-text'));
    const saveBtn = document.getElementById('addon-config-save-btn');
    const reloadBtn = document.getElementById('addon-config-reload-btn');
    if (!titleEl || !statusEl || !textEl || !saveBtn || !reloadBtn) return;

    modal.dataset.pluginId = pluginId;
    titleEl.textContent = `アドオン設定: ${pluginId}`;
    const hintPlugin = document.getElementById('addon-config-hint-plugin');
    if (pluginId === 'avator-scalable-animations') {
        if (hintPlugin) {
            hintPlugin.hidden = false;
            hintPlugin.textContent =
                'このアドオンは行ごとに「定義名=割り当てキー」（例: スクワット=9）と書きます。従来どおり JSON の bindings を config.json や環境変数で渡すこともできます。';
        }
        textEl.placeholder = '# 例: 定義名=割り当てキー\nスクワット=9\nジャンプ=B';
    } else {
        if (hintPlugin) {
            hintPlugin.hidden = true;
            hintPlugin.textContent = '';
        }
        textEl.placeholder = '# 例\nsystemdServiceName=my-service\nMY_KEY=value';
    }
    statusEl.textContent = '読み込み中…';
    modal.hidden = false;

    /** サーバーからエディタへ最新を反映する */
    const refreshFn = async () => {
        const entries = await fetchAddonConfigEntries(pluginId);
        textEl.value = addonConfigEntriesToEnvText(entries);
        statusEl.textContent = entries.length
            ? '編集後は「保存」を押してください。'
            : '設定はまだありません。KEY=VALUE 形式で入力して保存してください。';
    };

    saveBtn.onclick = async () => {
        await saveAddonConfigFromEnvEditor(pluginId, textEl.value, statusEl);
    };

    reloadBtn.onclick = async () => {
        statusEl.textContent = '読み込み中…';
        try {
            await refreshFn();
        } catch (e) {
            statusEl.textContent = String(e.message || e);
        }
    };

    try {
        await refreshFn();
    } catch (e) {
        statusEl.textContent = String(e.message || e);
    }
}

async function loadAddonCatalog() {
    const mount = document.getElementById('addons-catalog-mount');
    const statusEl = document.getElementById('addons-catalog-status');
    if (!mount || !statusEl) return;
    statusEl.textContent = '読み込み中…';
    mount.innerHTML = '';
    try {
        const res = await fetch('/admin/addons', { credentials: 'same-origin' });
        if (!res.ok) {
            const t = await res.text();
            throw new Error(t || res.statusText);
        }
        const data = await res.json();
        const core = data.coreVersion || '?';
        statusEl.textContent = `meta-server ${core} — トグル後は Node 再起動`;

        const table = document.createElement('table');
        table.className = 'players-table';
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>ID</th><th>バージョン</th><th>整合性</th><th>有効（次回起動時）</th><th>設定</th></tr>';
        table.appendChild(thead);
        const tbody = document.createElement('tbody');

        for (const a of data.addons || []) {
            const tr = document.createElement('tr');
            const id = String(a.id || '');
            const tdId = document.createElement('td');
            const code = document.createElement('code');
            code.textContent = id;
            tdId.appendChild(code);
            const tdVer = document.createElement('td');
            tdVer.textContent = a.manifestOk ? String(a.version || '-') : '-';
            const tdOk = document.createElement('td');
            tdOk.textContent = a.manifestOk
                ? (a.engineOk ? 'OK' : `エンジン: ${a.engineReason || 'NG'}`)
                : (a.errors || []).join('; ');
            const tdEn = document.createElement('td');
            const toggleWrap = document.createElement('label');
            toggleWrap.className = 'addon-enabled-toggle';
            toggleWrap.title = '変更後はサーバー再起動が必要です';
            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.className = 'addon-enabled-toggle-input';
            toggle.checked = Boolean(a.enabled);
            const toggleTrack = document.createElement('span');
            toggleTrack.className = 'addon-enabled-toggle-track';
            toggleTrack.setAttribute('aria-hidden', 'true');
            toggle.addEventListener('change', async () => {
                const next = toggle.checked;
                try {
                    const pr = await fetch('/admin/addons/enabled', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ pluginId: id, enabled: next }),
                    });
                    const js = await pr.json().catch(() => ({}));
                    if (!pr.ok) throw new Error(js.error || pr.statusText);
                    statusEl.textContent = js.message || '保存しました。Node を再起動してください。';
                } catch (e) {
                    console.error(e);
                    toggle.checked = !next;
                    statusEl.textContent = String(e.message || e);
                }
            });
            toggleWrap.appendChild(toggle);
            toggleWrap.appendChild(toggleTrack);
            tdEn.appendChild(toggleWrap);
            const tdCfg = document.createElement('td');
            const cfgBtn = document.createElement('button');
            cfgBtn.type = 'button';
            cfgBtn.className = 'btn btn-icon addon-config-open-btn';
            cfgBtn.textContent = '...';
            cfgBtn.title = `${id} の設定を開く`;
            cfgBtn.addEventListener('click', () => {
                void openAddonConfigModal(id);
            });
            tdCfg.appendChild(cfgBtn);
            tr.appendChild(tdId);
            tr.appendChild(tdVer);
            tr.appendChild(tdOk);
            tr.appendChild(tdEn);
            tr.appendChild(tdCfg);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        mount.appendChild(table);
    } catch (e) {
        console.error('loadAddonCatalog', e);
        statusEl.textContent = String(e.message || e);
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
 * 譜面パネル用の全画面ブロック風オーバーレイ（ワールド編集と同様）
 * @param {boolean} show
 * @param {string} [message]
 */
function setChartEditLoader(show, message) {
    const ov = document.getElementById('chart-edit-loading-overlay');
    if (!ov) return;
    const msgEl = ov.querySelector('.chart-edit-loading-message');
    if (message != null && msgEl) msgEl.textContent = message;
    if (show) {
        ov.classList.add('show');
        ov.setAttribute('aria-hidden', 'false');
    } else {
        ov.classList.remove('show');
        ov.setAttribute('aria-hidden', 'true');
    }
}

/**
 * 譜面オーバーレイ表示中に文言だけ差し替える
 * @param {string} message
 */
function setChartEditLoaderMessage(message) {
    const msgEl = document.querySelector('#chart-edit-loading-overlay .chart-edit-loading-message');
    if (msgEl) msgEl.textContent = message;
}

/**
 * 譜面一覧を取得して表示する
 */
async function loadCharts() {
    const statusEl = document.getElementById('chart-status');
    const listEl = document.getElementById('chart-list');
    if (!listEl) return;
    const gen = ++chartListLoadGen;
    setChartEditLoader(true, '譜面一覧を読み込んでいます…');
    try {
        const res = await fetch('/admin/charts');
        if (!res.ok) throw new Error(res.statusText);
        const charts = await res.json();
        if (gen !== chartListLoadGen) return;
        cachedCharts = charts;
        renderChartList(charts);
        if (!selectedChartId) clearChartEditor();
        else {
            updateChartBgmRowUi();
            updateChartPartBgmRowUi();
            setChartEditLoaderMessage('BGM・波形を読み込んでいます…');
            await refreshChartBgmWaveformForSelectedChart({ externalLoader: true });
        }
        updateChartPartIoUi();
        renderChartPartHitSoundCells();
        statusEl.textContent = '';
    } catch (err) {
        statusEl.textContent = '取得失敗: ' + err.message;
        listEl.innerHTML = '';
    } finally {
        if (gen === chartListLoadGen) setChartEditLoader(false);
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
 * ノーツ配列から連打区間 [{start, end, volume, rollStartIndex}, ...] を算出
 * @param {Array<{ type?: string, time?: number, startTime?: number, endTime?: number }>} notes
 */
function getRollSectionsFromNotes(notes) {
    const sorted = notes.map((n, i) => ({ n, i })).sort((a, b) => {
        const ta = a.n.type === 'roll' ? a.n.startTime : a.n.time;
        const tb = b.n.type === 'roll' ? b.n.startTime : b.n.time;
        return (ta ?? 0) - (tb ?? 0);
    });
    const sections = [];
    /** @type {Array<{ time: number, volume: number, rollStartIndex: number }>} */
    const starts = [];
    for (const { n, i } of sorted) {
        if (n.type === 'roll') {
            const s = n.startTime ?? 0;
            const e = n.endTime ?? n.startTime ?? 0;
            const vol = clampNoteVolume(
                /** @type {{ volume?: unknown }} */ (n).volume != null ? /** @type {{ volume?: unknown }} */ (n).volume : 1
            );
            if (e > s) sections.push({ start: s, end: e, volume: vol, rollStartIndex: i, rollEndIndex: i });
        } else if (n.type === 'roll-start') {
            starts.push({ time: n.time ?? 0, volume: getNoteVolumeForEditor(n), rollStartIndex: i });
        } else if (n.type === 'roll-end' && starts.length > 0) {
            const st = starts.shift();
            if (n.time > st.time) {
                sections.push({
                    start: st.time,
                    end: n.time,
                    volume: st.volume,
                    rollStartIndex: st.rollStartIndex,
                    rollEndIndex: i
                });
            }
        }
    }
    return sections;
}

/**
 * 編集グリッドの1セル（16分の時間幅）が連打区間と重なるか
 * @param {number} barIndex
 * @param {number} stepIndex
 * @param {number} bpm
 * @param {Array<{ start: number, end: number }>} rollSections
 * @returns {boolean}
 */
function isMeasureCellOverlappingRollSpan(barIndex, stepIndex, bpm, rollSections) {
    if (!rollSections || rollSections.length === 0) return false;
    const t0 = barStepToTime(barIndex, stepIndex, bpm);
    const stepSec = getBarSec(bpm) / 16;
    const t1 = t0 + stepSec;
    for (const s of rollSections) {
        const a = Number(s.start ?? 0);
        const b = Number(s.end ?? 0);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
        /* [t0,t1) と [a,b] が交わる（終了ノーツのセル左端＝b も含む） */
        if (t1 > a && t0 <= b) return true;
    }
    return false;
}

/**
 * 連打区間内の時刻 t（uniform 秒）に対応するヒット音量（セル別 or 既定）
 * @param {Array<{ type?: string, time?: number, rollCellVolumes?: Record<string, number> }>} notes
 * @param {number} rollStartIndex
 * @param {number} t
 * @param {number} baseBpm
 * @returns {number}
 */
function lookupRollVolumeAtUniformTimeForPreview(notes, rollStartIndex, t, baseBpm) {
    const rs = notes[rollStartIndex];
    if (!rs) return 1;
    const { barIndex, stepIndex } = timeToBarStepUniformSecs(t, baseBpm);
    const key = `${barIndex}:${stepIndex}`;
    const m = rs.rollCellVolumes;
    if (m && typeof m === 'object' && m[key] != null) return clampNoteVolume(Number(m[key]));
    if (rs.type === 'roll-start' || rs.type === 'roll') return getNoteVolumeForEditor(rs);
    return 1;
}

/**
 * ノーツ配列からプレビュー用の音イベント列を作る（don/ka + roll区間は0.1sごとにdon）
 * @param {Array<{ type?: string, time?: number, volume?: unknown }>} notes
 * @param {number} [partNum=1] 1..3（カスタムヒット音のパート振り分け）
 * @returns {Array<{ time: number, type: 'don'|'ka', volume: number, part: number }>}
 */
function buildChartPreviewEventsFromNotes(notes, partNum = 1) {
    const part = Math.min(3, Math.max(1, Number(partNum) || 1));
    const events = [];
    for (const n of notes) {
        if (!n) continue;
        if (n.type === 'don' || n.type === 'ka') {
            const t = Number(n.time ?? 0);
            if (Number.isFinite(t) && t >= 0) {
                events.push({ time: t, type: n.type, volume: getNoteVolumeForEditor(n), part });
            }
        }
    }
    const baseBpm = getChartTempo();
    for (const s of getRollSectionsFromNotes(notes)) {
        const start = Number(s.start ?? 0);
        const end = Number(s.end ?? 0);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const rsi = s.rollStartIndex;
        const step = 0.1;
        for (let t = start; t < end; t += step) {
            const vol = lookupRollVolumeAtUniformTimeForPreview(notes, rsi, t, baseBpm);
            events.push({ time: t, type: 'don', volume: vol, part });
        }
    }
    events.sort((a, b) => a.time - b.time);
    return events;
}

/**
 * editingNotes からプレビュー用の音イベント列を作る（don/ka + roll区間は0.1sごとにdon）
 * @returns {Array<{ time: number, type: 'don'|'ka', volume: number, part: number }>}
 */
function buildChartPreviewEvents() {
    return buildChartPreviewEventsFromNotes(editingNotes, chartEditingPart);
}

/**
 * 1P〜3Pスロットを結合したプレビュー用イベント列（再生前に flushChartPartSlot 済みであること）
 */
function buildChartPreviewEventsAllParts() {
    const merged = [];
    for (let p = 0; p < 3; p++) {
        merged.push(...buildChartPreviewEventsFromNotes(chartPartNoteSlots[p] || [], p + 1));
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
        chip.style.left = '50%';
        if (note.type === 'don' || note.type === 'ka' || note.type === 'roll-start') {
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
 * 選択中譜面のカスタムヒット音をプレビュー用にデコードする（毎回キャッシュを捨てて取り直す）
 * @param {string} chartId
 * @returns {Promise<void>}
 */
async function preloadChartPreviewCustomHitSounds(chartId) {
    chartPreviewHitSoundBuffers.clear();
    if (!chartId || !chartPreviewAudioCtx) return;
    const c = cachedCharts[chartId];
    const ph = c && c.partHitSounds && typeof c.partHitSounds === 'object'
        ? /** @type {Record<string, unknown>} */ (c.partHitSounds)
        : null;
    if (!ph) return;
    for (let part = 1; part <= 3; part++) {
        const arr = ph[String(part)];
        if (!Array.isArray(arr)) continue;
        for (let b = 0; b < HIT_SOUND_VOLUME_BAND_LABELS.length; b++) {
            const cell = arr[b];
            if (!cell || typeof cell !== 'object') continue;
            const o = /** @type {Record<string, unknown>} */ (cell);
            const load = async (/** @type {'don'|'ka'} */ kind, ver) => {
                const key = `${chartId}|${part}|${b}|${kind}`;
                const hitBase = `/chart-bgm/${encodeURIComponent(chartId)}/hits/p${part}-b${b}-${kind}`;
                const ab = await chartBgmFetchArrayBuffer(hitBase, ver).catch(() => null);
                if (!ab) return;
                const buf = await chartPreviewAudioCtx.decodeAudioData(ab.slice(0));
                chartPreviewHitSoundBuffers.set(key, buf);
            };
            if (o.donVersion != null && Number.isFinite(Number(o.donVersion))) {
                await load('don', Number(o.donVersion)).catch(() => {});
            }
            if (o.kaVersion != null && Number.isFinite(Number(o.kaVersion))) {
                await load('ka', Number(o.kaVersion)).catch(() => {});
            }
        }
    }
}

/**
 * プレビュー1音分のバッファ（カスタムがあればそれ、なければ既定 don/ka）
 * @param {string} chartId
 * @param {number} part 1..3
 * @param {'don'|'ka'} evType
 * @param {number} volumeMultiplier
 * @returns {AudioBuffer | null}
 */
function pickPreviewHitAudioBuffer(chartId, part, evType, volumeMultiplier) {
    const kind = evType === 'ka' ? 'ka' : 'don';
    const bucket = chartVolumeToHitBucketForPreview(volumeMultiplier);
    const key = `${chartId}|${part}|${bucket}|${kind}`;
    const custom = chartPreviewHitSoundBuffers.get(key);
    if (custom) return custom;
    return kind === 'ka' ? chartPreviewAudioBuffers.ka : chartPreviewAudioBuffers.don;
}

/**
 * 譜面オブジェクトからパート用BGMメタ（version / originalName）を取る
 * @param {Record<string, unknown>|null|undefined} c
 * @param {number} part 1..3
 * @returns {{ version: number, originalName?: string } | null}
 */
function getChartPartBgmMeta(c, part) {
    const key = String(part);
    const root = c && c.partBgm && typeof c.partBgm === 'object' ? /** @type {Record<string, unknown>} */ (c.partBgm) : null;
    if (!root) return null;
    const cell = root[key];
    if (!cell || typeof cell !== 'object') return null;
    const o = /** @type {Record<string, unknown>} */ (cell);
    const ver = o.version != null ? Number(o.version) : NaN;
    if (!Number.isFinite(ver)) return null;
    return {
        version: ver,
        originalName: o.originalName != null ? String(o.originalName) : ''
    };
}

/**
 * 単一パートのプレビュー用に解決したBGMキャッシュキー（パート専用が無ければ曲のBGM）
 * @param {string|null|undefined} chartId
 * @param {Record<string, unknown>|null|undefined} c
 * @returns {string}
 */
function getResolvedChartBgmCacheKeyForPartPreview(chartId, c) {
    if (!chartId || !c) return '';
    const p = chartEditingPart;
    const pb = getChartPartBgmMeta(c, p);
    if (pb) return `${chartId}:p${p}:${pb.version}`;
    if (c.bgmVersion != null) return `${chartId}:main:${c.bgmVersion}`;
    return '';
}

/**
 * 選択中譜面のBGMを AudioBuffer にデコードする（未設定なら null）
 * @param {{ track?: 'main' | 'part' }} [options] main=曲のBGMのみ。part=編集中パート用、無ければ曲のBGMにフォールバック（WAV 優先）
 * @returns {Promise<AudioBuffer | null>}
 */
async function ensureChartPreviewBgmDecoded(options = {}) {
    const track = options.track === 'main' ? 'main' : 'part';
    const chartId = selectedChartId;
    const c = chartId && cachedCharts[chartId];
    if (!c) return null;

    let cacheKey = '';
    let basePath = '';
    /** @type {string|number|null} */
    let versionForUrl = null;

    if (track === 'main') {
        if (c.bgmVersion == null) return null;
        cacheKey = `${chartId}:main:${c.bgmVersion}`;
        basePath = `/chart-bgm/${encodeURIComponent(chartId)}`;
        versionForUrl = c.bgmVersion;
    } else {
        const p = chartEditingPart;
        const pb = getChartPartBgmMeta(c, p);
        if (pb) {
            cacheKey = `${chartId}:p${p}:${pb.version}`;
            basePath = `/chart-bgm/${encodeURIComponent(chartId)}-p${p}`;
            versionForUrl = pb.version;
        } else if (c.bgmVersion != null) {
            cacheKey = `${chartId}:main:${c.bgmVersion}`;
            basePath = `/chart-bgm/${encodeURIComponent(chartId)}`;
            versionForUrl = c.bgmVersion;
        } else {
            return null;
        }
    }

    if (chartPreviewBgmCache.key === cacheKey && chartPreviewBgmCache.buffer) {
        return chartPreviewBgmCache.buffer;
    }
    if (!chartPreviewAudioCtx) {
        chartPreviewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    setChartEditLoaderMessage('BGMファイルをダウンロードしています…');
    await yieldToBrowser();
    const ab = await chartBgmFetchArrayBuffer(basePath, versionForUrl);
    setChartEditLoaderMessage('BGMをデコードしています（長い曲は数十秒かかることがあります）…');
    await yieldToBrowser();
    const buf = await chartPreviewAudioCtx.decodeAudioData(ab.slice(0));
    chartPreviewBgmCache = { key: cacheKey, buffer: buf };
    return buf;
}

/**
 * BGMキャッシュを破棄（譜面切替・アップロード後）
 */
function invalidateChartBgmPreviewCache() {
    chartPreviewBgmCache = { key: '', buffer: null };
    chartPreviewHitSoundBuffers.clear();
    chartBgmWaveformPeaks = null;
    chartBgmWaveformPeaksCacheKey = '';
    clearMeasureStripWaveformPeaksCache();
}

/** 譜面エディタ下部の BGM 波形用ピーク列（正規化 0〜1） */
let chartBgmWaveformPeaks = /** @type {Float32Array | null} */ (null);
/** chartBgmWaveformPeaks を build したときの getResolvedChartBgmCacheKeyForPartPreview と一致させ、同じ BGM ではピーク再計算しない */
let chartBgmWaveformPeaksCacheKey = '';
/** 波形キャンバスのリサイズ監視 */
let chartBgmWaveformResizeObserver = /** @type {ResizeObserver | null} */ (null);
/** chart-measures-scroll のリサイズで小節下波形を再描画 */
let chartMeasureSpecResizeObserver = /** @type {ResizeObserver | null} */ (null);

/**
 * 小節下ストリップ用にキャンバス中央へ水平軸を描く
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {number} dpr
 */
function strokeChartMeasureWaveMidAxis(ctx, w, h, dpr) {
    const midY = h * 0.5;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();
    ctx.restore();
}

/**
 * 小節下波形の「タイミング」が変わったか判定する署名（ノーツ位置は含めない）
 * @returns {string}
 */
function buildMeasureStripWaveformTimingSignature() {
    const cid = selectedChartId || '';
    const c = cid && cachedCharts[cid] ? cachedCharts[cid] : null;
    const bgmKey = c && cid ? getResolvedChartBgmCacheKeyForPartPreview(cid, c) : '';
    const tempo = getChartTempo();
    const m = chartMeasureBpms && typeof chartMeasureBpms === 'object' ? chartMeasureBpms : {};
    const keys = Object.keys(m)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
    const mp = keys.map((k) => `${k}:${m[String(k)]}`).join(',');
    return `${cid}|${chartEditingPart}|${tempo}|${mp}|${bgmKey}`;
}

/**
 * タイミング署名が変わったら小節下波形のピークキャッシュを捨てる
 * @param {string} timingSig
 */
function syncMeasureStripPeaksCacheSignature(timingSig) {
    if (timingSig !== measureStripWavePeaksCacheSig) {
        measureStripWavePeaksCacheSig = timingSig;
        measureStripWaveNormPeaks.clear();
    }
}

/** 小節下波形ピークキャッシュを全破棄（BGM差し替え・譜面クリア時） */
function clearMeasureStripWaveformPeaksCache() {
    measureStripWavePeaksCacheSig = '';
    measureStripWaveNormPeaks.clear();
}

/**
 * 正規化済みピーク列からミラー棒を描く
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {number} dpr
 * @param {Float32Array} normPeaks 各列 0〜1
 */
function drawMeasureStripBarsFromNorm(ctx, w, h, dpr, normPeaks) {
    const midY = h * 0.5;
    const ampMax = Math.max(2 * dpr, midY - 2 * dpr);
    ctx.fillStyle = '#5effd4';
    ctx.globalAlpha = 1;
    for (let px = 0; px < w; px++) {
        const n = normPeaks[px];
        const amp = n * ampMax;
        if (amp < 0.08 * dpr) continue;
        const half = Math.max(0.5 * dpr, amp);
        const top = midY - half;
        const barH = Math.max(1, half * 2);
        ctx.fillRect(px, top, 1, barH);
    }
    strokeChartMeasureWaveMidAxis(ctx, w, h, dpr);
}

/**
 * 小節下の1キャンバスだけ BGM ミラー波形を描く
 * @param {HTMLCanvasElement} canvas
 */
function paintOneMeasureBgmWaveformCanvas(canvas) {
    const buf = chartPreviewBgmCache.buffer;
    const cacheKey = chartPreviewBgmCache.key;
    const c = selectedChartId ? cachedCharts[selectedChartId] : null;
    const expectKey = c && selectedChartId ? getResolvedChartBgmCacheKeyForPartPreview(selectedChartId, c) : '';
    const bufOk = !!(buf && buf.length > 0 && expectKey && cacheKey === expectKey);
    const duration = bufOk ? buf.duration : 0;
    const sr = bufOk ? buf.sampleRate : 0;
    const bpm = getChartTempo();
    const barIndex = Number(canvas.dataset.barIndex);
    if (!Number.isFinite(barIndex)) return;
    const wrap = canvas.closest('.measure-spec-row');
    const wCss = Math.max(1, Math.floor((wrap && wrap.clientWidth) || canvas.clientWidth || 120));
    const hCss = 30;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(wCss * dpr);
    const h = Math.floor(hCss * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0f1c32';
    ctx.fillRect(0, 0, w, h);
    if (!bufOk || duration <= 0 || sr <= 0) {
        strokeChartMeasureWaveMidAxis(ctx, w, h, dpr);
        return;
    }
    const timingSig = buildMeasureStripWaveformTimingSignature();
    syncMeasureStripPeaksCacheSignature(timingSig);
    const barWKey = `${barIndex}:${w}`;
    const cachedNorm = measureStripWaveNormPeaks.get(barWKey);
    if (cachedNorm && cachedNorm.length === w) {
        drawMeasureStripBarsFromNorm(ctx, w, h, dpr, cachedNorm);
        return;
    }
    const u0 = barStepToTime(barIndex, 0, bpm);
    const u1 = barStepToTime(barIndex + 1, 0, bpm);
    let w0 = wallAtUniform(u0);
    let w1 = wallAtUniform(u1);
    w0 = Math.max(0, Math.min(duration, w0));
    w1 = Math.max(0, Math.min(duration, w1));
    if (w1 <= w0 + 1e-9) {
        strokeChartMeasureWaveMidAxis(ctx, w, h, dpr);
        return;
    }
    const s0 = Math.max(0, Math.min(buf.length - 1, Math.floor(w0 * sr)));
    const s1 = Math.max(s0 + 1, Math.min(buf.length, Math.ceil(w1 * sr)));
    const span = s1 - s0;
    const nCh = buf.numberOfChannels;
    const peaks = new Float32Array(w);
    for (let px = 0; px < w; px++) {
        const a = s0 + Math.floor((px / w) * span);
        const b = s0 + Math.floor(((px + 1) / w) * span);
        const bEx = Math.max(a + 1, b);
        let mxv = 0;
        for (let si = a; si < bEx; si++) {
            let sum = 0;
            for (let ch = 0; ch < nCh; ch++) {
                sum += Math.abs(buf.getChannelData(ch)[si]);
            }
            const mix = sum / nCh;
            if (mix > mxv) mxv = mix;
        }
        peaks[px] = mxv;
    }
    let mx = 0;
    for (let px = 0; px < w; px++) {
        if (peaks[px] > mx) mx = peaks[px];
    }
    const inv = mx > 1e-12 ? 1 / mx : 0;
    const normPeaks = new Float32Array(w);
    for (let px = 0; px < w; px++) {
        normPeaks[px] = peaks[px] * inv;
    }
    measureStripWaveNormPeaks.set(barWKey, normPeaks);
    drawMeasureStripBarsFromNorm(ctx, w, h, dpr, normPeaks);
}

/**
 * 小節インデックスが [fromBar, toBar] のキャンバスのみ波形を描く（末尾に小節が増えたとき用）
 * @param {number} fromBar
 * @param {number} toBar
 */
function paintMeasureStripWaveformBarRange(fromBar, toBar) {
    const grid = document.getElementById('chart-measures-grid');
    if (!grid) return;
    if (!Number.isFinite(fromBar) || !Number.isFinite(toBar) || fromBar > toBar) return;
    grid.querySelectorAll('canvas.measure-spec-canvas').forEach((canvas) => {
        const bi = Number(canvas.dataset.barIndex);
        if (!Number.isFinite(bi)) return;
        if (bi < fromBar || bi > toBar) return;
        paintOneMeasureBgmWaveformCanvas(canvas);
    });
}

/**
 * 全小節下 canvas に BGM ミラー波形を描き、直近描画用の署名を更新する
 */
function paintAllMeasureBgmWaveformCanvases() {
    const grid = document.getElementById('chart-measures-grid');
    if (!grid) return;
    grid.querySelectorAll('canvas.measure-spec-canvas').forEach((canvas) => {
        paintOneMeasureBgmWaveformCanvas(canvas);
    });
    lastMeasureStripWaveformChartId = selectedChartId || null;
    lastMeasureStripWaveformTimingSig = buildMeasureStripWaveformTimingSignature();
    lastMeasureStripWaveformTotalMeasures = grid.querySelectorAll('canvas.measure-spec-canvas').length;
}

/** 小節波形を数件ずつ描いてフレームを挟み、ローダーに進捗を出す（長時間ブロック回避） */
const CHART_MEASURE_WAVEFORM_PROGRESS_BATCH = 4;

/**
 * 小節ごとの BGM 波形 canvas を段階的に描画し、オーバーレイに進捗を表示する
 * @returns {Promise<void>}
 */
async function paintAllMeasureBgmWaveformCanvasesIncremental() {
    const grid = document.getElementById('chart-measures-grid');
    if (!grid) return;
    const canvases = Array.from(grid.querySelectorAll('canvas.measure-spec-canvas'));
    const total = canvases.length;
    if (total === 0) {
        lastMeasureStripWaveformChartId = selectedChartId || null;
        lastMeasureStripWaveformTimingSig = buildMeasureStripWaveformTimingSignature();
        lastMeasureStripWaveformTotalMeasures = 0;
        return;
    }
    setChartEditLoaderMessage(`小節の波形を描画中… 0/${total}`);
    await yieldToBrowser();
    const batch = Math.max(1, CHART_MEASURE_WAVEFORM_PROGRESS_BATCH);
    for (let i = 0; i < total; i++) {
        paintOneMeasureBgmWaveformCanvas(canvases[i]);
        const atBatchEnd = i % batch === batch - 1 || i === total - 1;
        if (atBatchEnd) {
            setChartEditLoaderMessage(`小節の波形を描画中… ${i + 1}/${total}`);
            await yieldToBrowser();
        }
    }
    lastMeasureStripWaveformChartId = selectedChartId || null;
    lastMeasureStripWaveformTimingSig = buildMeasureStripWaveformTimingSignature();
    lastMeasureStripWaveformTotalMeasures = total;
}

/**
 * renderNotesStrip 後: BPM/BGM/パートが変わったときだけ全再描画、小節数だけ増えたら末尾のみ描画
 * @param {number} totalMeasures
 */
function maybeScheduleMeasureStripWaveform(totalMeasures) {
    const tm = Math.max(0, Math.floor(Number(totalMeasures) || 0));
    const cid = selectedChartId || '';
    if (cid !== lastMeasureStripWaveformChartId) {
        lastMeasureStripWaveformChartId = cid;
        lastMeasureStripWaveformTimingSig = '';
        lastMeasureStripWaveformTotalMeasures = 0;
    }
    const sig = buildMeasureStripWaveformTimingSignature();
    if (sig !== lastMeasureStripWaveformTimingSig) {
        lastMeasureStripWaveformTimingSig = sig;
        lastMeasureStripWaveformTotalMeasures = tm;
        schedulePaintMeasureWaveformIdle();
        return;
    }
    if (tm > lastMeasureStripWaveformTotalMeasures) {
        const fromBar = lastMeasureStripWaveformTotalMeasures;
        lastMeasureStripWaveformTotalMeasures = tm;
        requestAnimationFrame(() => {
            paintMeasureStripWaveformBarRange(fromBar, tm - 1);
        });
        return;
    }
    if (tm < lastMeasureStripWaveformTotalMeasures) {
        lastMeasureStripWaveformTotalMeasures = tm;
        schedulePaintMeasureWaveformIdle();
        return;
    }
    // ノーツ操作などでグリッドだけ作り直された場合: AudioBuffer の再サンプリングはピークキャッシュで省略
    requestAnimationFrame(() => {
        paintAllMeasureBgmWaveformCanvases();
    });
}

/**
 * 秒を mm:ss.s（秒の下1桁）表記にする（波形下の曲長表示用）
 * @param {number} sec
 * @returns {string}
 */
function formatChartBgmWaveformDuration(sec) {
    const t = Number(sec);
    if (!Number.isFinite(t) || t < 0) return '00:00.0';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    const whole = Math.floor(s);
    const tenth = Math.min(9, Math.floor((s - whole) * 10 + 1e-6));
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${pad2(m)}:${pad2(whole)}.${tenth}`;
}

/**
 * AudioBuffer から波形バー用のピーク列を作る（全チャンネル合成の最大絶対値）
 * @param {AudioBuffer} buffer
 * @param {number} barCount
 * @returns {Float32Array}
 */
function buildChartBgmWaveformPeaks(buffer, barCount) {
    const nCh = Math.max(1, buffer.numberOfChannels);
    const len = buffer.length;
    const bars = Math.max(32, Math.min(8000, Math.floor(barCount)));
    const peaks = new Float32Array(bars);
    if (len <= 0) return peaks;
    const block = len / bars;
    for (let b = 0; b < bars; b++) {
        const start = Math.floor(b * block);
        const end = Math.min(len, Math.max(start + 1, Math.floor((b + 1) * block)));
        let max = 0;
        for (let i = start; i < end; i++) {
            let sum = 0;
            for (let c = 0; c < nCh; c++) {
                const v = buffer.getChannelData(c)[i];
                sum += Math.abs(v);
            }
            const mix = sum / nCh;
            if (mix > max) max = mix;
        }
        peaks[b] = max;
    }
    let norm = 0;
    for (let i = 0; i < bars; i++) {
        if (peaks[i] > norm) norm = peaks[i];
    }
    if (norm > 1e-8) {
        for (let i = 0; i < bars; i++) peaks[i] /= norm;
    }
    return peaks;
}

/**
 * chartBgmWaveformPeaks を現在のキャンバスサイズで描画する（ミラー波形）
 */
function paintChartBgmWaveformCanvas() {
    const wrap = document.getElementById('chart-bgm-waveform-wrap');
    const canvas = document.getElementById('chart-bgm-waveform-canvas');
    if (!wrap || !canvas || wrap.hidden || !chartBgmWaveformPeaks || chartBgmWaveformPeaks.length < 2) return;
    const rect = wrap.getBoundingClientRect();
    const wCss = Math.max(1, Math.floor(rect.width));
    const hCss = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(wCss * dpr);
    const h = Math.floor(hCss * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const grd = ctx.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#0a1528');
    grd.addColorStop(0.5, '#102238');
    grd.addColorStop(1, '#0c1830');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
    const mid = h / 2;
    const peaks = chartBgmWaveformPeaks;
    const n = peaks.length;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(dpr * 0.5, 0);
    ctx.lineTo(dpr * 0.5, h);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 255, 220, 0.45)';
    ctx.beginPath();
    ctx.moveTo(w - dpr * 0.5, 0);
    ctx.lineTo(w - dpr * 0.5, h);
    ctx.stroke();
    ctx.strokeStyle = '#39ffc8';
    ctx.lineWidth = Math.max(1, dpr);
    const amp = mid * 0.92;
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * (w - 1);
        const a = peaks[i];
        const y1 = mid - a * amp;
        const y2 = mid + a * amp;
        if (y2 - y1 < dpr) continue;
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x, y2);
        ctx.stroke();
    }
}

/**
 * BGM 波形 UI を非表示にし状態をクリアする
 */
function hideChartBgmWaveformUi() {
    chartBgmWaveformPeaks = null;
    chartBgmWaveformPeaksCacheKey = '';
    const wrap = document.getElementById('chart-bgm-waveform-wrap');
    const fn = document.getElementById('chart-bgm-waveform-filename');
    const dur = document.getElementById('chart-bgm-waveform-duration');
    if (wrap) wrap.hidden = true;
    if (fn) fn.textContent = '';
    if (dur) dur.textContent = '';
}

/**
 * 選択中譜面に BGM があるときサーバーからデコードして波形を表示する
 * @param {{ externalLoader?: boolean }} [options] true のとき呼び出し側がオーバーレイ表示済み。デコード〜ピーク計算の間だけ文言を更新する
 */
async function refreshChartBgmWaveformForSelectedChart(options = {}) {
    const externalLoader = options.externalLoader === true;
    const wrap = document.getElementById('chart-bgm-waveform-wrap');
    const fnEl = document.getElementById('chart-bgm-waveform-filename');
    const durEl = document.getElementById('chart-bgm-waveform-duration');
    const c = selectedChartId && cachedCharts[selectedChartId];
    const resolvedKey = c && selectedChartId ? getResolvedChartBgmCacheKeyForPartPreview(selectedChartId, c) : '';
    if (!wrap || !c || !resolvedKey) {
        hideChartBgmWaveformUi();
        return;
    }
    const bufCached = chartPreviewBgmCache.buffer;
    if (
        chartBgmWaveformPeaksCacheKey === resolvedKey
        && chartBgmWaveformPeaks
        && chartBgmWaveformPeaks.length >= 2
        && chartPreviewBgmCache.key === resolvedKey
        && bufCached
        && bufCached.length > 0
    ) {
        if (fnEl) {
            const pb = getChartPartBgmMeta(c, chartEditingPart);
            const name = pb
                ? (pb.originalName ? pb.originalName : `${chartEditingPart}P BGM.mp3`)
                : (c.bgmOriginalName ? String(c.bgmOriginalName) : 'BGM.mp3');
            fnEl.textContent = name;
        }
        if (durEl) durEl.textContent = formatChartBgmWaveformDuration(bufCached.duration);
        wrap.hidden = false;
        requestAnimationFrame(() => {
            paintChartBgmWaveformCanvas();
        });
        return;
    }
    let openedLoader = false;
    if (!externalLoader) {
        setChartEditLoader(true, '音声ファイルを読み込んでいます…');
        openedLoader = true;
    } else {
        setChartEditLoaderMessage('BGM・波形の準備をしています…');
    }
    try {
        const buf = await ensureChartPreviewBgmDecoded({ track: 'part' });
        if (!buf || buf.length === 0) {
            hideChartBgmWaveformUi();
            return;
        }
        setChartEditLoaderMessage('波形のピークを計算しています…');
        await yieldToBrowser();
        const scrollEl = document.getElementById('chart-measures-scroll');
        const wPx = Math.max(
            200,
            Math.floor(scrollEl?.getBoundingClientRect().width || 0) || wrap.offsetWidth || 600
        );
        chartBgmWaveformPeaks = buildChartBgmWaveformPeaks(buf, Math.floor(wPx * 2));
        chartBgmWaveformPeaksCacheKey = resolvedKey;
        if (fnEl) {
            const pb = getChartPartBgmMeta(c, chartEditingPart);
            const name = pb
                ? (pb.originalName ? pb.originalName : `${chartEditingPart}P BGM.mp3`)
                : (c.bgmOriginalName ? String(c.bgmOriginalName) : 'BGM.mp3');
            fnEl.textContent = name;
        }
        if (durEl) durEl.textContent = formatChartBgmWaveformDuration(buf.duration);
        wrap.hidden = false;
        setChartEditLoaderMessage('プレビュー用の波形を描画しています…');
        await yieldToBrowser();
        paintChartBgmWaveformCanvas();
        await paintAllMeasureBgmWaveformCanvasesIncremental();
    } catch {
        hideChartBgmWaveformUi();
    } finally {
        if (openedLoader) setChartEditLoader(false);
    }
}

let chartSaveToastTimer = 0;

/**
 * 譜面保存成功など短いメッセージを画面下部に表示する
 * @param {string} message
 */
function showChartSaveToast(message) {
    const el = document.getElementById('admin-chart-save-toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    if (chartSaveToastTimer) clearTimeout(chartSaveToastTimer);
    chartSaveToastTimer = setTimeout(() => {
        chartSaveToastTimer = 0;
        el.hidden = true;
        el.textContent = '';
    }, 2800);
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
 * パート用BGM行（現在の編集パート）の表示を更新する
 */
function updateChartPartBgmRowUi() {
    const statusEl = document.getElementById('chart-part-bgm-status');
    const btnImport = document.getElementById('btn-chart-part-bgm-import');
    const btnRemove = document.getElementById('btn-chart-part-bgm-remove');
    const c = selectedChartId && cachedCharts[selectedChartId];
    if (!statusEl) return;
    if (!selectedChartId || !c) {
        statusEl.textContent = '譜面を選択してください';
        if (btnImport) btnImport.disabled = true;
        if (btnRemove) btnRemove.disabled = true;
        return;
    }
    if (btnImport) btnImport.disabled = false;
    const meta = getChartPartBgmMeta(c, chartEditingPart);
    if (meta) {
        statusEl.textContent = meta.originalName ? meta.originalName : 'MP3設定済み';
        if (btnRemove) btnRemove.disabled = false;
    } else {
        statusEl.textContent = '未設定（曲のBGMにフォールバック）';
        if (btnRemove) btnRemove.disabled = true;
    }
}

/**
 * 編集パート単位のエクスポート・インポートボタンの有効/無効を更新する
 */
function updateChartPartIoUi() {
    const exp = document.getElementById('btn-export-chart-part-json');
    const imp = document.getElementById('btn-import-chart-part-json');
    const ok = !!selectedChartId;
    if (exp) exp.disabled = !ok;
    if (imp) imp.disabled = !ok;
}

/**
 * ヒット音テーブル行を一度だけ生成する
 */
function ensureChartHitSoundTableBuilt() {
    const tb = document.getElementById('chart-hit-sound-tbody');
    if (!tb || tb.dataset.built === '1') return;
    tb.innerHTML = '';
    for (let b = 0; b < 5; b++) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <th scope="row">${HIT_SOUND_VOLUME_BAND_LABELS[b]}</th>
            <td>
                <span class="chart-hit-filename" id="chart-hit-filename-don-${b}">—</span>
                <div class="chart-hit-btn-row">
                    <button type="button" class="chart-action-btn chart-hit-import" data-bucket="${b}" data-kind="don">MP3</button>
                    <button type="button" class="chart-action-btn chart-hit-remove" data-bucket="${b}" data-kind="don" disabled>削除</button>
                </div>
            </td>
            <td>
                <span class="chart-hit-filename" id="chart-hit-filename-ka-${b}">—</span>
                <div class="chart-hit-btn-row">
                    <button type="button" class="chart-action-btn chart-hit-import" data-bucket="${b}" data-kind="ka">MP3</button>
                    <button type="button" class="chart-action-btn chart-hit-remove" data-bucket="${b}" data-kind="ka" disabled>削除</button>
                </div>
            </td>`;
        tb.appendChild(tr);
    }
    tb.dataset.built = '1';
}

/**
 * 編集中パートのヒット音割当表示を更新する
 */
function renderChartPartHitSoundCells() {
    ensureChartHitSoundTableBuilt();
    const section = document.getElementById('chart-hit-sounds-section');
    const c = selectedChartId ? cachedCharts[selectedChartId] : null;
    if (section) {
        const ok = !!selectedChartId;
        section.style.opacity = ok ? '1' : '0.45';
        section.style.pointerEvents = ok ? '' : 'none';
    }
    const part = chartEditingPart;
    const ph = c && c.partHitSounds && typeof c.partHitSounds === 'object'
        ? /** @type {Record<string, unknown>} */ (c.partHitSounds)[String(part)]
        : null;
    const arr = Array.isArray(ph) ? ph : [];
    for (let b = 0; b < 5; b++) {
        const raw = arr[b];
        const cell = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
        const donName = cell.donOriginalName != null ? String(cell.donOriginalName) : '';
        const kaName = cell.kaOriginalName != null ? String(cell.kaOriginalName) : '';
        const donHas = cell.donVersion != null && Number.isFinite(Number(cell.donVersion));
        const kaHas = cell.kaVersion != null && Number.isFinite(Number(cell.kaVersion));
        const elDon = document.getElementById(`chart-hit-filename-don-${b}`);
        const elKa = document.getElementById(`chart-hit-filename-ka-${b}`);
        if (elDon) elDon.textContent = donHas ? donName || 'ドン MP3' : '—';
        if (elKa) elKa.textContent = kaHas ? kaName || 'カッ MP3' : '—';
        const tb = document.getElementById('chart-hit-sound-tbody');
        if (tb) {
            tb.querySelectorAll(`button.chart-hit-remove[data-bucket="${b}"]`).forEach((btn) => {
                const k = btn.getAttribute('data-kind');
                const has = k === 'ka' ? kaHas : donHas;
                /** @type {HTMLButtonElement} */ (btn).disabled = !selectedChartId || !has;
            });
        }
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
 * @param {Array<{ time: number, type: 'don'|'ka', volume?: number, part?: number }>} events
 * @param {number} totalDur
 * @param {number} [startFromSec=0]
 * @param {{ allPartsLayout?: boolean, audioMode?: 'all'|'notesOnly'|'bgmOnly', bgmTrack?: 'main'|'part' }} [options]
 */
async function runChartPreviewPlayback(events, totalDur, startFromSec = 0, options = {}) {
    if (!selectedChartId) return;
    const allPartsLayout = Boolean(options.allPartsLayout);
    const audioMode = options.audioMode === 'notesOnly' || options.audioMode === 'bgmOnly' ? options.audioMode : 'all';
    const bgmTrack = options.bgmTrack === 'main' ? 'main' : 'part';
    stopChartPreview();
    const runToken = chartPreviewCancelToken;
    const statusEl = document.getElementById('chart-status');
    try {
        await ensureChartPreviewAudioLoaded();
    } catch (e) {
        if (statusEl) statusEl.textContent = 'プレビュー音の読み込みに失敗: ' + e.message;
        return;
    }
    if (runToken !== chartPreviewCancelToken) {
        updateChartPreviewControlsUI();
        return;
    }

    try {
        await preloadChartPreviewCustomHitSounds(selectedChartId);
    } catch {
        /* カスタム無し・取得失敗時は既定音のみ */
    }
    if (runToken !== chartPreviewCancelToken) {
        updateChartPreviewControlsUI();
        return;
    }

    /** @type {AudioBuffer | null} */
    let bgmBuffer = null;
    if (audioMode !== 'notesOnly') {
        try {
            bgmBuffer = await ensureChartPreviewBgmDecoded({ track: bgmTrack });
        } catch (e) {
            bgmBuffer = null;
            if (statusEl && audioMode === 'all') {
                const cc = cachedCharts[selectedChartId];
                let expected = false;
                if (cc) {
                    expected = bgmTrack === 'main'
                        ? cc.bgmVersion != null
                        : (getChartPartBgmMeta(cc, chartEditingPart) != null || cc.bgmVersion != null);
                }
                if (expected) statusEl.textContent = 'BGMを再生できません（ドン・カのみ再生）';
            }
        }
    }
    if (runToken !== chartPreviewCancelToken) {
        updateChartPreviewControlsUI();
        return;
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
    if (runToken !== chartPreviewCancelToken) {
        updateChartPreviewControlsUI();
        return;
    }

    if (allPartsLayout) {
        enterChartMultiPartPlaybackView();
        syncMultiPartPlaybackWindowDom(startSec);
    }

    const baseTime = chartPreviewAudioCtx.currentTime + 0.05;

    const sources = [];
    if (audioMode !== 'notesOnly' && bgmBuffer && bgmBuffer.duration > 0) {
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
    if (audioMode !== 'bgmOnly') {
        for (const ev of events) {
            const part = ev.part != null ? Math.min(3, Math.max(1, Math.floor(Number(ev.part)))) : chartEditingPart;
            const vol = clampNoteVolume(ev.volume != null ? ev.volume : 1);
            const buf = pickPreviewHitAudioBuffer(selectedChartId, part, ev.type === 'ka' ? 'ka' : 'don', vol);
            if (!buf) continue;
            const t = Number(ev.time ?? 0);
            if (!Number.isFinite(t) || t < startSec || t > totalDur + 0.001) continue;
            const gain = chartPreviewAudioCtx.createGain();
            gain.gain.value = vol;
            const src = chartPreviewAudioCtx.createBufferSource();
            src.buffer = buf;
            src.connect(gain);
            gain.connect(chartPreviewAudioCtx.destination);
            const evWall = wallAtUniform(t);
            src.start(baseTime + (evWall - wallStart));
            sources.push(src);
        }
    }

    if (runToken !== chartPreviewCancelToken) {
        for (const s of sources) {
            try { s.stop(); } catch { /* noop */ }
            try { s.disconnect(); } catch { /* noop */ }
        }
        updateChartPreviewControlsUI();
        return;
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
 * @param {{ audioMode?: 'all'|'notesOnly'|'bgmOnly' }} [options] all=ノーツ+BGM、notesOnly=ヒット音のみ、bgmOnly=BGMのみ
 */
async function playChartPreview(startFromSec = 0, options = {}) {
    const events = buildChartPreviewEvents();
    const totalDur = getChartPreviewDurationSec();
    const audioMode = options.audioMode === 'notesOnly' || options.audioMode === 'bgmOnly' ? options.audioMode : 'all';
    await runChartPreviewPlayback(events, totalDur, startFromSec, { audioMode, bgmTrack: 'part' });
}

/**
 * 1P・2P・3P をまとめて再生（未保存の編集内容はスロットへ反映してから再生）
 * @param {number} [startFromSec=0]
 */
async function playChartPreviewAllParts(startFromSec = 0) {
    flushChartPartSlot();
    const events = buildChartPreviewEventsAllParts();
    const totalDur = getChartPreviewDurationSecAllParts();
    await runChartPreviewPlayback(events, totalDur, startFromSec, { allPartsLayout: true, bgmTrack: 'main' });
}

/**
 * プレビュー停止
 */
function stopChartPreview() {
    chartPreviewCancelToken++;
    const wasAllParts = chartPreviewState.allPartsPlayback;
    if (chartPreviewState.rafId) cancelAnimationFrame(chartPreviewState.rafId);
    chartPreviewState.rafId = 0;
    if (chartPreviewState.sources && chartPreviewState.sources.length > 0) {
        for (const s of chartPreviewState.sources) {
            try { s.stop(); } catch { /* noop */ }
            try { s.disconnect(); } catch { /* noop */ }
        }
    }
    chartPreviewState.sources = [];
    if (chartPreviewAudioCtx && chartPreviewAudioCtx.state === 'running') {
        try { chartPreviewAudioCtx.suspend(); } catch { /* noop */ }
    }
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
    if (id === selectedChartId) return;
    if (isChartEditorDirty()) {
        if (!confirm('譜面を編集中です（未保存の変更があります）。別の譜面に切り替えますか？')) {
            return;
        }
    }
    stopChartPreview();
    clearChartRollFeelDigitInput();
    selectedChartId = id;
    const c = cachedCharts[id];
    const btnDelete = document.getElementById('btn-delete-chart');
    if (btnDelete) btnDelete.disabled = !id;
    renderChartList(cachedCharts);
    const myGen = ++chartSelectLoadGen;
    setChartEditLoader(true, '譜面を読み込んでいます…');
    requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
            try {
                if (myGen !== chartSelectLoadGen) return;
                if (c) {
                    setChartEditLoaderMessage('ノーツと小節グリッドを準備しています…');
                    await yieldToBrowser();
                    loadChartIntoEditor(c, { skipBgmWaveform: true });
                    setChartEditLoaderMessage('BGM・波形を読み込んでいます…');
                    await yieldToBrowser();
                    await refreshChartBgmWaveformForSelectedChart({ externalLoader: true });
                } else {
                    clearChartEditor();
                }
            } finally {
                if (myGen === chartSelectLoadGen) setChartEditLoader(false);
            }
        });
    });
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
            const rv = /** @type {{ volume?: unknown }} */ (n).volume;
            const vol = rv != null ? clampNoteVolume(rv) : 1;
            const rcv = /** @type {{ rollCellVolumes?: unknown }} */ (n).rollCellVolumes;
            const start = /** @type {{ type: string, time: unknown, volume: number, rollCellVolumes?: Record<string, number> }} */ ({
                type: 'roll-start',
                time: n.startTime,
                volume: vol
            });
            if (rcv && typeof rcv === 'object' && !Array.isArray(rcv)) {
                start.rollCellVolumes = { .../** @type {Record<string, number>} */ (rcv) };
            }
            return [
                start,
                { type: 'roll-end', time: n.endTime }
            ];
        }
        return [n];
    });
}

/**
 * パート単位インポートJSONから notes 配列を取り出す（トップレベル配列・{ notes } を許容）
 * @param {unknown} root
 * @returns {unknown[] | null}
 */
function extractNotesArrayFromPartImportJson(root) {
    if (Array.isArray(root)) return root;
    if (!root || typeof root !== 'object') return null;
    const o = /** @type {Record<string, unknown>} */ (root);
    if (Array.isArray(o.notes)) return o.notes;
    return null;
}

/**
 * パート用JSONを解析し、現在の編集パートへノーツを読み込む（サーバーへの保存は別途「保存」）
 * @param {string} jsonText
 * @param {HTMLElement | null} statusEl
 * @returns {{ ok: boolean, message: string }}
 */
function importChartPartFromJsonText(jsonText, statusEl) {
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        const msg = 'JSONの解析に失敗しました';
        if (statusEl) statusEl.textContent = msg;
        return { ok: false, message: msg };
    }
    const arr = extractNotesArrayFromPartImportJson(parsed);
    if (arr == null) {
        const msg = 'notes 配列がありません（パート用エクスポートJSON、またはノーツの配列JSONを指定してください）';
        if (statusEl) statusEl.textContent = msg;
        return { ok: false, message: msg };
    }
    stopChartPreview();
    clearChartRollFeelDigitInput();
    flushChartPartSlot();
    const editorNotes = chartFieldToEditorNotes({ notes: arr }, 'notes');
    const slot = chartEditingPart - 1;
    chartPartNoteSlots[slot] = editorNotes;
    editingNotes = editorNotes.slice();
    selectedNoteIndex = -1;
    selectedNoteIndices.clear();
    renderNotesStrip();
    updateChartPreviewControlsUI();
    const msg = `${chartEditingPart}P にノーツを読み込みました（「保存」でサーバーに反映）`;
    if (statusEl) statusEl.textContent = msg;
    return { ok: true, message: msg };
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
    clearChartRollFeelDigitInput();
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
    renderChartPartHitSoundCells();
    updateChartPartBgmRowUi();
    void (async () => {
        await refreshChartBgmWaveformForSelectedChart();
    })();
}

/**
 * 譜面を右側の編集エリアに読み込む
 * @param {{ id: string, name?: string, notes?: unknown[], notes2?: unknown[], notes3?: unknown[], difficulty?: number|string|null, tempo?: number|null }} chart
 * @param {{ skipBgmWaveform?: boolean }} [options] true のとき BGM 波形の再取得は呼び出し側で行う
 */
function loadChartIntoEditor(chart, options = {}) {
    const skipBgmWaveform = options.skipBgmWaveform === true;
    hideChartBgmWaveformUi();
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
    updateChartPartBgmRowUi();
    updateChartPartIoUi();
    renderChartPartHitSoundCells();
    updateChartPreviewControlsUI();
    if (!skipBgmWaveform) {
        void refreshChartBgmWaveformForSelectedChart();
    }
    commitChartEditorSavedBaseline();
}

/**
 * 「保存」ボタンと同じ内容の譜面 PUT 用ペイロードを組み立てる（譜面未選択時は null）
 * @returns {{ name: string, notes: unknown[], notes2: unknown[], notes3: unknown[], partNames: { 1: string, 2: string, 3: string }, difficulty: string | null, tempo: number | null, endTime: number | null, measureBpms: Record<string, number> } | null}
 */
function getChartEditorPutPayload() {
    if (!selectedChartId) return null;
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
    flushChartPartSlot();
    const n1 = chartPartNoteSlots[0];
    const n2 = chartPartNoteSlots[1];
    const n3 = chartPartNoteSlots[2];
    const pn1 = document.getElementById('chart-part-name-1')?.value?.trim?.() || '';
    const pn2 = document.getElementById('chart-part-name-2')?.value?.trim?.() || '';
    const pn3 = document.getElementById('chart-part-name-3')?.value?.trim?.() || '';
    const partNames = { 1: pn1.slice(0, 20), 2: pn2.slice(0, 20), 3: pn3.slice(0, 20) };
    return {
        name: name || selectedChartId,
        notes: n1,
        notes2: n2,
        notes3: n3,
        partNames,
        difficulty,
        tempo,
        endTime,
        measureBpms: { ...chartMeasureBpms }
    };
}

/**
 * 譜面 PUT 相当オブジェクトの JSON 文字列（ダーティ判定用）
 * @returns {string}
 */
function chartEditorPutPayloadJson() {
    const p = getChartEditorPutPayload();
    return p ? JSON.stringify(p) : '';
}

/**
 * 直近の保存／読み込み時点のペイロードを現在の編集内容で記録する
 */
function commitChartEditorSavedBaseline() {
    chartEditorSavedPayloadJson = chartEditorPutPayloadJson();
}

/**
 * 譜面パネルで未保存の編集があるか
 * @returns {boolean}
 */
function isChartEditorDirty() {
    if (!selectedChartId) return false;
    const panel = document.getElementById('panel-chart');
    if (!panel || panel.dataset.hasChart !== 'true') return false;
    return chartEditorPutPayloadJson() !== chartEditorSavedPayloadJson;
}

/**
 * 編集エリアをクリアする（譜面未選択時）
 */
function clearChartEditor() {
    lastMeasureStripWaveformChartId = null;
    lastMeasureStripWaveformTimingSig = '';
    lastMeasureStripWaveformTotalMeasures = 0;
    clearMeasureStripWaveformPeaksCache();
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
    updateChartPartBgmRowUi();
    updateChartPartIoUi();
    renderChartPartHitSoundCells();
    updateChartPreviewControlsUI();
    hideChartBgmWaveformUi();
    chartEditorSavedPayloadJson = '';
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
 * 編集グリッド上のノーツ表示用: 小節・16分マスは床取りし、マス内の位置 [0,1) を返す（半コマずれの描画用）
 * @param {number} timeSec
 * @param {number} bpm
 * @returns {{ barIndex: number, stepIndex: number, frac: number }}
 */
function editorTimeToBarStepAndFrac(timeSec, bpm) {
    const t = Math.max(0, Number(timeSec) || 0);
    const b = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Number(bpm) : getChartTempo();
    const sec = getBarSec(b);
    if (sec <= 0) return { barIndex: 0, stepIndex: 0, frac: 0 };
    const barIndex = Math.floor(t / sec);
    const within = t - barIndex * sec;
    const stepSec = sec / 16;
    if (stepSec <= 0) return { barIndex: 0, stepIndex: 0, frac: 0 };
    const stepFloat = Math.min(within / stepSec, 16 - 1e-9);
    const stepIndex = Math.min(15, Math.max(0, Math.floor(stepFloat)));
    let frac = stepFloat - stepIndex;
    if (!Number.isFinite(frac)) frac = 0;
    if (frac < 0) frac = 0;
    if (frac >= 1) frac = 1 - 1e-6;
    return { barIndex, stepIndex, frac };
}

/**
 * 譜面編集エリアを小節グリッドで再描画する（4/4・1小節16分割）
 */
function renderNotesStrip() {
    if (chartNotesStripRafId) {
        cancelAnimationFrame(chartNotesStripRafId);
        chartNotesStripRafId = 0;
    }
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

    const rollSectionsHighlight = getRollSectionsFromNotes(editingNotes);

    grid.innerHTML = '';
    for (let barIndex = 0; barIndex < totalMeasures; barIndex++) {
        const card = document.createElement('div');
        card.className = 'measure-card staff-measure';
        card.dataset.barIndex = String(barIndex);

        const header = document.createElement('div');
        header.className = 'measure-header staff-header';

        const playHost = document.createElement('div');
        playHost.className = 'measure-preview-play-host';

        const previewPlayBtn = document.createElement('button');
        previewPlayBtn.type = 'button';
        previewPlayBtn.className = 'measure-preview-play-btn';
        previewPlayBtn.setAttribute('aria-label', `第${barIndex + 1}小節からすべて再生`);
        previewPlayBtn.title = 'すべて再生（クリック）。ホバーでノーツのみ／曲のみも選択可';
        previewPlayBtn.innerHTML = '<i class="bi bi-play-fill" aria-hidden="true"></i>';
        previewPlayBtn.disabled = !selectedChartId;
        previewPlayBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selectedChartId) return;
            const t0 = barStepToTime(barIndex, 0, getChartTempo());
            playChartPreview(t0);
        });
        playHost.appendChild(previewPlayBtn);

        const playMenu = document.createElement('div');
        playMenu.className = 'measure-preview-play-menu';
        playMenu.setAttribute('role', 'group');
        playMenu.setAttribute('aria-label', `第${barIndex + 1}小節の再生`);

        /**
         * 小節メニュー用: 指定モードでその小節頭からプレビュー再生する
         * @param {'all'|'notesOnly'|'bgmOnly'} mode
         */
        const startMeasurePreview = (mode) => {
            if (!selectedChartId) return;
            const t0 = barStepToTime(barIndex, 0, getChartTempo());
            playChartPreview(t0, { audioMode: mode });
        };

        const mkMenuBtn = (label, mode) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'measure-preview-play-menu-item';
            b.textContent = label;
            b.disabled = !selectedChartId;
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                startMeasurePreview(mode);
            });
            return b;
        };
        playMenu.appendChild(mkMenuBtn('すべて再生', 'all'));
        playMenu.appendChild(mkMenuBtn('ノーツを再生', 'notesOnly'));
        playMenu.appendChild(mkMenuBtn('曲を再生', 'bgmOnly'));
        playHost.appendChild(playMenu);
        header.appendChild(playHost);

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
            if (chartMeasureBpmInputDebounceTimer) {
                clearTimeout(chartMeasureBpmInputDebounceTimer);
                chartMeasureBpmInputDebounceTimer = 0;
            }
            chartMeasureBpmInputDebounceTimer = setTimeout(() => {
                chartMeasureBpmInputDebounceTimer = 0;
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
            }, 100);
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
        const specRow = document.createElement('div');
        specRow.className = 'measure-spec-row';
        const specCv = document.createElement('canvas');
        specCv.className = 'measure-spec-canvas';
        specCv.dataset.barIndex = String(barIndex);
        specCv.setAttribute('aria-hidden', 'true');
        specRow.appendChild(specCv);
        card.appendChild(specRow);
        grid.appendChild(card);
    }

    const cellMap = new Map();
    grid.querySelectorAll('.measure-cell').forEach((cell) => {
        cellMap.set(`${cell.dataset.barIndex}:${cell.dataset.stepIndex}`, cell);
    });

    editingNotes.forEach((note, i) => {
        const time = note.type === 'roll' ? (note.startTime ?? 0) : (note.time ?? 0);
        const { barIndex, stepIndex, frac } = editorTimeToBarStepAndFrac(time, bpm);
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
        // マス左を 0%・右端を 100% とし、frac はマス内の時間位置（0〜1）で線形配置（半コマずれが中央基準より直感的）
        const leftPct = Math.max(0, Math.min(100, frac * 100));
        chip.style.left = `${leftPct}%`;
        chip.style.transform = 'translate(-50%, -50%)';
        if (note.type === 'don' || note.type === 'ka' || note.type === 'roll-start' || note.type === 'roll') {
            const vol = getNoteVolumeForEditor(note);
            chip.style.height = `${Math.max(4, 16 * vol)}px`;
            chip.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                clearChartRollFeelDigitInput();
                const stChip = document.getElementById('chart-status');
                if (stChip && /^連打感:/.test(stChip.textContent)) stChip.textContent = '';
                const idx = parseInt(chip.dataset.index, 10);
                const volEditableInSelection = [...selectedNoteIndices].filter((i) => {
                    const n = editingNotes[i];
                    return n && (n.type === 'don' || n.type === 'ka' || n.type === 'roll-start' || n.type === 'roll');
                });
                const volumeResizeIndices = (selectedNoteIndices.has(idx) && volEditableInSelection.length > 0)
                    ? volEditableInSelection
                    : [idx];
                const startY = e.clientY;
                const startX = e.clientX;
                let didVolumeDrag = false;
                /** @type {'pending'|'volume'|'hslide'|'done'} */
                let noteDragMode = 'pending';
                let appliedHalfAccum = 0;
                const cellEl = chip.closest('.measure-cell');
                chartVolumeDragPointerId = e.pointerId;
                try {
                    chip.setPointerCapture(e.pointerId);
                } catch {
                    /* noop */
                }
                const hSlideIndices = (selectedNoteIndices.has(idx) && selectedNoteIndices.size > 0)
                    ? [...selectedNoteIndices].filter((i) => {
                        const n = editingNotes[i];
                        return n && (n.type === 'don' || n.type === 'ka' || n.type === 'roll-start' || n.type === 'roll');
                    })
                    : [idx];
                const moveIndices = hSlideIndices.length > 0 ? hSlideIndices : [idx];
                let hslideWinActive = false;
                const removeWinHSlide = () => {
                    window.removeEventListener('pointermove', onWinMove, true);
                    window.removeEventListener('pointerup', onWinUpWrap, true);
                    window.removeEventListener('pointercancel', onWinUpWrap, true);
                };
                const onWinMove = (ev) => {
                    if (noteDragMode !== 'hslide') return;
                    const cw = cellEl?.getBoundingClientRect().width || 24;
                    const halfPx = Math.max(4, cw * 0.5);
                    // 四捨五入よりゼロ方向への切り捨て（ドラッグ開始付近でのブレを抑える）
                    const rawHalf = Math.trunc((ev.clientX - startX) / halfPx);
                    const d = rawHalf - appliedHalfAccum;
                    if (d === 0) return;
                    if (tryMoveSelectedNotesHorizontally(d, { halfStep: true })) {
                        appliedHalfAccum = rawHalf;
                        flushChartPartSlot();
                        scheduleRenderNotesStrip();
                    }
                };
                const onWinUpWrap = () => {
                    if (!hslideWinActive) return;
                    hslideWinActive = false;
                    removeWinHSlide();
                    chartVolumeDragPointerId = -1;
                    noteDragMode = 'done';
                    flushChartPartSlot();
                    renderNotesStrip();
                };
                const onMove = (ev) => {
                    if (ev.pointerId !== chartVolumeDragPointerId) return;
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    if (noteDragMode === 'pending' && Math.hypot(dx, dy) >= CHART_NOTE_VOLUME_DRAG_THRESHOLD_PX) {
                        if ((ev.ctrlKey || ev.metaKey) && Math.abs(dx) > Math.abs(dy)) {
                            noteDragMode = 'hslide';
                            ev.preventDefault();
                            clearChartRollFeelDigitInput();
                            const stH = document.getElementById('chart-status');
                            if (stH && /^連打感:/.test(stH.textContent)) stH.textContent = '';
                            selectedNoteIndex = idx;
                            selectedNoteIndices = new Set(moveIndices);
                            chip.removeEventListener('pointermove', onMove);
                            chip.removeEventListener('pointerup', onUp);
                            chip.removeEventListener('pointercancel', onUp);
                            try {
                                chip.releasePointerCapture(ev.pointerId);
                            } catch {
                                /* noop */
                            }
                            chartVolumeDragPointerId = -1;
                            hslideWinActive = true;
                            window.addEventListener('pointermove', onWinMove, true);
                            window.addEventListener('pointerup', onWinUpWrap, true);
                            window.addEventListener('pointercancel', onWinUpWrap, true);
                            onWinMove(ev);
                            return;
                        }
                        noteDragMode = 'volume';
                        didVolumeDrag = true;
                        ev.preventDefault();
                        clearChartRollFeelDigitInput();
                        const stVm = document.getElementById('chart-status');
                        if (stVm && /^連打感:/.test(stVm.textContent)) stVm.textContent = '';
                        selectedNoteIndex = idx;
                        if (volumeResizeIndices.length <= 1) {
                            selectedNoteIndices = new Set([idx]);
                        }
                    }
                    if (noteDragMode !== 'volume') return;
                    const nMove = editingNotes[idx];
                    const volRect = (nMove && (nMove.type === 'roll-start' || nMove.type === 'roll'))
                        ? (chip.closest('.measure-cells')?.getBoundingClientRect()
                            ?? chip.parentElement?.getBoundingClientRect())
                        : chip.parentElement?.getBoundingClientRect();
                    if (!volRect) return;
                    applyChartNoteVolumeFromPointer(
                        volumeResizeIndices,
                        ev.clientY,
                        volRect,
                        buildRollVolumeNeighborDragOpts(ev.altKey, idx)
                    );
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

    cellMap.forEach((cell) => {
        const bi = parseInt(cell.dataset.barIndex, 10);
        const si = parseInt(cell.dataset.stepIndex, 10);
        for (const sec of rollSectionsHighlight) {
            if (!isMeasureCellOverlappingRollSpan(bi, si, bpm, [sec])) continue;
            if (cell.querySelector(`.note-roll-span-bar[data-roll-start-index="${sec.rollStartIndex}"]`)) continue;
            const rsNote = editingNotes[sec.rollStartIndex];
            const baseV = sec.volume != null ? clampNoteVolume(sec.volume) : 1;
            const cellKey = `${bi}:${si}`;
            let v = baseV;
            if (rsNote && (rsNote.type === 'roll-start' || rsNote.type === 'roll')
                && rsNote.rollCellVolumes && rsNote.rollCellVolumes[cellKey] != null) {
                v = clampNoteVolume(Number(rsNote.rollCellVolumes[cellKey]));
            }
            const bar = document.createElement('div');
            const anchorAt = rsNote?.type === 'roll' ? Number(rsNote.startTime ?? 0) : Number(rsNote?.time ?? 0);
            const rollFeelSelectedHere = chartRollFeelSelectionKeys.has(chartRollFeelSelectionKey(anchorAt, bi, si));
            bar.className = 'note-roll-span-bar' + (rollFeelSelectedHere ? ' chart-roll-feel-digit-focus' : '');
            bar.dataset.rollStartIndex = String(sec.rollStartIndex);
            bar.dataset.cellBarIndex = String(bi);
            bar.dataset.cellStepIndex = String(si);
            bar.style.height = `${Math.max(4, 16 * v)}px`;
            bar.title = '縦:音量（間はセル別、Shift+縦は±2マスをガウス風に補間）／横:長さ±1マス／Shift+横:両端±2マス／ホイール（Shiftは同様）／Alt+縦:周囲のドン・カ連動／クリックのみ: 数値→Enterで%指定／譜面グリッドで Shift+ドラッグ: 矩形内の連打感マスを範囲選択';
            bindChartRollSpanBarVolumePointer(bar, sec, bi, si, cell);
            cell.insertBefore(bar, cell.firstChild);
        }
    });

    if (btnRemove) btnRemove.disabled = selectedNoteIndex < 0;
    updateChartPalette(false);
    maybeScheduleMeasureStripWaveform(totalMeasures);
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
 * ノーツ配列で、timeToBarStep の丸め後に同一セルへ重なる単一時刻ノーツがないか検査する
 * @param {Array<Record<string, unknown>>} notes
 * @param {number} bpm
 * @returns {boolean} 重なりがあれば true
 */
function chartEditorHasTimelineCellConflict(notes, bpm) {
    /** @type {Map<string, number>} */
    const cellToOwner = new Map();
    for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        if (!n) continue;
        /**
         * @param {number} barIndex
         * @param {number} stepIndex
         * @returns {boolean} 他ノーツと衝突
         */
        const push = (barIndex, stepIndex) => {
            const k = `${barIndex}:${stepIndex}`;
            const prev = cellToOwner.get(k);
            if (prev != null && prev !== i) return true;
            cellToOwner.set(k, i);
            return false;
        };
        if (n.type === 'don' || n.type === 'ka' || n.type === 'roll-start' || n.type === 'roll-end') {
            const { barIndex, stepIndex } = timeToBarStep(Number(n.time ?? 0), bpm);
            if (push(barIndex, stepIndex)) return true;
        } else if (n.type === 'roll') {
            const s = Number(n.startTime ?? 0);
            const e = Number(n.endTime ?? n.startTime ?? 0);
            const a = timeToBarStep(s, bpm);
            const b = timeToBarStep(e, bpm);
            if (push(a.barIndex, a.stepIndex)) return true;
            if (push(b.barIndex, b.stepIndex)) return true;
        }
    }
    return false;
}

/**
 * 選択中のノーツを 16 分の半コマ分（グリッド時間で 1/32 拍）だけ平行移動する
 * @param {number} deltaHalfSteps 正で右、負で左（半コマ単位の整数）
 * @returns {boolean}
 */
function tryMoveSelectedNotesHalfStep(deltaHalfSteps) {
    if (!deltaHalfSteps) return false;
    clearChartRollFeelDigitInput();
    const indices = selectedNoteIndices.size > 0
        ? [...selectedNoteIndices].filter((i) => Number.isInteger(i) && i >= 0 && i < editingNotes.length)
        : (selectedNoteIndex >= 0 ? [selectedNoteIndex] : []);
    if (indices.length === 0) return false;

    const bpm = getChartTempo();
    const secPerBar = getBarSec(bpm);
    const dt = (secPerBar / 32) * deltaHalfSteps;
    if (!Number.isFinite(dt) || dt === 0) return false;

    const mut = editingNotes.map((n) => (n ? { ...n } : n));
    for (const i of indices) {
        const n = mut[i];
        if (!n) continue;
        if (n.type === 'roll') {
            const s = Number(n.startTime ?? 0);
            const e = Number(n.endTime ?? n.startTime ?? 0);
            n.startTime = s + dt;
            n.endTime = e + dt;
        } else {
            n.time = Number(n.time ?? 0) + dt;
        }
    }
    for (const i of indices) {
        const n = mut[i];
        if (!n) continue;
        const t0 = n.type === 'roll' ? Number(n.startTime ?? 0) : Number(n.time ?? 0);
        if (t0 < 0) return false;
    }
    if (chartEditorHasTimelineCellConflict(mut, bpm)) return false;

    let maxBar = 0;
    for (const n of mut) {
        if (!n) continue;
        if (n.type === 'roll') {
            const e = Number(n.endTime ?? n.startTime ?? 0);
            const s = Number(n.startTime ?? 0);
            maxBar = Math.max(maxBar, timeToBarStep(e, bpm).barIndex, timeToBarStep(s, bpm).barIndex);
        } else if (n.type === 'don' || n.type === 'ka' || n.type === 'roll-start' || n.type === 'roll-end') {
            maxBar = Math.max(maxBar, timeToBarStep(Number(n.time ?? 0), bpm).barIndex);
        }
    }
    const endEl = document.getElementById('chart-edit-end-time');
    if (endEl) {
        const cur = endEl.value !== '' ? Number(endEl.value) : NaN;
        const curMeasures = Number.isFinite(cur) ? Math.max(1, Math.floor(cur)) : null;
        const needMeasures = Math.max(1, maxBar + 1);
        if (curMeasures == null || curMeasures < needMeasures) {
            endEl.value = String(needMeasures);
        }
    }

    const selectedRefs = indices.map((i) => editingNotes[i]);
    for (const i of indices) {
        const src = mut[i];
        const dst = editingNotes[i];
        if (!src || !dst) continue;
        if (src.type === 'roll') {
            dst.startTime = src.startTime;
            dst.endTime = src.endTime;
        } else {
            dst.time = src.time;
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

    scheduleRenderNotesStrip();
    return true;
}

/**
 * 選択中のノーツをグリッド上で左右に1マス（16分）移動する。移動先に別ノーツがある場合は何もしない。
 * @param {number} delta -1 で左、+1 で右
 * @param {{ halfStep?: boolean } | undefined} [options] Ctrl+半コマ移動時は halfStep: true（delta は半コマの個数）
 * @returns {boolean} 移動したら true
 */
function tryMoveSelectedNotesHorizontally(delta, options) {
    if (!delta) return false;
    if (options && options.halfStep) {
        return tryMoveSelectedNotesHalfStep(delta);
    }
    clearChartRollFeelDigitInput();
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

    scheduleRenderNotesStrip();
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
            if (isChartEditorDirty() && !confirm('譜面を編集中です（未保存の変更があります）。新しい譜面の追加を続けますか？')) {
                return;
            }
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
                await loadCharts();
                if (cachedCharts[id]) {
                    loadChartIntoEditor(cachedCharts[id], { skipBgmWaveform: true });
                }
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
            if (isChartEditorDirty() && !confirm('譜面を編集中です（未保存の変更があります）。JSON のインポートを続けますか？')) {
                chartImportInput.value = '';
                return;
            }
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
                        loadChartIntoEditor(cachedCharts[lastId], { skipBgmWaveform: true });
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

    const btnExportPart = document.getElementById('btn-export-chart-part-json');
    const btnImportPart = document.getElementById('btn-import-chart-part-json');
    const chartPartImportInput = document.getElementById('chart-part-import-json-input');
    if (btnExportPart) {
        btnExportPart.addEventListener('click', () => exportCurrentChartPartJson());
    }
    if (btnImportPart && chartPartImportInput) {
        btnImportPart.addEventListener('click', () => {
            chartPartImportInput.value = '';
            chartPartImportInput.click();
        });
        chartPartImportInput.addEventListener('change', async () => {
            const file = chartPartImportInput.files && chartPartImportInput.files[0];
            if (!file) return;
            if (!selectedChartId) {
                if (statusEl) statusEl.textContent = '譜面を選択してください';
                chartPartImportInput.value = '';
                return;
            }
            if (statusEl) statusEl.textContent = 'パートを読み込み中...';
            btnImportPart.disabled = true;
            try {
                const text = await file.text();
                importChartPartFromJsonText(text, statusEl);
            } catch (err) {
                if (statusEl) statusEl.textContent = '読み込み失敗: ' + (err instanceof Error ? err.message : String(err));
            } finally {
                btnImportPart.disabled = false;
                chartPartImportInput.value = '';
                updateChartPartIoUi();
            }
        });
    }

    ensureChartHitSoundTableBuilt();
    const chartHitSoundFileInput = document.getElementById('chart-hit-sound-file-input');
    const chartHitSoundTbody = document.getElementById('chart-hit-sound-tbody');
    if (chartHitSoundTbody) {
        chartHitSoundTbody.addEventListener('click', async (e) => {
            const t = /** @type {HTMLElement} */ (e.target);
            const imp = t.closest && t.closest('.chart-hit-import');
            const rem = t.closest && t.closest('.chart-hit-remove');
            if (imp instanceof HTMLButtonElement) {
                if (!selectedChartId) {
                    if (statusEl) statusEl.textContent = '譜面を選択してください';
                    return;
                }
                const b = Number(imp.dataset.bucket);
                const k = imp.dataset.kind === 'ka' ? 'ka' : 'don';
                if (![0, 1, 2, 3, 4].includes(b)) return;
                chartHitSoundPending = { bucket: b, kind: k };
                if (chartHitSoundFileInput) {
                    chartHitSoundFileInput.value = '';
                    chartHitSoundFileInput.click();
                }
                return;
            }
            if (rem instanceof HTMLButtonElement) {
                if (!rem.disabled && selectedChartId) {
                    const b = Number(rem.dataset.bucket);
                    const k = rem.dataset.kind === 'ka' ? 'ka' : 'don';
                    if (![0, 1, 2, 3, 4].includes(b)) return;
                    if (!confirm(`この帯の${k === 'ka' ? 'カッ' : 'ドン'}ヒット音を削除しますか？`)) return;
                    if (statusEl) statusEl.textContent = '削除中...';
                    try {
                        const q = `part=${encodeURIComponent(String(chartEditingPart))}&bucket=${encodeURIComponent(String(b))}&kind=${encodeURIComponent(k)}`;
                        const res = await fetch('/admin/charts/' + encodeURIComponent(selectedChartId) + '/part-hit-sound?' + q, {
                            method: 'DELETE',
                            credentials: 'include'
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok) {
                            if (statusEl) statusEl.textContent = data.error || '削除に失敗しました';
                            return;
                        }
                        if (data.chart) cachedCharts[selectedChartId] = data.chart;
                        if (statusEl) statusEl.textContent = 'ヒット音を削除しました';
                        renderChartPartHitSoundCells();
                    } catch (err) {
                        if (statusEl) statusEl.textContent = '削除失敗: ' + (err instanceof Error ? err.message : String(err));
                    }
                }
            }
        });
    }
    if (chartHitSoundFileInput) {
        chartHitSoundFileInput.addEventListener('change', async () => {
            const file = chartHitSoundFileInput.files && chartHitSoundFileInput.files[0];
            if (!file || !selectedChartId) {
                chartHitSoundFileInput.value = '';
                return;
            }
            const lower = (file.name || '').toLowerCase();
            if (!lower.endsWith('.mp3')) {
                if (statusEl) statusEl.textContent = 'MP3ファイルを選択してください';
                chartHitSoundFileInput.value = '';
                return;
            }
            const { bucket, kind } = chartHitSoundPending;
            if (statusEl) statusEl.textContent = 'ヒット音をアップロード中...';
            const fd = new FormData();
            fd.append('sound', file);
            fd.append('part', String(chartEditingPart));
            fd.append('bucket', String(bucket));
            fd.append('kind', kind);
            try {
                const res = await fetch('/admin/charts/' + encodeURIComponent(selectedChartId) + '/part-hit-sound', {
                    method: 'POST',
                    body: fd,
                    credentials: 'include'
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    if (statusEl) statusEl.textContent = data.error || 'ヒット音のアップロードに失敗しました';
                    return;
                }
                if (data.chart) cachedCharts[selectedChartId] = data.chart;
                if (statusEl) statusEl.textContent = 'ヒット音を設定しました';
                renderChartPartHitSoundCells();
            } catch (err) {
                if (statusEl) statusEl.textContent = 'アップロード失敗: ' + (err instanceof Error ? err.message : String(err));
            } finally {
                chartHitSoundFileInput.value = '';
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
                    void refreshChartBgmWaveformForSelectedChart();
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
                void refreshChartBgmWaveformForSelectedChart();
                if (statusEl) statusEl.textContent = 'BGMを削除しました';
            } catch (e) {
                if (statusEl) statusEl.textContent = '削除失敗: ' + (e instanceof Error ? e.message : String(e));
            }
        });
    }

    const btnChartPartBgmImport = document.getElementById('btn-chart-part-bgm-import');
    const btnChartPartBgmRemove = document.getElementById('btn-chart-part-bgm-remove');
    const chartPartBgmFileInput = document.getElementById('chart-part-bgm-file-input');
    if (btnChartPartBgmImport && chartPartBgmFileInput) {
        btnChartPartBgmImport.addEventListener('click', () => {
            chartPartBgmFileInput.value = '';
            chartPartBgmFileInput.click();
        });
        chartPartBgmFileInput.addEventListener('change', async () => {
            const file = chartPartBgmFileInput.files && chartPartBgmFileInput.files[0];
            if (!file || !selectedChartId) return;
            const lower = (file.name || '').toLowerCase();
            if (!lower.endsWith('.mp3')) {
                if (statusEl) statusEl.textContent = 'MP3ファイルを選択してください';
                chartPartBgmFileInput.value = '';
                return;
            }
            if (statusEl) statusEl.textContent = 'パート用BGMをアップロード中...';
            btnChartPartBgmImport.disabled = true;
            const fd = new FormData();
            fd.append('bgm', file);
            try {
                const res = await fetch('/admin/charts/' + encodeURIComponent(selectedChartId) + '/bgm/part/' + encodeURIComponent(String(chartEditingPart)), {
                    method: 'POST',
                    body: fd,
                    credentials: 'include'
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    if (statusEl) statusEl.textContent = data.error || 'パートBGMのアップロードに失敗しました';
                    return;
                }
                if (data.chart) {
                    cachedCharts[selectedChartId] = data.chart;
                    invalidateChartBgmPreviewCache();
                    updateChartPartBgmRowUi();
                    void refreshChartBgmWaveformForSelectedChart();
                }
                if (statusEl) statusEl.textContent = 'パート用BGMを設定しました';
            } catch (err) {
                if (statusEl) statusEl.textContent = 'アップロード失敗: ' + (err instanceof Error ? err.message : String(err));
            } finally {
                chartPartBgmFileInput.value = '';
                updateChartPartBgmRowUi();
                btnChartPartBgmImport.disabled = !selectedChartId;
            }
        });
    }
    if (btnChartPartBgmRemove) {
        btnChartPartBgmRemove.addEventListener('click', async () => {
            if (!selectedChartId) return;
            if (!confirm(`${chartEditingPart}P のパート用BGMを削除しますか？`)) return;
            try {
                const res = await fetch('/admin/charts/' + encodeURIComponent(selectedChartId) + '/bgm/part/' + encodeURIComponent(String(chartEditingPart)), {
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
                    const ch = cachedCharts[selectedChartId];
                    if (ch && ch.partBgm && typeof ch.partBgm === 'object') {
                        const pb = /** @type {Record<string, unknown>} */ (ch.partBgm);
                        delete pb[String(chartEditingPart)];
                        if (Object.keys(pb).length === 0) delete ch.partBgm;
                    }
                }
                invalidateChartBgmPreviewCache();
                updateChartPartBgmRowUi();
                void refreshChartBgmWaveformForSelectedChart();
                if (statusEl) statusEl.textContent = 'パート用BGMを削除しました';
            } catch (e) {
                if (statusEl) statusEl.textContent = '削除失敗: ' + (e instanceof Error ? e.message : String(e));
            }
        });
    }

    const wfWrap = document.getElementById('chart-bgm-waveform-wrap');
    if (wfWrap && typeof ResizeObserver !== 'undefined' && !chartBgmWaveformResizeObserver) {
        chartBgmWaveformResizeObserver = new ResizeObserver(() => {
            requestAnimationFrame(() => paintChartBgmWaveformCanvas());
        });
        chartBgmWaveformResizeObserver.observe(wfWrap);
    }

    const measureScroll = document.getElementById('chart-measures-scroll');
    if (measureScroll && typeof ResizeObserver !== 'undefined' && !chartMeasureSpecResizeObserver) {
        chartMeasureSpecResizeObserver = new ResizeObserver(() => {
            schedulePaintMeasureWaveformIdle();
        });
        chartMeasureSpecResizeObserver.observe(measureScroll);
    }

    const btnSave = document.getElementById('btn-save-chart');
    if (btnSave) {
        btnSave.addEventListener('click', async () => {
            if (!selectedChartId) return;
            const payload = getChartEditorPutPayload();
            if (!payload) return;
            chartPartNames = { ...payload.partNames };
            updateChartPartTabLabels();
            statusEl.textContent = '保存中...';
            statusEl.classList.remove('success', 'error');
            try {
                const res = await fetch('/admin/charts/' + encodeURIComponent(selectedChartId), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    statusEl.classList.add('error');
                    statusEl.textContent = data.error || res.statusText;
                    return;
                }
                statusEl.classList.add('success');
                statusEl.textContent = '保存しました';
                showChartSaveToast('保存しました');
                cachedCharts[selectedChartId] = {
                    ...cachedCharts[selectedChartId],
                    ...payload,
                    measureBpms: chartMeasureBpms
                };
                commitChartEditorSavedBaseline();
                renderChartList(cachedCharts);
            } catch (err) {
                statusEl.classList.add('error');
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
            clearChartRollFeelDigitInput();
            editingNotes.splice(selectedNoteIndex, 1);
            selectedNoteIndex = -1;
            renderNotesStrip();
        });
    }

    /**
     * 連打帯クリック後の 0〜300 数字入力（Enter 確定）を処理する（キャプチャで先に拾う）
     * @param {KeyboardEvent} e
     */
    function handleChartRollFeelKeydown(e) {
        const chartPanel = document.getElementById('panel-chart');
        if (!chartPanel || !chartPanel.classList.contains('active')) return;
        if (chartRollFeelSelectionKeys.size === 0) return;
        if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement.tagName)) return;
        const st = document.getElementById('chart-status');
        if (e.key >= '0' && e.key <= '9') {
            if (chartRollFeelInputBuffer.length >= 3) return;
            chartRollFeelInputBuffer += e.key;
            syncChartRollFeelHintStatus();
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (e.key === 'Backspace') {
            if (chartRollFeelInputBuffer.length > 0) {
                chartRollFeelInputBuffer = chartRollFeelInputBuffer.slice(0, -1);
                syncChartRollFeelHintStatus();
            } else {
                clearChartRollFeelDigitInput();
                if (st && /^連打感:/.test(st.textContent)) st.textContent = '';
                renderNotesStrip();
            }
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (e.key === 'Escape') {
            clearChartRollFeelDigitInput();
            if (st && /^連打感:/.test(st.textContent)) st.textContent = '';
            renderNotesStrip();
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (e.key === 'Delete') {
            clearChartRollFeelDigitInput();
            if (st && /^連打感:/.test(st.textContent)) st.textContent = '';
            renderNotesStrip();
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (e.key === 'Enter') {
            applyChartRollFeelPercentFromBuffer();
            e.preventDefault();
            e.stopPropagation();
        }
    }
    document.addEventListener('keydown', handleChartRollFeelKeydown, true);

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
        if (chartRollFeelSelectionKeys.size > 0) {
            e.preventDefault();
            return;
        }
        const hasSelection = selectedNoteIndices.size > 0
            || (selectedNoteIndex >= 0 && selectedNoteIndex < editingNotes.length);
        if (!hasSelection) return;
        e.preventDefault();
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const halfStep = !!(e.ctrlKey || e.metaKey);
        tryMoveSelectedNotesHorizontally(delta, { halfStep });
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
                    const prev = editingNotes[replaceIndex];
                    const keepVol = type === 'roll-start' && prev && prev.type === 'roll-start' && prev.volume != null
                        ? { volume: prev.volume }
                        : {};
                    editingNotes[replaceIndex] = { type, time: qTime, ...keepVol };
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
                if (chartTempoInputDebounceTimer) {
                    clearTimeout(chartTempoInputDebounceTimer);
                    chartTempoInputDebounceTimer = 0;
                }
                chartTempoInputDebounceTimer = setTimeout(() => {
                    chartTempoInputDebounceTimer = 0;
                    const oldBpm = lastRenderedChartBpm ?? getChartTempo();
                    const newBpm = getChartTempo();
                    retimeEditingNotesKeepGridPositionVarBpm(oldBpm, newBpm);
                    renderNotesStrip();
                    updateChartPreviewControlsUI();
                }, 100);
            });
        }
    }

    // 範囲選択（ドラッグ） + コピー（Ctrl+C） + 右クリックペースト
    if (gridEl) {
        let selecting = false;
        let startCell = null;
        let lastCell = null;
        /** Shift+ドラッグ時は矩形内の連打感マスのみ選択（通常はノーツの範囲選択） */
        let rangeSelectRollFeelOnly = false;

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
            const bpmRh = getChartTempo();
            if (rangeSelectRollFeelOnly) {
                chartRollFeelSelectionKeys = getRollFeelCellKeysInAbsRange(aBar, aStep, bBar, bStep, bpmRh);
                selectedNoteIndices = new Set();
                selectedNoteIndex = -1;
                syncChartRollFeelHintStatus();
            } else {
                selectedNoteIndices = getNoteIndicesInAbsStepRange(aBar, aStep, bBar, bStep);
                selectedNoteIndex = -1;
            }
        }

        gridEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (!e.shiftKey && e.target.closest('.note-chip')) return;
            if (!e.shiftKey && e.target.closest('.note-roll-span-bar')) return;
            const cell = e.target.closest('.measure-cell');
            if (!cell) return;
            if (!selectedChartId) return;
            rangeSelectRollFeelOnly = e.shiftKey;
            selecting = true;
            startCell = cell;
            lastCell = cell;
            clearRangeHighlight();
            const ab = parseInt(cell.dataset.barIndex, 10);
            const as = parseInt(cell.dataset.stepIndex, 10);
            if (rangeSelectRollFeelOnly) {
                chartRollFeelSelectionKeys = getRollFeelCellKeysInAbsRange(ab, as, ab, as, getChartTempo());
                selectedNoteIndices = new Set();
                selectedNoteIndex = -1;
                syncChartRollFeelHintStatus();
            } else {
                clearChartRollFeelDigitInput();
                const stRg = document.getElementById('chart-status');
                if (stRg && /^連打感:/.test(stRg.textContent)) stRg.textContent = '';
                selectedNoteIndices = getNoteIndicesInAbsStepRange(ab, as, ab, as);
                selectedNoteIndex = -1;
            }
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
            rangeSelectRollFeelOnly = false;
            renderNotesStrip();
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
    void (async () => {
    await refreshAdminChartFeaturesFlag();

    import('/js/service-worker-register.js')
        .then((m) => m.registerMetaverseServiceWorker())
        .catch(() => {});

    import('./addons/registry-admin.js').catch((e) => console.warn('[addons] registry-admin', e));

    setupAdminAvatarManagementPanel();

    window.addEventListener('beforeunload', (e) => {
        if (!isChartEditorDirty()) return;
        e.preventDefault();
        e.returnValue = '';
    });

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

    // サイドメニュー: クリックでパネル切り替え（動的追加の addon ナビにも対応するため委譲）
    const adminNav = document.querySelector('.admin-nav');
    adminNav?.addEventListener('click', (e) => {
        const btn = e.target.closest('.admin-nav-item');
        if (!btn || !adminNav.contains(btn)) return;
        const panelId = btn.getAttribute('data-panel');
        if (panelId) switchPanel(panelId);
    });

    // URL の ?panel= で初期表示パネルを指定（例: ?panel=panel-world-edit または従来どおり ?panel=world-edit）
    const params = new URLSearchParams(location.search);
    let initialPanel = params.get('panel');
    if (initialPanel === 'world-edit') initialPanel = 'panel-world-edit';
    if (initialPanel === 'security') initialPanel = 'panel-security';
    const validPanels = ['panel-security', 'panel-status', 'panel-players', 'panel-comm', 'panel-logs', 'panel-user-register', 'panel-world-edit', 'panel-aircraft', 'panel-database', 'panel-avatar-management', 'panel-chart', 'panel-chart-inactive', 'panel-addons', 'panel-addon-nfc-spawn', 'panel-addon-meta-bench-r1'];
    if (initialPanel && validPanels.includes(initialPanel)) {
        switchPanel(initialPanel);
    }

    loadStats();
    initServerMaintenanceAdminPanel();
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
    document.getElementById('enter-metaverse-world-cancel')?.addEventListener('click', closeEnterMetaverseWorldModal);
    document.getElementById('enter-metaverse-world-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'enter-metaverse-world-modal') closeEnterMetaverseWorldModal();
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

    // 管理画面: SW・Cache Storage・ワールド編集ローカルキャッシュを消して完全再読み込み
    document.getElementById('admin-cache-hard-reload')?.addEventListener('click', async () => {
        if (
            !confirm(
                'Service Worker とブラウザの Cache Storage を削除し、ワールド編集のローカルキャッシュ（metaverse-admin-world-edit-cache-v1）も消します。\n次にページを再読み込みします。続けますか？',
            )
        ) {
            return;
        }
        const btn = document.getElementById('admin-cache-hard-reload');
        const adminHardReloadIconHtml = '<i class="bi bi-arrow-clockwise" aria-hidden="true"></i>';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML =
                '<i class="bi bi-arrow-clockwise admin-cache-hard-reload-spin" aria-hidden="true"></i>';
        }
        try {
            try {
                sessionStorage.setItem(SETTING_EDITOR_MODULE_BUST_KEY, String(Date.now()));
            } catch (_) { /* ignore */ }
            try {
                localStorage.removeItem('metaverse-admin-world-edit-cache-v1');
            } catch (_) { /* ignore */ }
            try {
                const m = await import('/js/service-worker-register.js');
                if (typeof m.purgeMetaverseClientCachesAndUnregisterSw === 'function') {
                    await m.purgeMetaverseClientCachesAndUnregisterSw();
                }
            } catch (e) {
                console.warn('admin cache purge:', e);
            }
            const u = new URL(window.location.href);
            u.searchParams.set('_admin_rev', String(Date.now()));
            window.location.replace(u.toString());
        } catch (e) {
            console.error('admin hard reload failed:', e);
            alert('再読み込みの準備に失敗しました。');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = adminHardReloadIconHtml;
            }
        }
    });

    // メタバースへ入る（管理者）: ワールド選択後にトークン取得して /admin?world= へ遷移
    document.getElementById('back-to-metaverse').addEventListener('click', () => {
        void openEnterMetaverseWorldModal();
    });
    })();
});

function updateLastUpdateTime() {
    const now = new Date();
    document.getElementById('last-update').textContent = now.toLocaleTimeString('ja-JP');
}

/** @type {boolean} */
let serverMaintenanceSavePending = false;

/**
 * @param {{ active?: boolean } | null | undefined} maintenance
 */
function applyServerMaintenanceAdminForm(maintenance) {
    const activeEl = /** @type {HTMLInputElement | null} */ (document.getElementById('server-maintenance-active'));
    if (!activeEl || !maintenance) return;
    activeEl.checked = !!maintenance.active;
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function setServerMaintenanceAdminStatus(text, isError = false) {
    const el = document.getElementById('server-maintenance-admin-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
}

/**
 * @param {boolean} active
 * @returns {Promise<void>}
 */
async function saveServerMaintenanceDisplay(active) {
    if (serverMaintenanceSavePending) return;
    serverMaintenanceSavePending = true;
    setServerMaintenanceAdminStatus('反映中…');
    try {
        const res = await fetch('/admin/maintenance-display', {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
        if (data.maintenance) applyServerMaintenanceAdminForm(data.maintenance);
        setServerMaintenanceAdminStatus(
            data.maintenance?.active ? 'メンテナンス表示を ON にしました（全プレイヤーへ通知済み）' : 'メンテナンス表示を OFF にしました'
        );
    } catch (e) {
        setServerMaintenanceAdminStatus(
            `保存に失敗: ${e instanceof Error ? e.message : String(e)}`,
            true
        );
    } finally {
        serverMaintenanceSavePending = false;
    }
}

/**
 * ステータスタブのメンテナンス告知 UI を初期化する
 */
function initServerMaintenanceAdminPanel() {
    const activeEl = /** @type {HTMLInputElement | null} */ (document.getElementById('server-maintenance-active'));
    if (!activeEl) return;

    activeEl.addEventListener('change', () => {
        void saveServerMaintenanceDisplay(activeEl.checked);
    });
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

        if (typeof data.chartFeaturesEnabled === 'boolean') {
            adminChartFeaturesEnabled = data.chartFeaturesEnabled;
            applyChartFeaturesAdminChrome();
        }

        if (data.serverMaintenance) {
            applyServerMaintenanceAdminForm(data.serverMaintenance);
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

/** メタバース入室モーダルを閉じる */
function closeEnterMetaverseWorldModal() {
    const modal = document.getElementById('enter-metaverse-world-modal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
}

/**
 * メタバース入室: ワールド一覧を読み込み中央モーダルを表示する
 */
async function openEnterMetaverseWorldModal() {
    const modal = document.getElementById('enter-metaverse-world-modal');
    const listEl = document.getElementById('enter-metaverse-world-list');
    const loadingEl = document.getElementById('enter-metaverse-world-loading');
    const errorEl = document.getElementById('enter-metaverse-world-error');
    if (!modal || !listEl || !loadingEl || !errorEl) return;

    listEl.innerHTML = '';
    loadingEl.hidden = false;
    errorEl.hidden = true;
    errorEl.textContent = '';
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');

    try {
        const response = await fetch('/admin/worlds', { credentials: 'include' });
        if (!response.ok) throw new Error('worlds fetch failed');
        const worlds = await response.json();
        loadingEl.hidden = true;

        const entries = Object.entries(worlds || {})
            .map(([id, w]) => ({
                id,
                name: w && w.name != null && String(w.name).trim() ? String(w.name).trim() : id,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

        if (entries.length === 0) {
            errorEl.textContent = 'ワールドが登録されていません。';
            errorEl.hidden = false;
            return;
        }

        for (const { id, name } of entries) {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'enter-metaverse-world-item';
            btn.dataset.worldId = id;
            btn.setAttribute('role', 'option');
            btn.innerHTML =
                `<span class="enter-metaverse-world-item-name">${escapeHtml(name)}</span>` +
                `<span class="enter-metaverse-world-item-id">${escapeHtml(id)}</span>`;
            btn.addEventListener('click', () => {
                void enterMetaverseAsAdmin(id, btn);
            });
            li.appendChild(btn);
            listEl.appendChild(li);
        }
    } catch (err) {
        console.error('Failed to load worlds for enter modal:', err);
        loadingEl.hidden = true;
        errorEl.textContent = 'ワールド一覧の取得に失敗しました。';
        errorEl.hidden = false;
    }
}

/**
 * 管理者として指定ワールドのメタバースへ遷移する
 * @param {string} worldId
 * @param {HTMLButtonElement} itemBtn
 */
async function enterMetaverseAsAdmin(worldId, itemBtn) {
    const modal = document.getElementById('enter-metaverse-world-modal');
    const allItems = modal?.querySelectorAll('.enter-metaverse-world-item');
    allItems?.forEach((b) => {
        b.disabled = true;
    });
    if (itemBtn) {
        itemBtn.querySelector('.enter-metaverse-world-item-name').textContent = '入室準備中…';
        const idSpan = itemBtn.querySelector('.enter-metaverse-world-item-id');
        if (idSpan) idSpan.textContent = '';
    }

    try {
        const res = await fetch('/admin/enter-metaverse', { credentials: 'include' });
        if (!res.ok) {
            alert('認証に失敗しました。再度ログインしてください。');
            closeEnterMetaverseWorldModal();
            return;
        }
        const { username } = await res.json();
        localStorage.setItem('username', username);
        const url = new URL('/admin', window.location.origin);
        url.searchParams.set('world', worldId);
        window.location.href = url.pathname + url.search;
    } catch (err) {
        console.error('Failed to enter metaverse as admin:', err);
        alert('メタバースへの入室に失敗しました。');
        allItems?.forEach((b) => {
            b.disabled = false;
        });
        void openEnterMetaverseWorldModal();
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
            tbody.innerHTML = '<tr><td colspan="9" class="loading">接続中のプレイヤーなし</td></tr>';
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
            const perfTier = player.perfTier != null ? escapeHtml(String(player.perfTier)) : '-';
            const perfFps = player.fpsSample != null ? escapeHtml(String(player.fpsSample)) : '-';
            const perfCell = `<span class="perf-cell" title="effectiveTier / 直近1秒FPSサンプル">${perfTier} / ${perfFps}</span>`;

            const roleLabel = player.role === 'student' ? '[生徒]' : player.role === 'teacher' ? '[教師]' : player.role === 'admin' ? '[管理者]' : '';

            return `
                <tr>
                    <td><span class="socket-id">${player.socketId}</span></td>
                    <td><span class="username">${escapeHtml(player.username)}</span></td>
                    <td><span class="room-badge">${escapeHtml(player.room)}</span></td>
                    <td>${connectedTime}</td>
                    <td>${pingCell}</td>
                    <td>${perfCell}</td>
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
            '<tr><td colspan="9" class="loading">エラー: プレイヤー情報の取得に失敗しました</td></tr>';
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
            document.getElementById('user-session-location').textContent = session.location || '-';
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
 * 選択中譜面の、現在の編集パート（1P/2P/3Pタブ）のノーツだけをJSONでエクスポートする
 */
function exportCurrentChartPartJson() {
    const statusEl = document.getElementById('chart-status');
    if (!selectedChartId) {
        if (statusEl) statusEl.textContent = '譜面を選択してください';
        return;
    }
    flushChartPartSlot();
    const part = chartEditingPart;
    const slot = part - 1;
    const notes = chartPartNoteSlots[slot].map((n) => ({ ...n }));
    const chartName = (cachedCharts[selectedChartId] && cachedCharts[selectedChartId].name) ? String(cachedCharts[selectedChartId].name) : selectedChartId;
    const partName = (chartPartNames[part] && String(chartPartNames[part]).trim()) ? String(chartPartNames[part]).trim() : '';
    const payload = {
        format: 'metaverse-taiko-chart-part',
        version: 1,
        exportedAt: new Date().toISOString(),
        chartId: selectedChartId,
        chartName,
        part,
        partName,
        notes,
    };
    const safeChart = /^[a-zA-Z0-9_-]+$/.test(selectedChartId) ? selectedChartId : 'chart';
    downloadJson(`${safeChart}_part${part}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, payload);
    if (statusEl) statusEl.textContent = `${part}P をエクスポートしました`;
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
