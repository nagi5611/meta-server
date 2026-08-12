// addons/qr-ar/client/ar/camera-stream.js — 背面カメラストリーム

/**
 * video のメタデータ読み込みを待つ
 * @param {HTMLVideoElement} video
 */
function waitForVideoMetadata(video) {
    if (video.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error('video_metadata_failed')), { once: true });
    });
}

/**
 * 背面カメラを起動する（getUserMedia で許可ダイアログを表示）
 * @returns {Promise<{ video: HTMLVideoElement, stream: MediaStream }>}
 */
export async function startCameraStream() {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('camera_not_supported');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
        },
    });
    const video = document.createElement('video');
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.playsInline = true;
    video.setAttribute('autoplay', 'true');
    video.muted = true;
    video.srcObject = stream;
    await waitForVideoMetadata(video);
    try {
        await video.play();
    } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        err.name = err.name || 'VideoPlayError';
        throw err;
    }
    return { video, stream };
}

/**
 * @param {MediaStream} stream
 */
export function stopCameraStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
        track.stop();
    }
}
