// addons/qr-ar/client/ar/camera-stream.js — 背面カメラストリーム

/**
 * 背面カメラを起動する
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
    video.setAttribute('autoplay', 'true');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
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
