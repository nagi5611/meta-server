// addons/smoke-view/play_vdb/js/lib/camera.js — オービットカメラ
import { mat4, vec3 } from 'https://esm.sh/wgpu-matrix@3.0.2';

/**
 * @param {{ position?: Float32Array, target?: Float32Array }} [options]
 */
export function createOrbitCamera(options) {
    const matrix_ = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const view_ = mat4.create();

    const right_ = new Float32Array(matrix_.buffer, 0, 4);
    const up_ = new Float32Array(matrix_.buffer, 16, 4);
    const position_ = new Float32Array(matrix_.buffer, 48, 4);

    const pivot = options?.target ? vec3.clone(options.target) : vec3.create();
    let theta = 0;
    let phi = 0;
    let radius = 5;

    const targetPivot = vec3.clone(pivot);
    let targetTheta = 0;
    let targetPhi = 0;
    let targetRadius = 5;

    const smoothing = 0.15;
    const temp = vec3.create();
    const upWorld = vec3.create(0, 1, 0);

    if (options?.position) {
        vec3.sub(options.position, pivot, temp);
        radius = vec3.len(temp);
        if (radius > 1e-4) {
            theta = Math.atan2(temp[0], temp[2]);
            phi = Math.asin(temp[1] / radius);
        }
        targetTheta = theta;
        targetPhi = phi;
        targetRadius = radius;
    }
    recalc();

    function recalc() {
        const cy = Math.cos(phi);
        vec3.set(
            radius * cy * Math.sin(theta),
            radius * Math.sin(phi),
            radius * cy * Math.cos(theta),
            temp,
        );
        vec3.add(pivot, temp, position_);
        mat4.lookAt(position_, pivot, upWorld, view_);
        mat4.invert(view_, matrix_);
    }

    return {
        get matrix() { return matrix_; },
        get view() { return view_; },
        get position() { return position_; },
        get pivot() { return pivot; },

        /**
         * @param {number} dt
         * @param {{ analog: { x: number, y: number, zoom: number, panning: boolean } }} input
         */
        update(dt, input) {
            const { x: dx, y: dy, zoom: dz, panning } = input.analog;

            if (panning && (dx || dy)) {
                const speed = targetRadius * 0.002;
                vec3.addScaled(targetPivot, right_, -dx * speed, targetPivot);
                vec3.addScaled(targetPivot, up_, dy * speed, targetPivot);
            } else if (dx || dy) {
                const orbitSpeed = 0.005;
                targetTheta -= dx * orbitSpeed;
                targetPhi = Math.max(-1.5, Math.min(1.5, targetPhi + dy * orbitSpeed));
            }

            if (dz) {
                targetRadius *= Math.pow(1.1, dz * 0.5);
                targetRadius = Math.max(0.1, targetRadius);
            }

            const t = 1 - Math.pow(smoothing, dt * 60);
            const epsilon = 1e-6;
            let dirty = false;

            if (Math.abs(targetTheta - theta) > epsilon) {
                theta += (targetTheta - theta) * t;
                dirty = true;
            }
            if (Math.abs(targetPhi - phi) > epsilon) {
                phi += (targetPhi - phi) * t;
                dirty = true;
            }
            if (Math.abs(targetRadius - radius) > epsilon) {
                radius += (targetRadius - radius) * t;
                dirty = true;
            }

            const pivotDiff = vec3.sub(targetPivot, pivot, temp);
            if (vec3.lenSq(pivotDiff) > epsilon * epsilon) {
                vec3.addScaled(pivot, pivotDiff, t, pivot);
                dirty = true;
            }

            if (dirty) recalc();
            return view_;
        },
    };
}
