// addons/matsuyama-flights/server.js — 松山空港公式 HTML 主軸 + ODPT/Jetstar バックアップ
import { HOOKS } from '../../lib/hook-registry.js';
import {
    DEFAULT_TIMETABLE_URL,
    fetchMatsuyamaAirportBoard,
} from './lib/airport-timetable-client.js';
import { fetchBackupBoard } from './lib/backup-board.js';
import { jstTodayYmd } from './lib/flight-date-jst.js';

const LAYOUT_WARN_MSG =
    '[matsuyama-flights] ⚠️ 松山空港公式サイトのレイアウト変更を検知しました。ODPT/Jetstar バックアップに切り替えます。';

const FETCH_WARN_MSG =
    '[matsuyama-flights] ⚠️ 松山空港公式サイトの取得に失敗しました。ODPT/Jetstar バックアップに切り替えます。';

/** @type {{
 *   ok: boolean,
 *   airport: string,
 *   serviceDate: string|null,
 *   dataSource: string|null,
 *   layoutAlert: boolean,
 *   updatedAt: string|null,
 *   departures: object[],
 *   arrivals: object[],
 *   error?: string
 * }} */
let cachedBoard = {
    ok: false,
    airport: 'MYJ',
    serviceDate: null,
    dataSource: null,
    layoutAlert: false,
    updatedAt: null,
    departures: [],
    arrivals: [],
    error: '初期化中',
};

/** @type {string|null} */
let resolvedAirportId = null;

/** @type {ReturnType<typeof setInterval>|null} */
let pollTimer = null;

/**
 * 設定値を数値に
 * @param {unknown} v
 * @param {number} fallback
 */
function numConfig(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * マージ済み config から文字列を取得
 * @param {Record<string, unknown>} config
 * @param {string[]} keys
 * @returns {string}
 */
function configStr(config, keys) {
    for (const k of keys) {
        const v = config[k];
        if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
}

/**
 * 設定が有効（true）か
 * @param {unknown} v
 * @param {boolean} [defaultOn]
 */
function configEnabled(v, defaultOn = true) {
    if (v === undefined || v === null || String(v).trim() === '') return defaultOn;
    if (v === false || v === 0) return false;
    const s = String(v).trim().toLowerCase();
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
    return true;
}

/**
 * レイアウト変更をログ警告
 * @param {object} ctx
 * @param {string[]} reasons
 */
function warnLayoutChange(ctx, reasons) {
    ctx.logger.error(LAYOUT_WARN_MSG);
    for (const r of reasons) {
        ctx.logger.error(`[matsuyama-flights]   理由: ${r}`);
    }
}

/**
 * 公式 HTML 取得失敗をログ警告（レイアウト変更とは別）
 * @param {object} ctx
 * @param {string} message
 */
function warnFetchFailure(ctx, message) {
    ctx.logger.error(FETCH_WARN_MSG);
    ctx.logger.error(`[matsuyama-flights]   理由: ${message}`);
}

/**
 * バックアップ経路で board を取得
 * @param {object} ctx
 * @param {string} airportIata
 * @param {string} key
 * @returns {Promise<boolean>} 成功したか
 */
async function applyBackupBoard(ctx, airportIata, key) {
    const backupOn = configEnabled(
        ctx.config.backup_enabled ?? ctx.config.backupEnabled ?? ctx.config.backupenabled,
        true
    );
    if (!backupOn) {
        cachedBoard = {
            ...cachedBoard,
            ok: false,
            error: 'レイアウト変更検知・バックアップ無効',
            layoutAlert: true,
        };
        return false;
    }

    const backup = await fetchBackupBoard({
        consumerKey: key,
        airportIata,
        airportId: resolvedAirportId,
        config: ctx.config,
    });
    if (backup.airportId) resolvedAirportId = backup.airportId;

    if (!backup.ok) {
        cachedBoard = {
            ...cachedBoard,
            ok: false,
            airport: airportIata,
            dataSource: 'backup',
            layoutAlert: true,
            error: backup.error || 'Backup fetch failed',
            updatedAt: cachedBoard.updatedAt,
        };
        return false;
    }

    cachedBoard = {
        ok: true,
        airport: airportIata,
        serviceDate: jstTodayYmd(),
        dataSource: 'backup',
        layoutAlert: true,
        updatedAt: new Date().toISOString(),
        departures: backup.departures,
        arrivals: backup.arrivals,
    };
    ctx.logger.info(
        `board updated (backup): ${backup.departures.length} departures, ${backup.arrivals.length} arrivals`
    );
    return true;
}

/**
 * 発着キャッシュを更新
 * @param {object} ctx
 */
async function refreshBoard(ctx) {
    const airportIata = configStr(ctx.config, ['airport_iata', 'airportIata', 'airportiata']) || 'MYJ';
    const timetableUrl =
        configStr(ctx.config, ['timetable_url', 'timetableUrl', 'timetableurl'])
        || DEFAULT_TIMETABLE_URL;
    const odptKey = configStr(ctx.config, ['odpt_consumer_key', 'odptConsumerKey', 'odptconsumerkey']);

    try {
        const airport = await fetchMatsuyamaAirportBoard({ url: timetableUrl });

        if (airport.layoutValid) {
            cachedBoard = {
                ok: true,
                airport: airportIata,
                serviceDate: jstTodayYmd(),
                dataSource: 'airport',
                layoutAlert: false,
                updatedAt: new Date().toISOString(),
                departures: airport.departures,
                arrivals: airport.arrivals,
            };
            ctx.logger.info(
                `board updated (airport): ${airport.departures.length} departures, ${airport.arrivals.length} arrivals`
            );
            return;
        }

        warnLayoutChange(ctx, airport.layoutReasons);

        if (await applyBackupBoard(ctx, airportIata, odptKey)) {
            return;
        }

        if (!odptKey) {
            ctx.logger.error(
                '[matsuyama-flights] バックアップには ADDON_MATSUYAMA_FLIGHTS_ODPT_CONSUMER_KEY が必要です'
            );
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.logger.warn('airport timetable fetch failed:', msg);

        if (odptKey) {
            warnFetchFailure(ctx, msg);
            if (await applyBackupBoard(ctx, airportIata, odptKey)) {
                return;
            }
        }

        cachedBoard = {
            ...cachedBoard,
            ok: false,
            error: msg,
            updatedAt: cachedBoard.updatedAt,
        };
    }
}

export default {
    /**
     * @param {object} ctx plugin context
     */
    async register(ctx) {
        const pollMs = numConfig(
            ctx.config.poll_interval_ms ?? ctx.config.pollIntervalMs ?? ctx.config.pollintervalms,
            60_000
        );

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            app.get(`${ctx.paths.httpBasePath}/board`, (_req, res) => {
                if (!cachedBoard.ok && cachedBoard.error) {
                    res.status(503).json(cachedBoard);
                    return;
                }
                res.json(cachedBoard);
            });
        });

        ctx.hooks.on(HOOKS.SHUTDOWN, () => {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        });

        await refreshBoard(ctx);
        pollTimer = setInterval(() => {
            refreshBoard(ctx).catch((e) => ctx.logger.warn('poll error', e));
        }, pollMs);

        ctx.logger.info('registered (v2 airport timetable primary)');
    },
};
