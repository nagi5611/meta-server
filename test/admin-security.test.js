// test/admin-security.test.js — 管理者パネル SEC 緊急修正の回帰テスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import { createAdminCsrfBundle } from '../lib/admin-csrf.js';
import { validateUserPassword } from '../lib/password-policy.js';
import { serializeCellForTest } from './admin-security-helpers.js';

/**
 * @param {import('express').Express} app
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function listenApp(app) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.listen(0, () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({
                port,
                close: () =>
                    new Promise((res, rej) => {
                        server.close((err) => (err ? rej(err) : res()));
                    }),
            });
        });
        server.on('error', reject);
    });
}

describe('SEC-001 middleware order', () => {
    it('addon routes require basic auth when registered after app.use(/admin, basicAuth)', async () => {
        const app = express();
        app.use(express.json());
        const ADMIN_PASSWORD = 'test-admin-password-16chars';

        function basicAuth(req, res, next) {
            const h = req.headers.authorization;
            if (!h || !h.startsWith('Basic ')) {
                return res.status(401).send('auth required');
            }
            const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
            const pass = decoded.split(':')[1] || '';
            if (pass !== ADMIN_PASSWORD) return res.status(401).send('auth failed');
            return next();
        }

        app.use('/admin', basicAuth);
        app.post('/admin/addons/test/action', (_req, res) => {
            res.json({ ok: true });
        });
        app.get('/admin/stats', (_req, res) => {
            res.json({ protected: true });
        });

        const { port, close } = await listenApp(app);
        try {
            const base = `http://127.0.0.1:${port}`;
            const addonRes = await fetch(`${base}/admin/addons/test/action`, { method: 'POST' });
            assert.equal(addonRes.status, 401);

            const cred = Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64');
            const authed = await fetch(`${base}/admin/addons/test/action`, {
                method: 'POST',
                headers: { Authorization: `Basic ${cred}` },
            });
            assert.equal(authed.status, 200);
        } finally {
            await close();
        }
    });
});

describe('SEC-002 CSRF', () => {
    it('rejects mutating requests without X-Admin-CSRF', async () => {
        const app = express();
        app.use(express.json());
        const secret = 'csrf-test-secret-value-16';
        const { adminCsrfProtection, issueToken } = createAdminCsrfBundle(secret);

        app.use('/admin', (_req, res, next) => next());
        app.use('/admin', adminCsrfProtection);
        app.post('/admin/kick', (_req, res) => res.json({ ok: true }));

        const { port, close } = await listenApp(app);
        try {
            const base = `http://127.0.0.1:${port}`;
            const noCsrf = await fetch(`${base}/admin/kick`, { method: 'POST' });
            assert.equal(noCsrf.status, 403);

            const { token } = issueToken();
            const withCsrf = await fetch(`${base}/admin/kick`, {
                method: 'POST',
                headers: { 'X-Admin-CSRF': token },
            });
            assert.equal(withCsrf.status, 200);
        } finally {
            await close();
        }
    });
});

describe('SEC-007 password policy', () => {
    it('rejects short passwords in development', () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'development';
        try {
            const r = validateUserPassword('short');
            assert.equal(r.ok, false);
            assert.equal(r.minLength, 8);
        } finally {
            process.env.NODE_ENV = prev;
        }
    });

    it('requires 12 chars in production', () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const r = validateUserPassword('11chars!!!!');
            assert.equal(r.ok, false);
            assert.equal(r.minLength, 12);
            const ok = validateUserPassword('12chars!!!!!');
            assert.equal(ok.ok, true);
        } finally {
            process.env.NODE_ENV = prev;
        }
    });
});

describe('SEC-010 column masking', () => {
    it('redacts api_key and session_id', () => {
        const apiKey = serializeCellForTest('secret-key', 'api_key');
        assert.equal(apiKey.redacted, true);
        const session = serializeCellForTest('abc', 'session_id');
        assert.equal(session.redacted, true);
        const name = serializeCellForTest('alice', 'username');
        assert.equal(name.redacted, false);
    });
});
