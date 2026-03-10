// public/js/taiko-game-manager.js
// 轟太鼓リズムゲーム: オーバーレイ制御・ノーツ生成・判定・スコア管理

import { isMobile } from './mobile-utils.js';

/**
 * ノーツ定義: { time: 秒, type: 'don'|'ka' }
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
const SOUND_DON = '/music/don.mp3';
const SOUND_KA = '/music/ka.mp3';

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
        this._chartMeta = null; // { id, name, difficulty, endTime } 選曲時
        this._judgeCounts = { good: 0, ok: 0, miss: 0 };
        this._currentCombo = 0;
        this._maxCombo = 0;
        this._activeNotes = []; // { el, targetTime, type, hit, chartIndex }
        this._processedChartIndices = new Set(); // 処理済み（ヒット or 不可）のチャート索引
        this._startTime = null;
        this._rafId = null;
        this._judgeTimer = null;

        this._boundKeyDown = this._onKeyDown.bind(this);
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
     * 太鼓メニューを開く。選曲画面を表示し、譜面を選んだらゲームを開始する。
     */
    open() {
        if (!this._overlay) return;
        this._open = true;
        this._overlay.style.display = 'flex';
        if (this._songSelectEl) this._songSelectEl.style.display = 'flex';
        if (this._gameContainerEl) this._gameContainerEl.style.display = 'none';
        const resultsEl = document.getElementById('taiko-results');
        if (resultsEl) resultsEl.style.display = 'none';

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
                    const meta = { id, name: c.name || id, difficulty: c.difficulty, endTime: c.endTime };
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
     * @param {{ id: string, name: string, difficulty?: number, endTime?: number } | null} meta - 曲メタ（選曲時）
     */
    _startGamePlay(chart, meta) {
        if (!this._songSelectEl || !this._gameContainerEl) return;
        this._songSelectEl.style.display = 'none';
        this._gameContainerEl.style.display = 'flex';
        const resultsEl = document.getElementById('taiko-results');
        if (resultsEl) resultsEl.style.display = 'none';

        this._chart = chart;
        this._chartMeta = meta || null;
        this._score = 0;
        this._maxScore = this._chart.length * 100;
        this._judgeCounts = { good: 0, ok: 0, miss: 0 };
        this._currentCombo = 0;
        this._maxCombo = 0;
        this._activeNotes = [];
        this._processedChartIndices = new Set();
        this._updateScoreDisplay();
        if (this._notesContainer) this._notesContainer.innerHTML = '';
        this._startTime = performance.now() / 1000;

        document.addEventListener('keydown', this._boundKeyDown);
        this._loop();
    }

    close() {
        if (!this._open) return;
        this._open = false;
        this._closeHintPopup();
        if (this._overlay) this._overlay.style.display = 'none';
        if (this._rafId) cancelAnimationFrame(this._rafId);
        if (this._notesContainer) this._notesContainer.innerHTML = '';
        this._activeNotes = [];
        document.removeEventListener('keydown', this._boundKeyDown);
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
     * ドン／カッのヒット音を再生する
     * @param {'don'|'ka'} type
     */
    _playHitSound(type) {
        const src = type === 'don' ? SOUND_DON : SOUND_KA;
        const audio = new Audio(src);
        audio.volume = 1;
        audio.play().catch(() => {});
    }

    /**
     * ヒット判定処理（ノーツが判定ラインに触れているか＝位置で判定）
     * @param {'don'|'ka'} type
     */
    _hit(type) {
        if (!this._open) return;

        this._playHitSound(type);
        this._flashButton(type);

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

        if (!best) return;

        if (bestDistancePx <= JUDGE_GOOD_PX) {
            this._judge('good', best);
        } else if (bestDistancePx <= JUDGE_OK_PX) {
            this._judge('ok', best);
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

        // 新規ノーツ生成（到達時刻 - NOTE_TRAVEL_TIME 秒前に出現）
        this._chart.forEach((note, chartIndex) => {
            if (this._processedChartIndices.has(chartIndex)) return;
            const spawnTime = note.targetTime ?? note.time;
            const exists = this._activeNotes.some(n => n.chartIndex === chartIndex);
            if (!exists && now >= spawnTime - NOTE_TRAVEL_TIME) {
                const el = document.createElement('div');
                el.className = `taiko-note ${note.type}`;
                el.textContent = note.type === 'don' ? 'ドン' : 'カッ';
                this._notesContainer?.appendChild(el);
                this._activeNotes.push({
                    el,
                    targetTime: spawnTime,
                    type: note.type,
                    hit: false,
                    chartIndex,
                    srcNote: note
                });
            }
        });

        const rightEdge = laneWidth - 32;
        const laneSpan = rightEdge - JUDGE_LINE_LEFT_PX;

        let missShownThisFrame = false;

        // ノーツ位置更新
        for (const note of this._activeNotes) {
            if (note.hit) continue;
            const remaining = note.targetTime - now;
            const left = JUDGE_LINE_LEFT_PX + remaining / NOTE_TRAVEL_TIME * laneSpan;
            if (note.el) {
                note.el.style.left = `${left - 32}px`;
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

        // ヒット済みのうち、エフェクト未使用（即削除）のものだけここで削除。エフェクト中は animationend で削除
        this._activeNotes = this._activeNotes.filter(note => {
            if (!note.hit) return true;
            const el = note.el;
            if (el && (el.classList.contains('taiko-note-hit') || el.classList.contains('taiko-note-miss'))) return true;
            if (el) { el.remove(); note.el = null; }
            if (note.chartIndex !== undefined) this._processedChartIndices.add(note.chartIndex);
            return false;
        });

        // 曲終了チェック: 終了時間を過ぎた、または全ノーツ処理済みで余韻後
        const lastNoteTime = this._chart.length ? (this._chart[this._chart.length - 1]?.time ?? 0) : 0;
        const endTime = this._chartMeta?.endTime != null ? this._chartMeta.endTime : lastNoteTime + 1;
        const allDone = this._chart.length > 0 && this._activeNotes.every(n => n.hit);
        if (allDone && now >= endTime) {
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
        document.getElementById('taiko-results-roll').textContent = '0';
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
        if (this._songSelectEl) this._songSelectEl.style.display = 'flex';
    }
}

export default TaikoGameManager;
