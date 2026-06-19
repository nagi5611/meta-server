#!/usr/bin/env node
// addons/smoke-view/tools/convert-nvdb-to-pvdb/inspect-nvdb.mjs — .nvdb ヘッダ簡易解析
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGICS = {
    NVDB0: 0x304244566f6e614e,
    NVDB1: 0x314244566f6e614e,
    NVDB2: 0x324244566f6e614e
};

/**
 * @param {number} u64
 */
function magicLabel(u64) {
    const hit = Object.entries(MAGICS).find(([, v]) => v === u64);
    if (hit) return hit[0];
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(u64));
    return `"${b.toString('ascii').replace(/[^\x20-\x7e]/g, '.')}"`;
}

/**
 * @param {Buffer} buf
 * @param {string} file
 */
function inspect(buf, file) {
    const u64 = (o) => Number(buf.readBigUInt64LE(o));
    const u32 = (o) => buf.readUInt32LE(o);
    const u16 = (o) => buf.readUInt16LE(o);

    console.log(`\n${path.basename(file)}  (${buf.length} bytes)`);
    console.log('  file magic:', magicLabel(u64(0)), 'grid_count:', u16(12), 'codec:', u16(14));

    const meta = 16;
    const nameSize = u32(meta + 136);
    const gridOff = meta + 176 + nameSize;
    const name = buf.subarray(meta + 176, meta + 176 + nameSize).toString('utf8');
    const metaCodec = u16(meta + 168);

    console.log('  grid name:', JSON.stringify(name), 'metadata codec:', metaCodec);
    console.log('  grid payload @', gridOff);

    if (gridOff + 8 > buf.length) {
        console.log('  (payload missing)');
        return;
    }

    const prefix8 = buf.subarray(gridOff, gridOff + 8);
    if (metaCodec === 0) {
        console.log('  payload magic:', magicLabel(u64(gridOff)));
    } else if (metaCodec === 1) {
        const uncompSize = u64(gridOff);
        const zlibOff = gridOff + 8;
        console.log('  zlib uncompressed size:', uncompSize);
        console.log('  zlib header:', buf.subarray(zlibOff, zlibOff + 2).toString('hex'));
        try {
            const out = zlib.inflateSync(buf.subarray(zlibOff));
            console.log('  zlib inflate ok ->', out.length, 'bytes, magic:', magicLabel(Number(out.readBigUInt64LE(0))));
        } catch (err) {
            console.log('  zlib inflate failed:', err instanceof Error ? err.message : err);
        }
    } else {
        console.log('  unknown codec, prefix:', prefix8.toString('hex'));
    }
}

const files = process.argv.slice(2);
if (files.length === 0) {
    console.log('Usage: node inspect-nvdb.mjs file.nvdb [...]');
    process.exit(1);
}

for (const file of files) {
    inspect(fs.readFileSync(path.resolve(file)), file);
}
