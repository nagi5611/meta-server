// addons/qr-ar/client/ar/ar-renderer.js — カメラ映像 + Three.js AR 描画
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { applyOffsetInQrPlane } from './pose-from-qr.js';
import { loadGlbModel, disposeObject3D } from './model-loader.js';

/**
 * @typedef {import('./pose-from-qr.js').QrPose} QrPose
 * @typedef {{ cardId: string, modelUrl: string, modelScale: number, offset: { x: number, y: number, z: number }, qrPhysicalSizeM: number }} CardConfig
 */

/**
 * AR 描画コンテキストを構築する
 * @param {{ video: HTMLVideoElement, mount: HTMLElement }} opts
 */
export function createArRenderer(opts) {
    const { video, mount } = opts;

    video.className = 'qr-ar-video';
    mount.appendChild(video);

    const canvas = document.createElement('canvas');
    canvas.className = 'qr-ar-canvas';
    mount.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
    scene.add(camera);

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(1, 2, 1);
    scene.add(dir);

    const anchor = new THREE.Group();
    scene.add(anchor);

    /** @type {THREE.Group|null} */
    let modelRoot = null;
    /** @type {CardConfig|null} */
    let activeCard = null;
    /** @type {Promise<void>|null} */
    let loadPromise = null;
    let visible = false;

    const resize = () => {
        const w = mount.clientWidth || window.innerWidth;
        const h = mount.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        video.style.width = `${w}px`;
        video.style.height = `${h}px`;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
    };

    resize();
    window.addEventListener('resize', resize);

    /**
     * @param {CardConfig} card
     */
    async function setCard(card) {
        if (!card?.modelUrl) return;
        if (activeCard?.cardId === card.cardId && modelRoot) {
            activeCard = card;
            return;
        }
        activeCard = card;
        const url = card.modelUrl;
        loadPromise = (async () => {
            const next = await loadGlbModel(url);
            if (activeCard?.modelUrl !== url) {
                disposeObject3D(next);
                return;
            }
            if (modelRoot) {
                anchor.remove(modelRoot);
                disposeObject3D(modelRoot);
            }
            modelRoot = next;
            anchor.add(modelRoot);
        })();
        await loadPromise;
    }

    /**
     * @param {QrPose|null} pose
     */
    function updatePose(pose) {
        if (!pose || !modelRoot || !activeCard) {
            visible = false;
            anchor.visible = false;
            return;
        }
        visible = true;
        anchor.visible = true;
        const offset = applyOffsetInQrPlane(activeCard.offset || { x: 0, y: 0, z: 0 }, pose.angle);
        anchor.position.set(
            pose.position.x + offset.x,
            pose.position.y + offset.y,
            pose.position.z + offset.z
        );
        anchor.rotation.set(0, 0, pose.angle);
        const scale = (activeCard.modelScale || 1) * (pose.width / 120);
        anchor.scale.setScalar(scale);
    }

    function render() {
        renderer.render(scene, camera);
    }

    function dispose() {
        window.removeEventListener('resize', resize);
        if (modelRoot) {
            anchor.remove(modelRoot);
            disposeObject3D(modelRoot);
            modelRoot = null;
        }
        renderer.dispose();
        video.remove();
        canvas.remove();
    }

    return {
        setCard,
        updatePose,
        render,
        dispose,
        getActiveCardId: () => activeCard?.cardId || null,
        isVisible: () => visible,
    };
}
