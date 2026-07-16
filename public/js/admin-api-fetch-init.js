// public/js/admin-api-fetch-init.js — 管理画面起動時 CSRF 初期化
import { initAdminCsrf, installAdminFetchPatch } from './admin-api-fetch.js';

installAdminFetchPatch();
await initAdminCsrf();
