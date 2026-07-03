// lib/ip-geolocation.js - IP to approximate location via api.country.is

const API_BASE = 'https://api.country.is';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 5000;

/** @type {Map<string, { location: string | null, fetchedAt: number }>} */
const cache = new Map();

const LOCAL_OR_INVALID = new Set(['-', 'unknown', '::1', '127.0.0.1', '::ffff:127.0.0.1']);

const regionDisplay = new Intl.DisplayNames(['ja'], { type: 'region' });

/**
 * Normalize client IP for lookup (strip IPv4-mapped IPv6 prefix).
 * @param {string | null | undefined} ip
 * @returns {string | null}
 */
function normalizeIp(ip) {
    if (!ip || typeof ip !== 'string') return null;
    let value = ip.trim();
    if (value.startsWith('::ffff:')) value = value.slice(7);
    if (!value || LOCAL_OR_INVALID.has(value)) return null;
    return value;
}

/**
 * Format api.country.is response as a human-readable location string.
 * @param {Record<string, unknown>} data
 * @returns {string | null}
 */
function formatLocation(data) {
    if (!data || typeof data.country !== 'string' || !data.country) return null;

    let countryName = data.country;
    try {
        countryName = regionDisplay.of(data.country) || data.country;
    } catch {
        // keep ISO code
    }

    const parts = [];
    if (typeof data.city === 'string' && data.city) parts.push(data.city);
    if (typeof data.subdivision === 'string' && data.subdivision) parts.push(data.subdivision);
    if (typeof data.postal === 'string' && data.postal) parts.push(data.postal);
    parts.push(`${countryName} (${data.country})`);

    let result = parts.join(' / ');
    const loc = data.location;
    if (
        loc &&
        typeof loc === 'object' &&
        typeof loc.latitude === 'number' &&
        typeof loc.longitude === 'number'
    ) {
        result += ` [${loc.latitude.toFixed(2)}, ${loc.longitude.toFixed(2)}]`;
    }
    return result;
}

/**
 * Look up approximate location for an IP address (cached 24h).
 * @param {string | null | undefined} ip
 * @returns {Promise<string | null>}
 */
export async function lookupIpLocation(ip) {
    const normalized = normalizeIp(ip);
    if (!normalized) return null;

    const cached = cache.get(normalized);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.location;
    }

    try {
        const url = `${API_BASE}/${encodeURIComponent(normalized)}?fields=city,continent,subdivision,postal,location`;
        const res = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
        if (!res.ok) {
            cache.set(normalized, { location: null, fetchedAt: Date.now() });
            return null;
        }
        const data = await res.json();
        const location = formatLocation(data);
        cache.set(normalized, { location, fetchedAt: Date.now() });
        return location;
    } catch (err) {
        console.warn('[ip-geolocation] lookup failed:', normalized, err instanceof Error ? err.message : err);
        return null;
    }
}
