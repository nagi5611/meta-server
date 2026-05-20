// addons/matsuyama-flights/server.js — 松山空港発着 ODPT + Jetstar ポーリング + HTTP API
import { HOOKS } from '../../lib/hook-registry.js';
import { fetchJetstarDepartures } from './lib/jetstar-client.js';
import {
    fetchMatsuyamaFlights,
    mergeFlights,
    orderFlightsForBoard,
    resolveAirportId,
} from './lib/odpt-client.js';

/** @type {{ ok: boolean, airport: string, updatedAt: string|null, departures: object[], arrivals: object[], error?: string }} */
let cachedBoard = {
    ok: false,
    airport: 'MYJ',
    updatedAt: null,
    departures: [],
    arrivals: [],
    error: 'ODPT consumer key not configured',
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
 * マージ済み config から文字列を取得（env は snake_case に正規化される）
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
 * 設定が有効（true）か — 未設定時は既定 true
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
 * ODPT から発着を取得してキャッシュを更新する
 * @param {object} ctx
 */
async function refreshBoard(ctx) {
    const key = configStr(ctx.config, ['odpt_consumer_key', 'odptConsumerKey', 'odptconsumerkey']);
    const airportIata = configStr(ctx.config, ['airport_iata', 'airportIata', 'airportiata']) || 'MYJ';

    if (!key) {
        cachedBoard = {
            ok: false,
            airport: airportIata,
            updatedAt: null,
            departures: [],
            arrivals: [],
            error: 'Set ADDON_MATSUYAMA_FLIGHTS_ODPT_CONSUMER_KEY and restart the server',
        };
        return;
    }

    try {
        if (!resolvedAirportId) {
            resolvedAirportId = await resolveAirportId(key, airportIata);
            if (resolvedAirportId) {
                ctx.logger.info(`resolved airport ${airportIata} -> ${resolvedAirportId}`);
            }
        }

        const { departures, arrivals, airportId } = await fetchMatsuyamaFlights({
            consumerKey: key,
            airportIata,
            airportId: resolvedAirportId,
        });
        if (airportId) resolvedAirportId = airportId;

        const jetstarOn = configEnabled(
            ctx.config.jetstar_enabled ?? ctx.config.jetstarEnabled ?? ctx.config.jetstarenabled,
            true
        );
        if (jetstarOn) {
            const dest =
                configStr(ctx.config, ['jetstar_destination', 'jetstarDestination', 'jetstardestination'])
                || 'NRT';
            try {
                const jetDeps = await fetchJetstarDepartures({
                    origin: airportIata,
                    destination: dest,
                });
                mergeFlights(departures, jetDeps);
                const ordered = orderFlightsForBoard(departures);
                departures.length = 0;
                departures.push(...ordered);
                ctx.logger.info(`jetstar merged: ${jetDeps.length} departures (${airportIata}->${dest})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                ctx.logger.warn('jetstar fetch failed:', msg);
            }
        }

        cachedBoard = {
            ok: true,
            airport: airportIata,
            updatedAt: new Date().toISOString(),
            departures,
            arrivals,
        };
        ctx.logger.info(
            `board updated: ${departures.length} departures, ${arrivals.length} arrivals`
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.logger.warn('board refresh failed:', msg);
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
                const key = configStr(ctx.config, ['odpt_consumer_key', 'odptConsumerKey', 'odptconsumerkey']);
                if (!key) {
                    res.status(503).json({
                        ok: false,
                        error: 'ODPT consumer key not configured (ADDON_MATSUYAMA_FLIGHTS_ODPT_CONSUMER_KEY)',
                        airport: cachedBoard.airport,
                        departures: [],
                        arrivals: [],
                    });
                    return;
                }
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

        const key = configStr(ctx.config, ['odpt_consumer_key', 'odptConsumerKey', 'odptconsumerkey']);
        if (key) {
            await refreshBoard(ctx);
            pollTimer = setInterval(() => {
                refreshBoard(ctx).catch((e) => ctx.logger.warn('poll error', e));
            }, pollMs);
        } else {
            ctx.logger.warn(
                'ODPT key missing — set ADDON_MATSUYAMA_FLIGHTS_ODPT_CONSUMER_KEY; GET /board returns 503'
            );
        }

        ctx.logger.info('registered');
    },
};
