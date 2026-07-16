// lib/admin-csrf.js — 管理 API 向け CSRF トークン（HMAC・ステートレス）
import crypto from 'node:crypto';

export const ADMIN_CSRF_HEADER = 'X-Admin-CSRF';

const HOUR_MS = 60 * 60 * 1000;

/**
 * @param {string} adminPassword
 */
export function createAdminCsrfBundle(adminPassword) {
    const secret = String(adminPassword || '');

    /**
     * @returns {{ token: string, expiresAt: number }}
     */
    function issueToken() {
        const hourBucket = Math.floor(Date.now() / HOUR_MS);
        const nonce = crypto.randomBytes(16).toString('hex');
        const payload = `${hourBucket}.${nonce}`;
        const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        return {
            token: `${payload}.${sig}`,
            expiresAt: (hourBucket + 1) * HOUR_MS,
        };
    }

    /**
     * @param {unknown} token
     * @returns {boolean}
     */
    function verifyToken(token) {
        if (!secret || typeof token !== 'string' || !token) return false;
        const parts = token.split('.');
        if (parts.length !== 3) return false;
        const [hourStr, nonce, sig] = parts;
        const hourBucket = parseInt(hourStr, 10);
        if (!Number.isFinite(hourBucket) || !nonce || !sig) return false;
        const nowBucket = Math.floor(Date.now() / HOUR_MS);
        if (hourBucket < nowBucket - 1 || hourBucket > nowBucket) return false;
        const payload = `${hourBucket}.${nonce}`;
        const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        try {
            const a = Buffer.from(sig, 'hex');
            const b = Buffer.from(expected, 'hex');
            if (a.length !== b.length) return false;
            return crypto.timingSafeEqual(a, b);
        } catch {
            return false;
        }
    }

    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    function adminCsrfProtection(req, res, next) {
        const method = String(req.method || 'GET').toUpperCase();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
            return next();
        }
        const raw = req.headers[ADMIN_CSRF_HEADER.toLowerCase()] ?? req.headers[ADMIN_CSRF_HEADER];
        const token = typeof raw === 'string' ? raw : '';
        if (!verifyToken(token)) {
            return res.status(403).json({ error: 'csrf_invalid' });
        }
        return next();
    }

    /**
     * @param {import('express').Express} app
     */
    function registerAdminCsrfRoute(app) {
        app.get('/admin/csrf-token', (_req, res) => {
            const issued = issueToken();
            res.json({ ok: true, token: issued.token, expiresAt: issued.expiresAt });
        });
    }

    return { adminCsrfProtection, registerAdminCsrfRoute, issueToken, verifyToken };
}
