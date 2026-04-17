// public/js/chart-bgm-fetch.js
// サーバーが生成した WAV を優先取得し、なければ MP3（従来データ）

/**
 * 拡張子なしのベース URL に .wav または .mp3 を付けて取得する
 * @param {string} basePath 例: /chart-bgm/myChart または /chart-bgm/myChart/hits/p1-b0-don
 * @param {string|number} version キャッシュ無効化用 v=
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchChartBgmArrayBuffer(basePath, version) {
    const v = encodeURIComponent(String(version));
    const tryExt = async (ext) => {
        const res = await fetch(`${basePath}${ext}?v=${v}`, { credentials: 'same-origin' });
        if (!res.ok) return null;
        return res.arrayBuffer();
    };
    const wav = await tryExt('.wav');
    if (wav) return wav;
    const mp3 = await tryExt('.mp3');
    if (mp3) return mp3;
    throw new Error('BGMの取得に失敗しました');
}
