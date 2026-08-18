// public/qr-ar/ar-app.js — Open WebAR SDK による QR コード追跡 AR
import {
    WebGLRenderer,
    Scene,
    PerspectiveCamera,
    AnimationMixer,
    LoopRepeat,
    EquirectangularReflectionMapping,
    Quaternion,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import WAS, {
    ANCHOR_TYPE_CENTER,
    CAMERA_MODE_ENVIRONMENT,
    DEVICE_ERROR,
    EVENT_DETECTED,
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
    PROJECT_MODE_QR,
    TRIGGER_MODE_QR,
    VIDEO_ERROR,
    WORKER_ERROR,
} from '@web-ar-studio/webar-engine-sdk';

const CAMERA_FOV = 45;
const CAMERA_NEAR = 1;
const CAMERA_FAR = 100000;

const TEST_API_KEY = '52f80541de1715ba47f43522d648d0800c6e514d8b5e91b9b6e13ef9e1348cb8';

const startGuide = document.getElementById('qr-ar-start-guide');
const startBtn = document.getElementById('qr-ar-start-btn');
const errorEl = document.getElementById('qr-ar-error');
const mount = document.getElementById('qr-ar-mount');
const statusBar = document.getElementById('qr-ar-status');
const statusText = document.getElementById('qr-ar-status-text');

const triggerSource = 'trigger';
const gltfSource = new URL('./models/33.glb', import.meta.url).href;
const hdrSource = new URL('./assets/environment.hdr', import.meta.url).href;

/**
 * SDK から渡されたカメラ行列を Three.js カメラへ反映する。
 * @param {PerspectiveCamera} camera
 * @param {object} data
 */
function applySdkCamera(camera, data) {
    if (data.projectionMatrix && data.projectionMatrix.length === 16) {
        camera.projectionMatrix.fromArray(data.projectionMatrix);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        return;
    }

    const params = data.cameraParams;
    if (!params) return;

    const { fx, fy, cx, cy, width, height } = params;
    if (!(fx > 0 && fy > 0 && width > 0 && height > 0)) return;

    const near = camera.near;
    const far = camera.far;
    const left = (-cx * near) / fx;
    const right = ((width - cx) * near) / fx;
    const top = (cy * near) / fy;
    const bottom = (-(height - cy) * near) / fy;

    camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/**
 * 検出データからモデルの位置・向きを更新する。
 * @param {import('three').Object3D} model
 * @param {object} data
 */
function applyPoseToModel(model, data) {
    model.position.set(
        data.positionVector.x,
        data.positionVector.y,
        data.positionVector.z,
    );
    model.rotation.setFromQuaternion(
        new Quaternion(
            data.rotationQuaternion.x,
            data.rotationQuaternion.y,
            data.rotationQuaternion.z,
            data.rotationQuaternion.w,
        ),
    );
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
    startBtn.disabled = false;
    startGuide.hidden = false;
    mount.hidden = true;
    statusBar.hidden = true;
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
 * Open WebAR SDK で QR 追跡 AR を開始する。
 */
async function startQrAr() {
    if (!mount) {
        throw new Error('AR マウント要素が見つかりません。');
    }

    const apiKey = import.meta.env.VITE_WEBAR_API_KEY || TEST_API_KEY;
    const was = new WAS();

    const configData = {
        apiKey,
        mode: PROJECT_MODE_QR,
        cameraMode: CAMERA_MODE_ENVIRONMENT,
        container: mount,
        fov: CAMERA_FOV,
        triggers: [{ id: 1, mode: TRIGGER_MODE_QR, source: triggerSource }],
        isMultiTracking: true,
        anchor: ANCHOR_TYPE_CENTER,
    };

    const { canvas, context, viewportSizes } = await was.init(configData);

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
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setViewport(
        -(viewportSizes.width / 2 - mount.clientWidth / 2),
        -(viewportSizes.height / 2 - mount.clientHeight / 2),
        viewportSizes.width,
        viewportSizes.height,
    );
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

    let isAnchored = false;

    /**
     * 初回検出後はモデルを非表示に戻さず、SDK のポーズ更新を継続適用する。
     * @param {object} data
     */
    function updateAnchoredPose(data) {
        applySdkCamera(camera, data);
        if (!model) return;

        model.visible = true;
        applyPoseToModel(model, data);
        isAnchored = true;
        statusText.textContent = 'QR 追跡中';
    }

    /**
     * QR が見えなくなったとき、最後のポーズを保持して表示を継続する。
     * @param {object} data
     */
    function holdLastPose(data) {
        if (!isAnchored || !model) return;

        applySdkCamera(camera, data);
        applyPoseToModel(model, data);
        model.visible = true;
        statusText.textContent = '位置を維持中（QR 非表示）';
    }

    was.on(EVENT_DETECTED, (detectedData) => {
        for (const data of detectedData) {
            updateAnchoredPose(data);
        }
    }).catch(handleWasError);

    was.on(EVENT_LOST, (lostData) => {
        for (const data of lostData) {
            holdLastPose(data);
        }
    }).catch(handleWasError);

    was.on(EVENT_POSE, (poseData) => {
        for (const data of poseData) {
            updateAnchoredPose(data);
        }
    }).catch(handleWasError);

    was.on(EVENT_PROCESS, () => {}).catch(handleWasError);

    was.on(EVENT_RESIZE, () => {
        const sizes = was.getViewportSizes();
        renderer.setSize(mount.clientWidth, mount.clientHeight);
        renderer.setViewport(
            -(sizes.width / 2 - mount.clientWidth / 2),
            -(sizes.height / 2 - mount.clientHeight / 2),
            sizes.width,
            sizes.height,
        );
        camera.aspect = sizes.width / sizes.height;
        camera.updateProjectionMatrix();
    }).catch(handleWasError);

    was.on(EVENT_SCREEN_ORIENTATION, () => {}).catch(handleWasError);
    was.on(EVENT_VISIBILITY, () => {}).catch(handleWasError);

    was.on(EVENT_FRAME, (deltaTime) => {
        if (animationMixer) {
            animationMixer.update(deltaTime / 1000);
        }
        renderer.render(scene, camera);
    }).catch(handleWasError);
}

startBtn?.addEventListener('click', async () => {
    startBtn.disabled = true;
    errorEl.hidden = true;
    errorEl.textContent = '';

    try {
        startGuide.hidden = true;
        mount.hidden = false;
        statusBar.hidden = false;
        statusText.textContent = 'カメラを起動しています…';
        await startQrAr();
        statusText.textContent = 'QR を探しています…';
    } catch (error) {
        handleWasError(error instanceof Error ? error : new Error(String(error)));
    }
});
