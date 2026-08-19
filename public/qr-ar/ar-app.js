// public/qr-ar/ar-app.js — Open WebAR SDK による QR / image-tracking AR（IMU 補正付き）
import {
    WebGLRenderer,
    Scene,
    PerspectiveCamera,
    AnimationMixer,
    LoopRepeat,
    EquirectangularReflectionMapping,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import WAS, {
    ANCHOR_TYPE_CENTER,
    CAMERA_MODE_ENVIRONMENT,
    DEVICE_ERROR,
    EVENT_DETECTED,
    EVENT_DEVICE_ORIENTATION,
    EVENT_ERROR,
    EVENT_FRAME,
    EVENT_LOST,
    EVENT_POSE,
    EVENT_PROCESS,
    EVENT_RESIZE,
    EVENT_SCREEN_ORIENTATION,
    EVENT_VISIBILITY,
    GL_ERROR,
    HTML_ERROR,
    PROJECT_MODE_IMAGE,
    PROJECT_MODE_QR,
    TRIGGER_MODE_IMAGE,
    TRIGGER_MODE_QR,
    VIDEO_ERROR,
    WORKER_ERROR,
} from '@web-ar-studio/webar-engine-sdk';
import { ImuCompensator, requestMotionPermissions } from './imu-compensator.js';
import { PoseController } from './pose-controller.js';

const CAMERA_FOV = 45;
const CAMERA_NEAR = 1;
const CAMERA_FAR = 100000;

const TEST_API_KEY = '52f80541de1715ba47f43522d648d0800c6e514d8b5e91b9b6e13ef9e1348cb8';

const startGuide = document.getElementById('qr-ar-start-guide');
const startImageBtn = document.getElementById('qr-ar-start-image-btn');
const startQrBtn = document.getElementById('qr-ar-start-qr-btn');
const errorEl = document.getElementById('qr-ar-error');
const mount = document.getElementById('qr-ar-mount');
const statusBar = document.getElementById('qr-ar-status');
const statusText = document.getElementById('qr-ar-status-text');

const triggerQrSource = 'trigger';
const triggerImageSource = new URL('./assets/trigger.jpg', import.meta.url).href;
const gltfSource = new URL('./models/33.glb', import.meta.url).href;
const hdrSource = new URL('./assets/environment.hdr', import.meta.url).href;

/** @type {ImuCompensator|null} */
let activeImuCompensator = null;

const INIT_TIMEOUT_MS = 45000;

/**
 * Promise にタイムアウトを付与する。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise
            .then((value) => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch((error) => {
                clearTimeout(timer);
                reject(error);
            });
    });
}

/**
 * AR ビューを表示する（同期的に切り替え、ユーザージェスチャーを維持する）。
 */
function activateArView() {
    document.body.classList.add('qr-ar-active');
    statusBar.hidden = false;

    if (mount.clientWidth === 0 || mount.clientHeight === 0) {
        throw new Error('AR 表示領域のサイズを取得できませんでした。');
    }
}

/**
 * AR ビューを終了し、開始画面へ戻す。
 */
function deactivateArView() {
    document.body.classList.remove('qr-ar-active');
    statusBar.hidden = true;
}

/**
 * レンダラーと SDK のビューポートをコンテナサイズに合わせる。
 * @param {import('@web-ar-studio/webar-engine-sdk').default} was
 * @param {WebGLRenderer} renderer
 * @param {PerspectiveCamera} camera
 */
function syncRendererViewport(was, renderer, camera) {
    const viewportSizes = was.getViewportSizes();
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setViewport(
        -(viewportSizes.width / 2 - mount.clientWidth / 2),
        -(viewportSizes.height / 2 - mount.clientHeight / 2),
        viewportSizes.width,
        viewportSizes.height,
    );
    camera.aspect = viewportSizes.width / viewportSizes.height;
    camera.updateProjectionMatrix();
}

/**
 * Open WebAR SDK のエラーをユーザー向けメッセージへ変換する。
 * @param {Error & { name?: string }} error
 */
function formatWasError(error) {
    switch (error.name) {
        case VIDEO_ERROR:
            return 'カメラへのアクセスが拒否されました。ブラウザの設定でカメラを許可してから再試行してください。';
        case DEVICE_ERROR:
            return 'カメラが見つかりません。スマホの背面カメラ、または PC の Webcam を確認してください。';
        case HTML_ERROR:
            return '表示領域の初期化に失敗しました。ページを再読み込みしてください。';
        default:
            if (error.message?.includes('apikey') || error.message?.includes('API')) {
                return 'WebAR API キーの検証に失敗しました。VITE_WEBAR_API_KEY の設定とドメイン登録を確認してください。';
            }
            return error.message || 'AR の起動に失敗しました。';
    }
}

/**
 * WAS エラーをログと UI に表示する。
 * @param {Error & { name?: string }} error
 */
function handleWasError(error) {
    console.error('[qr-ar]', error);
    if (error.name === GL_ERROR || error.name === WORKER_ERROR || error.name === EVENT_ERROR) {
        console.error('[qr-ar] internal:', error);
    }
    showError(formatWasError(error));
}

/**
 * エラーメッセージを表示し、開始ボタンを再有効化する。
 * @param {string} message
 */
function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    startImageBtn.disabled = false;
    startQrBtn.disabled = false;
    deactivateArView();
    activeImuCompensator?.stopListening();
    activeImuCompensator = null;
}

/**
 * HDR 環境マップを読み込む。
 * @param {Scene} scene
 */
function loadHdrEnvironment(scene) {
    return new Promise((resolve, reject) => {
        const rgbeLoader = new RGBELoader();
        rgbeLoader.load(
            hdrSource,
            (dataTexture) => {
                dataTexture.mapping = EquirectangularReflectionMapping;
                scene.environment = dataTexture;
                resolve();
            },
            undefined,
            reject,
        );
    });
}

/**
 * GLB モデルを読み込む。
 */
function loadGltfModel() {
    return new Promise((resolve, reject) => {
        const gltfLoader = new GLTFLoader();
        gltfLoader.load(
            gltfSource,
            (gltf) => resolve(gltf),
            undefined,
            reject,
        );
    });
}

/**
 * 追跡モードに応じた SDK 設定を返す。
 * @param {'image' | 'qr'} trackingMode
 */
function buildSdkConfig(trackingMode) {
    if (trackingMode === 'image') {
        return {
            mode: PROJECT_MODE_IMAGE,
            triggers: [{ id: 2, mode: TRIGGER_MODE_IMAGE, source: triggerImageSource }],
            searchingText: '画像マーカーを探しています…',
        };
    }

    return {
        mode: PROJECT_MODE_QR,
        triggers: [{ id: 1, mode: TRIGGER_MODE_QR, source: triggerQrSource }],
        searchingText: 'QR コードを探しています…',
    };
}

/**
 * Open WebAR SDK で AR を開始する。
 * @param {'image' | 'qr'} trackingMode
 */
async function startQrAr(trackingMode) {
    if (!mount) {
        throw new Error('AR マウント要素が見つかりません。');
    }

    const sdkConfig = buildSdkConfig(trackingMode);
    const apiKey = import.meta.env.VITE_WEBAR_API_KEY || TEST_API_KEY;
    const was = new WAS();

    const configData = {
        apiKey,
        apiBaseUrl: window.location.origin,
        mode: sdkConfig.mode,
        cameraMode: CAMERA_MODE_ENVIRONMENT,
        container: mount,
        fov: CAMERA_FOV,
        triggers: sdkConfig.triggers,
        isMultiTracking: true,
        anchor: ANCHOR_TYPE_CENTER,
    };

    const imuCompensator = new ImuCompensator();
    activeImuCompensator = imuCompensator;
    imuCompensator.startListening();

    const { canvas, context, viewportSizes } = await withTimeout(
        was.init(configData),
        INIT_TIMEOUT_MS,
        'カメラの起動がタイムアウトしました。カメラ許可・HTTPS接続を確認して再試行してください。',
    );

    statusText.textContent = '3D モデルを読み込んでいます…';

    let model = null;
    let animationMixer = null;

    const renderer = new WebGLRenderer({
        canvas,
        context: context || undefined,
        antialias: true,
        alpha: true,
        logarithmicDepthBuffer: true,
    });

    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0xffffff, 0);
    renderer.clearColor();

    const scene = new Scene();
    const camera = new PerspectiveCamera(
        CAMERA_FOV,
        viewportSizes.width / viewportSizes.height,
        CAMERA_NEAR,
        CAMERA_FAR,
    );
    scene.add(camera);

    syncRendererViewport(was, renderer, camera);

    const [gltf] = await Promise.all([loadGltfModel(), loadHdrEnvironment(scene)]);

    model = gltf.scene;
    model.visible = false;
    scene.add(model);

    if (gltf.animations.length > 0) {
        animationMixer = new AnimationMixer(model);
        for (const clip of gltf.animations) {
            const action = animationMixer.clipAction(clip);
            action.setLoop(LoopRepeat, Infinity);
            action.play();
        }
    }

    const poseController = new PoseController({
        camera,
        model,
        imuCompensator,
        onStatusChange: (message) => {
            statusText.textContent = message;
        },
    });

    was.on(EVENT_DETECTED, (detectedData) => {
        poseController.onDetected(detectedData);
    }).catch(handleWasError);

    was.on(EVENT_LOST, (lostData) => {
        poseController.onLost(lostData);
    }).catch(handleWasError);

    was.on(EVENT_POSE, (poseData) => {
        poseController.onPose(poseData);
    }).catch(handleWasError);

    was.on(EVENT_DEVICE_ORIENTATION, (event) => {
        imuCompensator.handleOrientation(event);
    }).catch(handleWasError);

    was.on(EVENT_PROCESS, () => {}).catch(handleWasError);

    was.on(EVENT_RESIZE, () => {
        syncRendererViewport(was, renderer, camera);
    }).catch(handleWasError);

    was.on(EVENT_SCREEN_ORIENTATION, () => {}).catch(handleWasError);
    was.on(EVENT_VISIBILITY, () => {}).catch(handleWasError);

    was.on(EVENT_FRAME, (deltaTime) => {
        poseController.onFrame();
        if (animationMixer) {
            animationMixer.update(deltaTime / 1000);
        }
        renderer.render(scene, camera);
    }).catch(handleWasError);

    statusText.textContent = sdkConfig.searchingText;
}

/**
 * AR 開始ボタンの共通ハンドラ。
 * @param {'image' | 'qr'} trackingMode
 */
async function handleStart(trackingMode) {
    startImageBtn.disabled = true;
    startQrBtn.disabled = true;
    errorEl.hidden = true;
    errorEl.textContent = '';
    statusBar.hidden = false;

    // iOS: ボタンタップ直後にモーション許可を開始（await は後回し）
    const motionPromise = requestMotionPermissions();

    try {
        activateArView();
        statusText.textContent = trackingMode === 'image'
            ? 'カメラと画像マーカーを準備しています…'
            : 'カメラを起動しています…';

        await startQrAr(trackingMode);

        const motionGranted = await motionPromise;
        if (!motionGranted) {
            console.warn('[qr-ar] motion permission denied — IMU hold disabled');
        }
    } catch (error) {
        handleWasError(error instanceof Error ? error : new Error(String(error)));
    }
}

startImageBtn?.addEventListener('click', () => handleStart('image'));
startQrBtn?.addEventListener('click', () => handleStart('qr'));
