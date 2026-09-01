// lib/metaverse-portal-links.js
/**
 * 系列メタバースサーバー間ナビ用リンクを .env から読み取る。
 * METAVERSE_PORTAL_LINKS: label|url を改行・カンマ区切り（url に | が含まれる場合は label|url の最初の | で分割）
 */

/**
 * @typedef {{ label: string, url: string, current?: boolean }} PortalLink
 */

/**
 * @param {string | undefined} raw
 * @returns {PortalLink[]}
 */
export function parseMetaversePortalLinks(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const items = raw.split(/[\r\n,]+/).map((p) => p.trim()).filter(Boolean);
    const links = /** @type {PortalLink[]} */ ([]);
    for (const item of items) {
        const pipe = item.indexOf('|');
        if (pipe <= 0) continue;
        const label = item.slice(0, pipe).trim();
        const url = item.slice(pipe + 1).trim();
        if (!label || !url) continue;
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
            links.push({ label, url: parsed.href });
        } catch {
            continue;
        }
    }
    return links;
}

/**
 * リクエスト Host（と TLS）と一致するリンクに current を付与する
 * @param {PortalLink[]} links
 * @param {import('express').Request} req
 * @returns {PortalLink[]}
 */
export function markCurrentPortalLink(links, req) {
    const hostHeader = String(req.get('host') || '').trim().toLowerCase();
    if (!hostHeader) return links.map((l) => ({ ...l, current: false }));

    const colon = hostHeader.indexOf(':');
    const reqHostname = colon > 0 ? hostHeader.slice(0, colon) : hostHeader;
    const reqPortRaw = colon > 0 ? hostHeader.slice(colon + 1) : '';
    const reqPortParsed = reqPortRaw ? parseInt(reqPortRaw, 10) : NaN;
    const defaultPort = req.secure ? 443 : 80;
    const reqPort = Number.isFinite(reqPortParsed) ? reqPortParsed : defaultPort;

    return links.map((link) => {
        let current = false;
        try {
            const u = new URL(link.url);
            const linkPort = u.port
                ? parseInt(u.port, 10)
                : u.protocol === 'https:' ? 443 : 80;
            current =
                u.hostname.toLowerCase() === reqHostname &&
                linkPort === reqPort;
        } catch {
            /* ignore */
        }
        return { ...link, current };
    });
}

/**
 * @param {import('express').Request} req
 * @returns {PortalLink[]}
 */
export function getPortalLinksForRequest(req) {
    const raw = process.env.METAVERSE_PORTAL_LINKS;
    const links = parseMetaversePortalLinks(raw);
    return markCurrentPortalLink(links, req);
}
