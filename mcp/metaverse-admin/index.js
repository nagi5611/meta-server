#!/usr/bin/env node
// mcp/metaverse-admin/index.js — Cursor MCP → 家メタバース管理 API

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { adminHttpRequest, getAdminBaseUrl } from './lib/admin-http-client.js';

const mcpServer = new McpServer({
    name: 'metaverse-admin',
    version: '1.0.0',
});

mcpServer.registerTool(
    'metaverse_admin_get',
    {
        description:
            '家メタバースサーバー管理 API を GET する（Basic 認証）。path は /admin/... または /host-monitor/...。例: /admin/stats, /admin/worlds, /admin/players, /admin/addons, /admin/logs, /host-monitor/api/status',
        inputSchema: {
            path: z.string().describe('例: /admin/stats'),
            query: z
                .record(z.union([z.string(), z.number(), z.boolean()]))
                .optional()
                .describe('クエリパラメータ（任意）'),
        },
    },
    async ({ path, query }) => {
        const result = await adminHttpRequest('GET', path, { query });
        return {
            content: [
                {
                    type: 'text',
                    text: `URL: ${getAdminBaseUrl()}${path}\nHTTP ${result.status}\n\n${result.bodyText}`,
                },
            ],
            isError: !result.ok,
        };
    }
);

mcpServer.registerTool(
    'metaverse_admin_write',
    {
        description:
            '管理 API に POST/PUT/PATCH/DELETE（CSRF 付き）。kick・再起動・worlds 保存など破壊的操作を含む。必ず confirmWrite: true を付けること。',
        inputSchema: {
            method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
            path: z.string(),
            body: z.record(z.unknown()).optional().describe('JSON ボディ（任意）'),
            query: z
                .record(z.union([z.string(), z.number(), z.boolean()]))
                .optional(),
            confirmWrite: z
                .literal(true)
                .describe('変更操作の明示同意。true 以外では実行されない'),
        },
    },
    async ({ method, path, body, query, confirmWrite }) => {
        const result = await adminHttpRequest(method, path, {
            body,
            query,
            confirmWrite,
        });
        return {
            content: [
                {
                    type: 'text',
                    text: `URL: ${getAdminBaseUrl()}${path}\nHTTP ${result.status}\n\n${result.bodyText}`,
                },
            ],
            isError: !result.ok,
        };
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
}

main().catch((error) => {
    console.error('[metaverse-admin-mcp]', error);
    process.exit(1);
});
