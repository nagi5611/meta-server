// addons/matsuyama-flights/lib/backup-board.js — ODPT + Jetstar バックアップ取得
import { fetchJetstarDepartures } from './jetstar-client.js';
import {
    fetchMatsuyamaFlights,
    mergeFlights,
    orderFlightsForBoard,
} from './odpt-client.js';

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
 * ODPT + Jetstar から発着ボードデータを取得（レイアウト変更時のバックアップ）
 * @param {object} opts
 * @param {string} opts.consumerKey ODPT acl:consumerKey
 * @param {string} opts.airportIata
 * @param {string|null} [opts.airportId]
 * @param {Record<string, unknown>} [opts.config]
 * @returns {Promise<{ ok: boolean, departures: object[], arrivals: object[], airportId: string|null, error?: string }>}
 */
export async function fetchBackupBoard({
    consumerKey,
    airportIata,
    airportId: knownAirportId,
    config = {},
}) {
    const key = String(consumerKey || '').trim();
    if (!key) {
        return {
            ok: false,
            departures: [],
            arrivals: [],
            airportId: knownAirportId || null,
            error: 'ODPT consumer key not configured (backup requires ADDON_MATSUYAMA_FLIGHTS_ODPT_CONSUMER_KEY)',
        };
    }

    try {
        const { departures, arrivals, airportId } = await fetchMatsuyamaFlights({
            consumerKey: key,
            airportIata,
            airportId: knownAirportId,
        });

        const jetstarOn = configEnabled(
            config.jetstar_enabled ?? config.jetstarEnabled ?? config.jetstarenabled,
            true
        );
        if (jetstarOn) {
            const dest =
                String(
                    config.jetstar_destination
                    ?? config.jetstarDestination
                    ?? config.jetstardestination
                    ?? 'NRT'
                ).trim() || 'NRT';
            try {
                const jetDeps = await fetchJetstarDepartures({
                    origin: airportIata,
                    destination: dest,
                });
                mergeFlights(departures, jetDeps);
                const ordered = orderFlightsForBoard(departures);
                departures.length = 0;
                departures.push(...ordered);
            } catch {
                /* Jetstar optional in backup */
            }
        }

        return {
            ok: true,
            departures,
            arrivals,
            airportId: airportId || knownAirportId || null,
        };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            departures: [],
            arrivals: [],
            airportId: knownAirportId || null,
            error: msg,
        };
    }
}
