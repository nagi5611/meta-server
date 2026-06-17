// addons/smoke-view/play_vdb/js/lib/input.js — オービットカメラ用ポインタ入力
/**
 * @typedef {object} Input
 * @property {object} digital
 * @property {object} analog
 */

/**
 * @typedef {() => Input} InputHandler
 */

/**
 * @param {Window} window
 * @param {HTMLCanvasElement} canvas
 * @returns {InputHandler}
 */
export function createInputHandler(window, canvas) {
    const digital = { forward: false, backward: false, left: false, right: false, up: false, down: false };
    const analog = { x: 0, y: 0, zoom: 0, touching: false, panning: false };

    const pointers = new Map();
    let prevDist = 0;
    let prevMidX = 0;
    let prevMidY = 0;
    let isAlt = false;

    const setKey = (e, v) => {
        if (e.key === 'Alt') isAlt = v;
        switch (e.code) {
            case 'KeyW': digital.forward = v; break;
            case 'KeyS': digital.backward = v; break;
            case 'KeyA': digital.left = v; break;
            case 'KeyD': digital.right = v; break;
            case 'Space': digital.up = v; break;
            case 'ShiftLeft': digital.down = v; break;
            default: break;
        }
    };
    window.addEventListener('keydown', (e) => setKey(e, true));
    window.addEventListener('keyup', (e) => setKey(e, false));

    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, e);
        if (pointers.size === 2) {
            const p = [...pointers.values()];
            prevDist = Math.hypot(p[0].clientX - p[1].clientX, p[0].clientY - p[1].clientY);
            prevMidX = (p[0].clientX + p[1].clientX) / 2;
            prevMidY = (p[0].clientY + p[1].clientY) / 2;
        }
    });

    const removePointer = (e) => {
        try {
            canvas.releasePointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
        pointers.delete(e.pointerId);
    };
    canvas.addEventListener('pointerup', removePointer);
    canvas.addEventListener('pointercancel', removePointer);

    canvas.addEventListener('pointermove', (e) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        pointers.set(e.pointerId, e);

        const mdx = e.clientX - prev.clientX;
        const mdy = e.clientY - prev.clientY;

        if (pointers.size === 2) {
            const p = [...pointers.values()];
            const dist = Math.hypot(p[0].clientX - p[1].clientX, p[0].clientY - p[1].clientY);
            const midX = (p[0].clientX + p[1].clientX) / 2;
            const midY = (p[0].clientY + p[1].clientY) / 2;

            analog.zoom -= (dist - prevDist) * 0.05;
            analog.x += midX - prevMidX;
            analog.y += midY - prevMidY;
            analog.panning = true;
            prevDist = dist;
            prevMidX = midX;
            prevMidY = midY;
        } else if (pointers.size === 1) {
            analog.x += mdx;
            analog.y += mdy;
            analog.panning = (e.buttons & 4) !== 0 || isAlt;
        }
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        analog.zoom -= Math.sign(e.deltaY);
    }, { passive: false });

    return () => {
        const out = {
            digital,
            analog: { ...analog, touching: pointers.size > 0 },
        };
        analog.x = 0;
        analog.y = 0;
        analog.zoom = 0;
        analog.panning = false;
        return out;
    };
}
