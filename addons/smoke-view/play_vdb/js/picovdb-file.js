// addons/smoke-view/play_vdb/js/picovdb-file.js — PicoVDB バイナリパーサー（vendor picovdb.ts 由来）

export const PICOVDB_MAGIC = [0x6f636950, 0x30424456];

export const GRID_TYPE_SDF_FLOAT = 1;
export const GRID_TYPE_SDF_UINT8 = 2;
export const GRID_TYPE_FOG_FLOAT = 3;

export const PICOVDB_FILE_HEADER_SIZE = 32;
export const PICOVDB_GRID_SIZE = 64;
export const PICOVDB_ROOT_SIZE = 8;
export const PICOVDB_UPPER_SIZE = 12304;
export const PICOVDB_LOWER_SIZE = 1552;
export const PICOVDB_LEAF_SIZE = 208;
export const PICOVDB_DATA_SIZE = 16;

/**
 * @param {number} gridType
 * @returns {string}
 */
export function gridTypeLabel(gridType) {
    switch (gridType) {
        case GRID_TYPE_SDF_FLOAT: return 'SDF_FLOAT';
        case GRID_TYPE_SDF_UINT8: return 'SDF_UINT8';
        case GRID_TYPE_FOG_FLOAT: return 'FOG_FLOAT';
        default: return `UNKNOWN(${gridType})`;
    }
}

export class PicoVDBFile {
    /**
     * @param {ArrayBuffer} buffer
     */
    constructor(buffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer);

        let offset = 0;
        this.header = {
            magic: [this.view.getUint32(offset + 0, true), this.view.getUint32(offset + 4, true)],
            version: this.view.getUint32(offset + 8, true),
            gridCount: this.view.getUint32(offset + 12, true),
            upperCount: this.view.getUint32(offset + 16, true),
            lowerCount: this.view.getUint32(offset + 20, true),
            leafCount: this.view.getUint32(offset + 24, true),
            dataCount: this.view.getUint32(offset + 28, true),
        };
        offset += PICOVDB_FILE_HEADER_SIZE;

        if (this.header.magic[0] !== PICOVDB_MAGIC[0] || this.header.magic[1] !== PICOVDB_MAGIC[1]) {
            throw new Error(
                `Invalid PicoVDB magic: [0x${this.header.magic[0].toString(16)}, 0x${this.header.magic[1].toString(16)}]`,
            );
        }

        if (this.header.gridCount === 0) {
            throw new Error(
                'PicoVDB にグリッドがありません（gridCount=0）。'
                + ' nvdb→pvdb 変換が空出力の可能性があります。'
                + ' convert.mjs で .nvdb を再変換してください。',
            );
        }

        if (buffer.byteLength < PICOVDB_FILE_HEADER_SIZE + this.header.gridCount * PICOVDB_GRID_SIZE) {
            throw new Error(
                `PicoVDB ファイルが短すぎます（${buffer.byteLength} bytes）。`
                + ' 破損または未完了の変換の可能性があります。',
            );
        }

        this.gridsBuffer = new Uint8Array(buffer, offset, this.header.gridCount * PICOVDB_GRID_SIZE);
        offset += this.header.gridCount * PICOVDB_GRID_SIZE;

        const rootCount = this.getRootCountPadded();
        this.rootsBuffer = new Uint8Array(buffer, offset, rootCount * PICOVDB_ROOT_SIZE);
        offset += rootCount * PICOVDB_ROOT_SIZE;

        this.uppersBuffer = new Uint8Array(buffer, offset, this.header.upperCount * PICOVDB_UPPER_SIZE);
        offset += this.header.upperCount * PICOVDB_UPPER_SIZE;

        this.lowersBuffer = new Uint8Array(buffer, offset, this.header.lowerCount * PICOVDB_LOWER_SIZE);
        offset += this.header.lowerCount * PICOVDB_LOWER_SIZE;

        this.leavesBuffer = new Uint8Array(buffer, offset, this.header.leafCount * PICOVDB_LEAF_SIZE);
        offset += this.header.leafCount * PICOVDB_LEAF_SIZE;

        this.dataBuffer = new Uint8Array(buffer, offset, this.header.dataCount * PICOVDB_DATA_SIZE);
    }

    getSize() {
        return this.buffer.byteLength;
    }

    /**
     * @param {number} index
     */
    getGrid(index) {
        if (index >= this.header.gridCount) {
            throw new Error(`Grid index ${index} out of bounds (max: ${this.header.gridCount - 1})`);
        }

        const baseOffset = PICOVDB_FILE_HEADER_SIZE + index * PICOVDB_GRID_SIZE;
        const offset = baseOffset;

        return {
            gridIndex: this.view.getUint32(offset + 0, true),
            upperStart: this.view.getUint32(offset + 4, true),
            lowerStart: this.view.getUint32(offset + 8, true),
            leafStart: this.view.getUint32(offset + 12, true),
            dataStart: this.view.getUint32(offset + 16, true),
            dataElemCount: this.view.getUint32(offset + 20, true),
            gridType: this.view.getUint32(offset + 24, true),
            indexBoundsMin: new Int32Array(this.buffer, offset + 32, 3),
            indexBoundsMax: new Int32Array(this.buffer, offset + 48, 3),
        };
    }

    getRootCountPadded() {
        return ((this.header.upperCount + 1) / 2 | 0) * 2;
    }

    getVoxelCount() {
        let count = 0;
        for (let i = 0; i < this.header.gridCount; i++) {
            count += this.getGrid(i).dataElemCount - 2;
        }
        return count;
    }
}

/**
 * @param {ArrayBuffer} buffer
 * @param {{ fileName?: string }} [options]
 * @returns {Promise<PicoVDBFile>}
 */
export async function parsePicoVDBFromBuffer(buffer, options = {}) {
    const name = (options.fileName || '').toLowerCase();
    let data = buffer;

    const isGzip = name.endsWith('.gz') || name.endsWith('.pvdb.gz');
    if (isGzip) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('Gzip 展開には DecompressionStream API が必要です（Chrome/Edge 推奨）。');
        }
        const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
        data = await new Response(stream).arrayBuffer();
    }

    const remainder = data.byteLength % 4;
    const alignedBuffer = remainder === 0
        ? data
        : new ArrayBuffer(data.byteLength + (4 - remainder));

    if (remainder !== 0) {
        new Uint8Array(alignedBuffer).set(new Uint8Array(data));
    }

    return new PicoVDBFile(alignedBuffer);
}

/**
 * @param {PicoVDBFile} file
 * @returns {{ translation: number[], scale: number }}
 */
export function computeAutoTransform(file) {
    if (file.header.gridCount === 0) {
        throw new Error('PicoVDB にグリッドがありません（gridCount=0）');
    }
    const grid = file.getGrid(0);
    const sx = grid.indexBoundsMax[0] - grid.indexBoundsMin[0];
    const sy = grid.indexBoundsMax[1] - grid.indexBoundsMin[1];
    const sz = grid.indexBoundsMax[2] - grid.indexBoundsMin[2];
    const maxDim = Math.max(sx, sy, sz, 1);
    const scale = 120 / maxDim;
    const cx = (grid.indexBoundsMin[0] + grid.indexBoundsMax[0]) * 0.5;
    const cy = (grid.indexBoundsMin[1] + grid.indexBoundsMax[1]) * 0.5;
    const cz = (grid.indexBoundsMin[2] + grid.indexBoundsMax[2]) * 0.5;
    return {
        translation: [-cx * scale, -cy * scale, -cz * scale],
        scale,
    };
}
