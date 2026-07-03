// addons/meta-bench-r1/test/bench-pdf-path.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_BENCH_PDF_PATH,
    normalizeBenchPdfPath,
} from '../lib/bench-pdf-path.js';

describe('normalizeBenchPdfPath', () => {
    it('defaults to bench-sample.pdf', () => {
        assert.equal(DEFAULT_BENCH_PDF_PATH, 'bench-sample.pdf');
        assert.equal(normalizeBenchPdfPath(undefined), 'bench-sample.pdf');
    });

    it('strips /pdfs/ URL-style prefix', () => {
        assert.equal(normalizeBenchPdfPath('/pdfs/bench-sample.pdf'), 'bench-sample.pdf');
        assert.equal(normalizeBenchPdfPath('pdfs/bench-sample.pdf'), 'bench-sample.pdf');
    });

    it('keeps filename-only paths', () => {
        assert.equal(normalizeBenchPdfPath('new_school.pdf'), 'new_school.pdf');
    });

    it('rejects path traversal', () => {
        assert.equal(normalizeBenchPdfPath('../secret.pdf'), DEFAULT_BENCH_PDF_PATH);
    });
});
