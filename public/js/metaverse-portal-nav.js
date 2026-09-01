// public/js/metaverse-portal-nav.js
/**
 * /api/client-config の portalLinks をナビに描画する
 * @param {HTMLElement | null} container
 */
export async function renderMetaversePortalNav(container) {
    if (!container) return;
    try {
        const res = await fetch('/api/client-config', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        const links = Array.isArray(data.portalLinks) ? data.portalLinks : [];
        if (links.length === 0) {
            container.closest('.portal-nav')?.setAttribute('hidden', 'true');
            return;
        }
        container.replaceChildren();
        for (const item of links) {
            const label = String(item.label || '').trim();
            const url = String(item.url || '').trim();
            if (!label || !url) continue;
            const a = document.createElement('a');
            a.href = url;
            a.textContent = label;
            if (item.current) {
                a.classList.add('is-current');
                a.setAttribute('aria-current', 'page');
            }
            container.appendChild(a);
        }
    } catch {
        /* ignore */
    }
}
