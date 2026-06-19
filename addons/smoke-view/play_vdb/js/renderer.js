// addons/smoke-view/play_vdb/js/renderer.js — WebGPU + PicoVDB レンダラー
import { vec3, mat4 } from 'https://esm.sh/wgpu-matrix@3.0.2';
import { createOrbitCamera } from './lib/camera.js';
import { createInputHandler } from './lib/input.js';
import { createSkyState } from './lib/hw-skymodel.js';
import { gridTypeLabel } from './picovdb-file.js';
import {
    createDefaultShaderSettings,
    RENDER_SETTINGS_BYTE_LENGTH,
    snapMsaaSamples,
    sunDirectionFromDegrees,
    writeRenderSettingsBuffer,
} from './shader-settings.js';

const SHADER_BASE = '/play_vdb/shaders/';
const OBJECT_STRUCT_SIZE = 144;
const OBJECT_COUNT = 2;
const FOV = (2 * Math.PI) / 5;
const INPUT_BYTE_LENGTH = 96;
const TAA_SETTINGS_BYTE_LENGTH = 16;

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
async function fetchShader(path) {
    const res = await fetch(`${SHADER_BASE}${path}`);
    if (!res.ok) throw new Error(`Shader load failed: ${path} (${res.status})`);
    return res.text();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onStatus?: (msg: string) => void, onInfo?: (msg: string) => void, onFps?: (fps: number) => void }} [callbacks]
 */
export async function createPlayVdbRenderer(canvas, callbacks = {}) {
    const onStatus = callbacks.onStatus || (() => {});
    const onInfo = callbacks.onInfo || (() => {});
    const onFps = callbacks.onFps || (() => {});

    if (!navigator.gpu) {
        const insecure = window.isSecureContext === false;
        throw new Error(
            insecure
                ? 'WebGPU には HTTPS または localhost が必要です。'
                : 'このブラウザは WebGPU に対応していません（Chrome/Edge 113+ 推奨）。',
        );
    }

    onStatus('WebGPU アダプタを取得中…');
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: 'compatibility' });
    if (!adapter) throw new Error('GPU アダプタが見つかりません。');

    const device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (event) => {
        console.error('[play_vdb] GPU error:', event.error);
        onStatus(`GPU エラー: ${event.error?.message || event.error}`);
    });

    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('WebGPU コンテキストを取得できません。');

    let width = canvas.width;
    let height = canvas.height;

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: canvasFormat });

    onStatus('シェーダーを読み込み中…');
    const [picoVdbWgsl, computeWgsl, blitWgsl, taaWgsl] = await Promise.all([
        fetchShader('picovdb.wgsl'),
        fetchShader('compute.wgsl'),
        fetchShader('blit.wgsl'),
        fetchShader('taa.wgsl'),
    ]);

    const vertices = new Float32Array([-1, 3, 3, -1, -1, -1]);
    const vertexBuffer = device.createBuffer({
        label: 'Display vertices',
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, vertices);

    const vertexBufferLayout = {
        arrayStride: 8,
        attributes: [{ format: 'float32x2', offset: 0, shaderLocation: 0 }],
    };

    const displaySampler = device.createSampler({
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        magFilter: 'linear',
        minFilter: 'linear',
    });

    const displayShaderModule = device.createShaderModule({ label: 'Display shader', code: blitWgsl });
    const displayPipeline = device.createRenderPipeline({
        label: 'Display pipeline',
        layout: 'auto',
        vertex: {
            module: displayShaderModule,
            entryPoint: 'vertexMain',
            buffers: [vertexBufferLayout],
        },
        fragment: {
            module: displayShaderModule,
            entryPoint: 'fragmentMain',
            targets: [{ format: canvasFormat }],
        },
    });

    const combinedShader = `${picoVdbWgsl}\n${computeWgsl}`;
    const computeShaderModule = device.createShaderModule({
        label: 'Raytracing Compute Shader',
        code: combinedShader,
    });

    const shaderInfo = await computeShaderModule.getCompilationInfo();
    for (const message of shaderInfo.messages) {
        if (message.type === 'error') {
            throw new Error(`シェーダーエラー L${message.lineNum}: ${message.message}`);
        }
    }

    const perFrameBindGroupLayout = device.createBindGroupLayout({
        label: 'Per-frame Bind Group Layout',
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
    });

    const dataBindGroupLayout = device.createBindGroupLayout({
        label: 'Data Bind Group Layout',
        entries: Array.from({ length: 6 }, (_, binding) => ({
            binding,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: 'read-only-storage' },
        })),
    });

    const passBindGroupLayout = device.createBindGroupLayout({
        label: 'Pass Bind Group Layout',
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
        }],
    });

    const computePipelineLayout = device.createPipelineLayout({
        label: 'Compute Pipeline Layout',
        bindGroupLayouts: [perFrameBindGroupLayout, dataBindGroupLayout, passBindGroupLayout],
    });

    const computePipeline = await device.createComputePipelineAsync({
        label: 'Compute Pipeline',
        layout: computePipelineLayout,
        compute: { module: computeShaderModule, entryPoint: 'computeMain' },
    });

    const taaShaderModule = device.createShaderModule({ label: 'TAA shader', code: taaWgsl });
    const taaBindGroupLayout = device.createBindGroupLayout({
        label: 'TAA Bind Group Layout',
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
            {
                binding: 2,
                visibility: GPUShaderStage.COMPUTE,
                storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
            },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
    });
    const taaPipelineLayout = device.createPipelineLayout({
        label: 'TAA Pipeline Layout',
        bindGroupLayouts: [taaBindGroupLayout],
    });
    const taaPipeline = await device.createComputePipelineAsync({
        label: 'TAA Pipeline',
        layout: taaPipelineLayout,
        compute: { module: taaShaderModule, entryPoint: 'taaMain' },
    });

    const inputValues = new ArrayBuffer(INPUT_BYTE_LENGTH);
    const inputViews = {
        camera_matrix: new Float32Array(inputValues, 0, 16),
        fov_scale: new Float32Array(inputValues, 64, 1),
        time_delta: new Float32Array(inputValues, 68, 1),
        pixel_radius: new Float32Array(inputValues, 72, 1),
        debug_iterations: new Uint32Array(inputValues, 76, 1),
        frame_index: new Uint32Array(inputValues, 80, 1),
        sample_count: new Uint32Array(inputValues, 84, 1),
    };
    inputViews.fov_scale[0] = Math.tan(FOV / 2);

    const inputBuffer = device.createBuffer({
        label: 'Input Uniforms',
        size: inputValues.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const objectsData = new ArrayBuffer(OBJECT_STRUCT_SIZE * OBJECT_COUNT);
    const objectsBuffer = device.createBuffer({
        label: 'Objects',
        size: objectsData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const objectViews = [];
    for (let index = 0; index < OBJECT_COUNT; index++) {
        const offset = OBJECT_STRUCT_SIZE * index;
        objectViews.push({
            object_type: new Uint32Array(objectsData, offset + 0, 1),
            type_index: new Uint32Array(objectsData, offset + 4, 1),
            material_index: new Uint32Array(objectsData, offset + 8, 1),
            transform: new Float32Array(objectsData, offset + 16, 16),
            transform_inverse: new Float32Array(objectsData, offset + 80, 16),
        });
    }

    const vdbObjectView = objectViews[0];
    vdbObjectView.object_type[0] = 1;
    vdbObjectView.type_index[0] = 0;
    vdbObjectView.material_index[0] = 0;

    const groundObjectView = objectViews[1];
    groundObjectView.object_type[0] = 2;
    groundObjectView.type_index[0] = 0;
    groundObjectView.material_index[0] = 1;
    groundObjectView.transform.set(mat4.translation(vec3.create(0, 2, 0)));
    groundObjectView.transform_inverse.set(mat4.translation(vec3.create(0, -2, 0)));

    /** @type {import('./shader-settings.js').ShaderSettings} */
    let shaderSettings = createDefaultShaderSettings();
    inputViews.sample_count[0] = snapMsaaSamples(shaderSettings.msaaSamples);

    const renderSettingsData = new ArrayBuffer(RENDER_SETTINGS_BYTE_LENGTH);
    const renderSettingsBuffer = device.createBuffer({
        label: 'Render Settings',
        size: RENDER_SETTINGS_BYTE_LENGTH,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const skyStateData = new ArrayBuffer(144);
    const skyStateBuffer = device.createBuffer({
        label: 'SkyState',
        size: skyStateData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const skyStateView = {
        sunDirection: new Float32Array(skyStateData, 0, 3),
        params: new Float32Array(skyStateData, 12, 27),
        skyRadiances: new Float32Array(skyStateData, 120, 3),
        solarRadiances: new Float32Array(skyStateData, 132, 3),
    };

    /** Rebuild Hosek-Wilkie sky coefficients from shader settings. */
    function updateSkyFromSettings() {
        const elevation = (shaderSettings.sunElevationDeg * Math.PI) / 180;
        const skyState = createSkyState({
            elevation,
            turbidity: shaderSettings.turbidity,
            albedo: [0.3, 0.3, 0.3],
        });
        const [sx, sy, sz] = sunDirectionFromDegrees(
            shaderSettings.sunElevationDeg,
            shaderSettings.sunAzimuthDeg,
        );
        skyStateView.sunDirection.set([sx, sy, sz]);
        skyStateView.params.set(skyState.params);
        skyStateView.skyRadiances.set(skyState.skyRadiances);
        skyStateView.solarRadiances.set(skyState.solarRadiances);
    }

    function uploadRenderSettings() {
        writeRenderSettingsBuffer(renderSettingsData, shaderSettings);
        device.queue.writeBuffer(renderSettingsBuffer, 0, renderSettingsData);
    }

    uploadRenderSettings();

    const taaSettingsData = new ArrayBuffer(TAA_SETTINGS_BYTE_LENGTH);
    const taaSettingsViews = {
        blend: new Float32Array(taaSettingsData, 0, 1),
        history_valid: new Uint32Array(taaSettingsData, 4, 1),
    };
    const taaSettingsBuffer = device.createBuffer({
        label: 'TAA Settings',
        size: TAA_SETTINGS_BYTE_LENGTH,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    updateSkyFromSettings();

    const inputHandler = createInputHandler(window, canvas);
    const initialCameraPosition = vec3.create(3, 2, 5);
    const initialCameraTarget = vec3.create(0, 0, 0);
    let camera = createOrbitCamera({
        position: initialCameraPosition,
        target: initialCameraTarget,
    });

    /** @type {GPUBuffer | null} */
    let gridsBuffer = null;
    /** @type {GPUBuffer | null} */
    let rootsBuffer = null;
    /** @type {GPUBuffer | null} */
    let uppersBuffer = null;
    /** @type {GPUBuffer | null} */
    let lowersBuffer = null;
    /** @type {GPUBuffer | null} */
    let leavesBuffer = null;
    /** @type {GPUBuffer | null} */
    let dataBuffer = null;

    /** @type {{ translation: number[], scale: number }} */
    let currentTransform = { translation: [0, 0, 0], scale: 1 };

    /** @type {GPUTexture | null} */
    let raytracedTexture = null;
    /** @type {GPUTexture | null} */
    let taaHistoryTexture = null;
    /** @type {GPUTexture | null} */
    let taaResolvedTexture = null;
    /** @type {GPUTexture | null} */
    let displaySourceTexture = null;
    /** @type {GPUBindGroup | null} */
    let displayBindGroup = null;
    /** @type {GPUBindGroup | null} */
    let taaBindGroup = null;
    /** @type {GPUBindGroup | null} */
    let perFrameBindGroup = null;
    /** @type {GPUBindGroup | null} */
    let dataBindGroup = null;
    /** @type {GPUBindGroup | null} */
    let passBindGroup = null;

    let frameIndex = 0;
    let taaHistoryValid = false;
    const prevCameraMatrix = new Float32Array(16);

    /** Invalidate TAA accumulation (resize, camera reset, new file). */
    function resetTaaHistory() {
        taaHistoryValid = false;
        frameIndex = 0;
    }

    /** @returns {boolean} */
    function cameraMovedSinceLastFrame() {
        for (let i = 0; i < 16; i++) {
            if (Math.abs(camera.matrix[i] - prevCameraMatrix[i]) > 1e-5) {
                return true;
            }
        }
        return false;
    }

    function computePixelRadius() {
        inputViews.pixel_radius[0] = (2.0 * inputViews.fov_scale[0]) / height;
    }

    function updateObjects() {
        const transformMatrix = mat4.identity();
        const [tx, ty, tz] = currentTransform.translation;
        const s = currentTransform.scale;
        mat4.translation(vec3.create(tx, ty, tz), transformMatrix);
        mat4.scale(transformMatrix, vec3.create(s, s, s), transformMatrix);
        vdbObjectView.transform.set(transformMatrix);
        vdbObjectView.transform_inverse.set(mat4.inverse(transformMatrix));
        device.queue.writeBuffer(objectsBuffer, 0, objectsData);
        device.queue.writeBuffer(skyStateBuffer, 0, skyStateData);
    }

    function createGPUResources() {
        if (raytracedTexture) raytracedTexture.destroy();
        if (taaHistoryTexture) taaHistoryTexture.destroy();
        if (taaResolvedTexture) taaResolvedTexture.destroy();

        const textureUsage = GPUTextureUsage.STORAGE_BINDING
            | GPUTextureUsage.TEXTURE_BINDING
            | GPUTextureUsage.COPY_SRC;

        raytracedTexture = device.createTexture({
            size: [width, height],
            format: 'rgba8unorm',
            usage: textureUsage,
        });

        taaHistoryTexture = device.createTexture({
            label: 'TAA history',
            size: [width, height],
            format: 'rgba8unorm',
            usage: textureUsage,
        });

        taaResolvedTexture = device.createTexture({
            label: 'TAA resolved',
            size: [width, height],
            format: 'rgba8unorm',
            usage: textureUsage,
        });

        displaySourceTexture = taaResolvedTexture;

        displayBindGroup = device.createBindGroup({
            label: 'Display bind group',
            layout: displayPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: displaySourceTexture.createView() },
                { binding: 1, resource: displaySampler },
            ],
        });

        taaBindGroup = device.createBindGroup({
            label: 'TAA bind group',
            layout: taaBindGroupLayout,
            entries: [
                { binding: 0, resource: raytracedTexture.createView() },
                { binding: 1, resource: taaHistoryTexture.createView() },
                { binding: 2, resource: taaResolvedTexture.createView() },
                { binding: 3, resource: { buffer: taaSettingsBuffer } },
            ],
        });

        perFrameBindGroup = device.createBindGroup({
            label: 'Per-frame bind group',
            layout: perFrameBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: inputBuffer } },
                { binding: 1, resource: { buffer: objectsBuffer } },
                { binding: 2, resource: { buffer: skyStateBuffer } },
                { binding: 3, resource: { buffer: renderSettingsBuffer } },
            ],
        });

        if (gridsBuffer) {
            dataBindGroup = device.createBindGroup({
                label: 'Data bind group',
                layout: dataBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: gridsBuffer } },
                    { binding: 1, resource: { buffer: rootsBuffer } },
                    { binding: 2, resource: { buffer: uppersBuffer } },
                    { binding: 3, resource: { buffer: lowersBuffer } },
                    { binding: 4, resource: { buffer: leavesBuffer } },
                    { binding: 5, resource: { buffer: dataBuffer } },
                ],
            });
        }

        passBindGroup = device.createBindGroup({
            label: 'Pass bind group',
            layout: passBindGroupLayout,
            entries: [{ binding: 0, resource: raytracedTexture.createView() }],
        });

        computePixelRadius();
        resetTaaHistory();
    }

    function resizeCanvas() {
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(window.innerWidth * pixelRatio);
        canvas.height = Math.floor(window.innerHeight * pixelRatio);
        width = canvas.width;
        height = canvas.height;
        if (raytracedTexture) createGPUResources();
    }

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    createGPUResources();
    updateObjects();

    /**
     * @param {import('./picovdb-file.js').PicoVDBFile} picoVDBFile
     * @param {{ translation: number[], scale: number }} transform
     */
    function uploadPicoVDB(picoVDBFile, transform) {
        if (picoVDBFile.header.gridCount === 0) {
            throw new Error('PicoVDB にグリッドがありません');
        }

        if (gridsBuffer) {
            gridsBuffer.destroy();
            rootsBuffer.destroy();
            uppersBuffer.destroy();
            lowersBuffer.destroy();
            leavesBuffer.destroy();
            dataBuffer.destroy();
        }

        gridsBuffer = device.createBuffer({
            label: 'PicoVDB Grids',
            size: picoVDBFile.gridsBuffer.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(gridsBuffer, 0, picoVDBFile.gridsBuffer);

        rootsBuffer = device.createBuffer({
            label: 'PicoVDB Roots',
            size: picoVDBFile.rootsBuffer.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(rootsBuffer, 0, picoVDBFile.rootsBuffer);

        uppersBuffer = device.createBuffer({
            label: 'PicoVDB Uppers',
            size: picoVDBFile.uppersBuffer.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(uppersBuffer, 0, picoVDBFile.uppersBuffer);

        lowersBuffer = device.createBuffer({
            label: 'PicoVDB Lowers',
            size: picoVDBFile.lowersBuffer.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(lowersBuffer, 0, picoVDBFile.lowersBuffer);

        leavesBuffer = device.createBuffer({
            label: 'PicoVDB Leaves',
            size: picoVDBFile.leavesBuffer.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(leavesBuffer, 0, picoVDBFile.leavesBuffer);

        dataBuffer = device.createBuffer({
            label: 'PicoVDB Data',
            size: picoVDBFile.dataBuffer.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(dataBuffer, 0, picoVDBFile.dataBuffer);

        currentTransform = transform;
        createGPUResources();
        updateObjects();
        resetTaaHistory();

        const grid = picoVDBFile.getGrid(0);
        const sizeMB = (picoVDBFile.getSize() / 1024 / 1024).toFixed(2);
        const bbox = [
            grid.indexBoundsMax[0] - grid.indexBoundsMin[0],
            grid.indexBoundsMax[1] - grid.indexBoundsMin[1],
            grid.indexBoundsMax[2] - grid.indexBoundsMin[2],
        ];
        onInfo([
            `ファイル: ${sizeMB} MiB`,
            `グリッド型: ${gridTypeLabel(grid.gridType)}`,
            `BBox: ${bbox[0]} × ${bbox[1]} × ${bbox[2]}`,
            `ボクセル数: ${picoVDBFile.getVoxelCount()}`,
            `スケール: ${transform.scale.toFixed(2)}`,
        ].join('\n'));
        onStatus('レンダリング中');
    }

    function updateInput(deltaTime) {
        inputViews.time_delta[0] = deltaTime;
        inputViews.debug_iterations[0] = 0;
        inputViews.frame_index[0] = frameIndex;
        inputViews.sample_count[0] = snapMsaaSamples(shaderSettings.msaaSamples);
        camera.update(deltaTime, inputHandler());
        inputViews.camera_matrix.set(camera.matrix);
        if (cameraMovedSinceLastFrame()) {
            taaHistoryValid = false;
        }
        prevCameraMatrix.set(camera.matrix);
        frameIndex += 1;
        device.queue.writeBuffer(inputBuffer, 0, inputValues);
    }

    function uploadTaaSettings() {
        taaSettingsViews.blend[0] = shaderSettings.taaBlend;
        taaSettingsViews.history_valid[0] = taaHistoryValid ? 1 : 0;
        device.queue.writeBuffer(taaSettingsBuffer, 0, taaSettingsData);
    }

    function updateDisplayBindGroup() {
        displayBindGroup = device.createBindGroup({
            label: 'Display bind group',
            layout: displayPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: displaySourceTexture.createView() },
                { binding: 1, resource: displaySampler },
            ],
        });
    }

    function swapTaaHistory() {
        const resolved = taaResolvedTexture;
        taaResolvedTexture = taaHistoryTexture;
        taaHistoryTexture = resolved;
        displaySourceTexture = taaResolvedTexture;

        taaBindGroup = device.createBindGroup({
            label: 'TAA bind group',
            layout: taaBindGroupLayout,
            entries: [
                { binding: 0, resource: raytracedTexture.createView() },
                { binding: 1, resource: taaHistoryTexture.createView() },
                { binding: 2, resource: taaResolvedTexture.createView() },
                { binding: 3, resource: { buffer: taaSettingsBuffer } },
            ],
        });
        updateDisplayBindGroup();
        taaHistoryValid = true;
    }

    const colorAttachment = {
        view: /** @type {GPUTextureView} */ (null),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
    };

    const renderPassDescriptor = {
        label: 'Display pass',
        colorAttachments: [colorAttachment],
    };

    let lastFrameMs = performance.now();
    let fpsAccum = 0;
    let fpsFrames = 0;

    function requestFrame() {
        if (!dataBindGroup || !raytracedTexture) return;

        const now = performance.now();
        const deltaTime = (now - lastFrameMs) / 1000;
        lastFrameMs = now;
        fpsAccum += deltaTime;
        fpsFrames += 1;
        if (fpsAccum >= 0.5) {
            onFps(Math.round(fpsFrames / fpsAccum));
            fpsAccum = 0;
            fpsFrames = 0;
        }

        const encoder = device.createCommandEncoder({ label: 'Command Encoder' });

        uploadTaaSettings();

        const computePass = encoder.beginComputePass({ label: 'Compute pass' });
        computePass.setPipeline(computePipeline);
        computePass.setBindGroup(0, perFrameBindGroup);
        computePass.setBindGroup(1, dataBindGroup);
        computePass.setBindGroup(2, passBindGroup);
        computePass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
        computePass.end();

        if (shaderSettings.taaEnabled && taaBindGroup) {
            const taaPass = encoder.beginComputePass({ label: 'TAA pass' });
            taaPass.setPipeline(taaPipeline);
            taaPass.setBindGroup(0, taaBindGroup);
            taaPass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
            taaPass.end();
            swapTaaHistory();
        } else {
            displaySourceTexture = raytracedTexture;
            updateDisplayBindGroup();
            taaHistoryValid = false;
        }

        colorAttachment.view = context.getCurrentTexture().createView();
        const displayPass = encoder.beginRenderPass(renderPassDescriptor);
        displayPass.setPipeline(displayPipeline);
        displayPass.setVertexBuffer(0, vertexBuffer);
        displayPass.setBindGroup(0, displayBindGroup);
        displayPass.draw(3, 1, 0, 0);
        displayPass.end();

        updateInput(deltaTime);
        device.queue.submit([encoder.finish()]);
    }

    let animationId = null;

    function startLoop() {
        if (animationId !== null) return;
        const loop = () => {
            animationId = requestAnimationFrame(loop);
            requestFrame();
        };
        animationId = requestAnimationFrame(loop);
    }

    function stopLoop() {
        if (animationId !== null) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
    }

    onStatus('準備完了 — .pvdb / .pvdb.gz を開いてください');
    startLoop();

    return {
        uploadPicoVDB,
        stopLoop,
        getShaderSettings() {
            return {
                ...shaderSettings,
                smokeColor: [...shaderSettings.smokeColor],
                volFogColor: [...shaderSettings.volFogColor],
            };
        },
        /**
         * @param {Partial<import('./shader-settings.js').ShaderSettings>} partial
         */
        setShaderSettings(partial) {
            const prev = shaderSettings;
            shaderSettings = {
                ...shaderSettings,
                ...partial,
                smokeColor: partial.smokeColor
                    ? /** @type {[number, number, number]} */ ([...partial.smokeColor])
                    : shaderSettings.smokeColor,
                volFogColor: partial.volFogColor
                    ? /** @type {[number, number, number]} */ ([...partial.volFogColor])
                    : shaderSettings.volFogColor,
            };
            uploadRenderSettings();
            if (
                prev.sunElevationDeg !== shaderSettings.sunElevationDeg
                || prev.sunAzimuthDeg !== shaderSettings.sunAzimuthDeg
                || prev.turbidity !== shaderSettings.turbidity
            ) {
                updateSkyFromSettings();
            }
            if (partial.msaaSamples !== undefined) {
                inputViews.sample_count[0] = snapMsaaSamples(shaderSettings.msaaSamples);
            }
            if (partial.taaEnabled !== undefined) {
                resetTaaHistory();
            }
            updateObjects();
        },
        resetCamera() {
            camera = createOrbitCamera({
                position: initialCameraPosition,
                target: initialCameraTarget,
            });
            resetTaaHistory();
        },
    };
}
