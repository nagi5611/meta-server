// public/pre_xr/js/main.js — XR テストサイトエントリ

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { XRControllerModelFactory } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/webxr/XRControllerModelFactory.js';
import { InputMonitor } from './input-monitor.js';
import { PreXrLocomotion } from './locomotion.js';
import { VrMenuHarness } from './vr-menu-harness.js';

const THREE_CDN = '0.160.0';

/** 簡易 VR 入室ボタン */
function createVrButton(renderer, domOverlayRoot) {
    const optionalFeatures = ['local-floor'];
    if (domOverlayRoot) optionalFeatures.push('dom-overlay');

    /** @type {XRSessionInit} */
    const sessionInit = { optionalFeatures };
    if (domOverlayRoot) {
        sessionInit.domOverlay = { root: domOverlayRoot };
    }

    const button = document.createElement('button');
    button.id = 'pre-xr-vr-button';
    button.textContent = 'VR';
    button.style.display = 'none';

    let currentSession = null;

    async function onSessionStarted(session) {
        session.addEventListener('end', onSessionEnded);
        await renderer.xr.setSession(session);
        button.textContent = 'VR 終了';
        currentSession = session;
    }

    function onSessionEnded() {
        currentSession?.removeEventListener('end', onSessionEnded);
        button.textContent = 'VR';
        currentSession = null;
    }

    function tryEnterVR() {
        if (currentSession) {
            currentSession.end();
            return;
        }
        navigator.xr.requestSession('immersive-vr', sessionInit)
            .then(onSessionStarted)
            .catch((err) => {
                console.warn('[pre_xr] requestSession failed, retry without dom-overlay:', err);
                navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] })
                    .then(onSessionStarted)
                    .catch((e) => {
                        console.warn('[pre_xr] retry without local-floor:', e);
                        navigator.xr.requestSession('immersive-vr', { optionalFeatures: [] })
                            .then(onSessionStarted)
                            .catch((e2) => console.error('[pre_xr] session failed:', e2));
                    });
            });
    }

    if (!('xr' in navigator)) {
        button.disabled = true;
        button.textContent = 'WebXR 非対応';
        return button;
    }

    navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
        if (!supported) {
            button.disabled = true;
            button.textContent = 'VR 非対応';
            return;
        }
        button.style.display = '';
        button.onclick = tryEnterVR;
    }).catch(() => {
        button.disabled = true;
        button.textContent = 'WebXR エラー';
    });

    return button;
}

/** 検証用ワールド（グリッド床・方位マーカー） */
function buildTestWorld(scene) {
    scene.background = new THREE.Color(0x87b8e8);
    scene.fog = new THREE.Fog(0x87b8e8, 8, 48);

    const hemi = new THREE.HemisphereLight(0xddeeff, 0x445566, 0.85);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.65);
    dir.position.set(6, 12, 4);
    scene.add(dir);

    const floorGeo = new THREE.PlaneGeometry(40, 40);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x6a8a6a, roughness: 0.9 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(40, 40, 0x334455, 0x556677);
    grid.position.y = 0.01;
    scene.add(grid);

    const markerColors = [0xff4444, 0x44ff44, 0x4444ff, 0xffcc44];
    const labels = ['+X', '+Z', '-X', '-Z'];
    const positions = [[8, 0, 0], [0, 0, 8], [-8, 0, 0], [0, 0, -8]];
    for (let i = 0; i < 4; i++) {
        const pillar = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 2.2, 0.6),
            new THREE.MeshStandardMaterial({ color: markerColors[i] })
        );
        pillar.position.set(positions[i][0], 1.1, positions[i][2]);
        scene.add(pillar);

        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 36px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(labels[i], 64, 44);
        const tex = new THREE.CanvasTexture(canvas);
        const sign = new THREE.Mesh(
            new THREE.PlaneGeometry(1.2, 0.6),
            new THREE.MeshBasicMaterial({ map: tex, transparent: true })
        );
        sign.position.set(positions[i][0], 2.6, positions[i][2]);
        sign.lookAt(positions[i][0], 2.6, positions[i][2] + (i === 1 ? 1 : i === 3 ? -1 : 0));
        if (i === 0) sign.rotation.y = -Math.PI / 2;
        if (i === 2) sign.rotation.y = Math.PI / 2;
        scene.add(sign);
    }

    const center = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, 0.08, 24),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x224466 })
    );
    center.position.y = 0.04;
    scene.add(center);

    return floor;
}

/** デスクトップ用簡易操作 */
function setupDesktopControls(camera, keys) {
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    let pointerDown = false;
    let lastX = 0;
    let lastY = 0;

    window.addEventListener('keydown', (e) => { keys[e.code] = true; });
    window.addEventListener('keyup', (e) => { keys[e.code] = false; });
    window.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        pointerDown = true;
        lastX = e.clientX;
        lastY = e.clientY;
    });
    window.addEventListener('pointerup', () => { pointerDown = false; });
    window.addEventListener('pointermove', (e) => {
        if (!pointerDown) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        euler.setFromQuaternion(camera.quaternion);
        euler.y -= dx * 0.003;
        euler.x -= dy * 0.003;
        euler.x = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, euler.x));
        camera.quaternion.setFromEuler(euler);
    });

    return (deltaTime, presenting) => {
        if (presenting) return;
        const speed = 4 * deltaTime;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        fwd.y = 0;
        fwd.normalize();
        const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).normalize();
        if (keys.KeyW) camera.position.addScaledVector(fwd, speed);
        if (keys.KeyS) camera.position.addScaledVector(fwd, -speed);
        if (keys.KeyA) camera.position.addScaledVector(right, speed);
        if (keys.KeyD) camera.position.addScaledVector(right, -speed);
    };
}

async function main() {
    const overlayRoot = document.getElementById('pre-xr-overlay-root');
    const desktopHud = document.getElementById('pre-xr-desktop-hud');

    const monitor = new InputMonitor({
        statusText: document.getElementById('pre-xr-status-text'),
        inputSources: document.getElementById('pre-xr-input-sources'),
        locoState: document.getElementById('pre-xr-loco-state'),
        eventLog: document.getElementById('pre-xr-event-log'),
        fps: document.getElementById('pre-xr-fps')
    });

    const scene = new THREE.Scene();
    const floorMesh = buildTestWorld(scene);

    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.08, 120);
    camera.position.set(0, 1.6, 4);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    document.body.prepend(renderer.domElement);

    const raycaster = new THREE.Raycaster();
    const locomotion = new PreXrLocomotion({
        scene,
        camera,
        renderer,
        raycaster,
        floorMesh,
        onLog: (msg) => monitor.logEvent(msg)
    });

    const vrMenuHarness = new VrMenuHarness({
        renderer,
        camera,
        stateEl: document.getElementById('pre-xr-vr-menu-state'),
        yEl: document.getElementById('pre-xr-y-button'),
        fontEl: document.getElementById('pre-xr-vr-font'),
        toggleBtn: document.getElementById('pre-xr-menu-toggle-btn'),
        onLog: (msg) => monitor.logEvent(msg),
    });

    document.querySelectorAll('[data-loco-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-loco-mode');
            if (mode === 'both' || mode === 'smooth' || mode === 'teleport') {
                locomotion.setMode(mode);
                document.querySelectorAll('[data-loco-mode]').forEach((b) => {
                    b.classList.toggle('active', b.getAttribute('data-loco-mode') === mode);
                });
                monitor.logEvent(`loco mode → ${mode}`);
            }
        });
    });

    const controllerFactory = new XRControllerModelFactory();
    for (let i = 0; i < 2; i++) {
        const controller = renderer.xr.getController(i);
        scene.add(controller);
        const grip = renderer.xr.getControllerGrip(i);
        grip.add(controllerFactory.createControllerModel(grip));
        scene.add(grip);
    }

    const vrButton = createVrButton(renderer, overlayRoot);
    document.body.appendChild(vrButton);

    let webxrSupported = false;
    if ('xr' in navigator) {
        try {
            webxrSupported = await navigator.xr.isSessionSupported('immersive-vr');
        } catch (_) { /* ignore */ }
    }

    const keys = {};
    const updateDesktop = setupDesktopControls(camera, keys);

    let refSpaceLabel = '—';

    renderer.xr.addEventListener('sessionstart', () => {
        locomotion.attach();
        vrMenuHarness.attach();
        desktopHud.hidden = true;
        refSpaceLabel = 'local-floor (希望)';
        monitor.logEvent('sessionstart');
    });
    renderer.xr.addEventListener('sessionend', () => {
        locomotion.detach();
        vrMenuHarness.detach();
        camera.position.set(0, 1.6, 4);
        camera.rotation.set(0, 0, 0);
        desktopHud.hidden = false;
        refSpaceLabel = '—';
        monitor.logEvent('sessionend');
    });

    const clock = new THREE.Clock();

    renderer.setAnimationLoop(() => {
        const deltaTime = Math.min(clock.getDelta(), 0.05);
        const presenting = renderer.xr.isPresenting;

        updateDesktop(deltaTime, presenting);

        let inp = null;
        if (presenting) {
            inp = locomotion.update(deltaTime);
        }

        monitor.tickFps(deltaTime);

        const rig = locomotion.getRigState();
        const session = renderer.xr.getSession();
        monitor.updateStatus({
            webxrSupported,
            presenting,
            refSpace: refSpaceLabel,
            inputSourceCount: session?.inputSources?.length ?? 0,
            rigPos: presenting ? `(${rig.x.toFixed(2)}, ${rig.y.toFixed(2)}, ${rig.z.toFixed(2)})` : '—',
            rigYawDeg: presenting ? rig.yawDeg : '—',
            camPos: `(${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})`
        });

        if (inp) {
            monitor.updateInputPanel(inp.allInputSources);
            monitor.updateLocoPanel({
                mode: locomotion.mode,
                moveX: inp.moveX,
                moveY: inp.moveY,
                moveMag: inp.moveMag,
                snapX: inp.snapX,
                leftGrip: inp.leftGrip,
                leftY: inp.leftY,
                ySummary: inp.ySummary,
                axisTag: inp.axisTag,
                rawHypot: inp.rawHypot,
                hasMoveGamepad: inp.hasMoveGamepad
            });
            vrMenuHarness.update(true);
        } else if (!presenting) {
            monitor.updateInputPanel([]);
            monitor.updateLocoPanel({
                mode: locomotion.mode,
                moveX: 0,
                moveY: 0,
                moveMag: 0,
                snapX: 0,
                leftGrip: false,
                leftY: false,
                ySummary: '—',
                axisTag: '—',
                rawHypot: 0,
                hasMoveGamepad: false
            });
            vrMenuHarness.update(false);
        }

        renderer.render(scene, camera);
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    desktopHud.hidden = false;
    monitor.logEvent(`pre_xr ready (three@${THREE_CDN})`);
    monitor.updateStatus({
        webxrSupported,
        presenting: false,
        refSpace: '—',
        inputSourceCount: 0,
        rigPos: '—',
        rigYawDeg: '—',
        camPos: `(${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})`
    });
}

main().catch((err) => {
    console.error('[pre_xr] init failed:', err);
    const el = document.getElementById('pre-xr-status-text');
    if (el) el.textContent = `初期化エラー: ${err.message || err}`;
});
