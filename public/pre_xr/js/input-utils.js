// public/pre_xr/js/input-utils.js — WebXR gamepad 読み取りユーティリティ

/**
 * スティックデッドゾーンを適用する。
 * @param {number} x
 * @param {number} y
 * @param {number} dead
 */
export function applyStickDeadzone(x, y, dead) {
    const m = Math.hypot(x, y);
    if (m < dead) {
        return { x: 0, y: 0, mag: 0 };
    }
    const nx = x / m;
    const ny = y / m;
    const t = Math.min(1, (m - dead) / Math.max(1e-6, 1 - dead));
    return { x: nx * t, y: ny * t, mag: t };
}

/**
 * 主要なサムスティック軸ペアを選ぶ（Quest 等の軸差異対策）。
 * @param {Gamepad|null|undefined} gp
 */
export function pickPrimaryThumbstickXY(gp) {
    if (!gp || !gp.axes || gp.axes.length < 2) {
        return { x: 0, y: 0, tag: '—' };
    }
    const a = gp.axes;
    const cands = [{ x: a[0] || 0, y: a[1] || 0, tag: '0,1' }];
    if (a.length >= 4) {
        cands.push({ x: a[2] || 0, y: a[3] || 0, tag: '2,3' });
    }
    let best = cands[0];
    let bm = Math.hypot(best.x, best.y);
    for (let i = 1; i < cands.length; i++) {
        const m = Math.hypot(cands[i].x, cands[i].y);
        if (m > bm) {
            best = cands[i];
            bm = m;
        }
    }
    return { x: best.x, y: best.y, tag: best.tag };
}

/** @typedef {'both'|'smooth'|'teleport'} LocomotionMode */

const BUTTON_LABELS = ['trigger', 'squeeze', 'touchpad/touch', 'thumbstick', 'A/X', 'B/Y'];

/**
 * gamepad ボタン配列を表示用テキストにする。
 * @param {GamepadButton[]} buttons
 */
export function formatButtons(buttons) {
    if (!buttons || !buttons.length) return '  (なし)';
    const lines = [];
    for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        const label = BUTTON_LABELS[i] || `btn${i}`;
        const flags = [
            b.pressed ? 'pressed' : null,
            b.touched ? 'touched' : null,
            b.value > 0 ? `val=${b.value.toFixed(2)}` : null
        ].filter(Boolean).join(' ');
        if (flags) {
            lines.push(`  [${i}] ${label}: ${flags}`);
        }
    }
    return lines.length ? lines.join('\n') : '  (押下なし)';
}

/**
 * gamepad 軸を表示用テキストにする。
 * @param {number[]} axes
 */
export function formatAxes(axes) {
    if (!axes || !axes.length) return '  (なし)';
    return axes.map((v, i) => `  [${i}] ${Number(v).toFixed(3)}`).join('\n');
}

/**
 * XRSession の入力を解析する（webxr-vr と同系統）。
 * @param {XRSession} session
 * @param {number} stickDeadzone
 */
export function readSessionInputs(session, stickDeadzone = 0.14) {
    const sources = [];
    for (const src of session.inputSources) {
        const gp = src.gamepad;
        if (!gp || !gp.axes || gp.axes.length < 2) continue;
        sources.push({ src, gp });
    }
    const sourceCount = session.inputSources.length;

    let moveEntry = null;
    for (const entry of sources) {
        if (entry.src.handedness === 'left') {
            moveEntry = entry;
            break;
        }
    }
    if (!moveEntry && sources.length > 0) {
        moveEntry = sources[0];
    }

    let snapEntry = null;
    for (const entry of sources) {
        if (entry.src.handedness === 'right') {
            snapEntry = entry;
            break;
        }
    }
    if (!snapEntry && sources.length >= 2 && moveEntry) {
        snapEntry = sources.find((e) => e !== moveEntry) || null;
    }

    let moveX = 0;
    let moveY = 0;
    let moveMag = 0;
    let axisTag = '—';
    let rawHypot = 0;
    const hasMoveGamepad = !!moveEntry;
    if (moveEntry) {
        const pick = pickPrimaryThumbstickXY(moveEntry.gp);
        axisTag = pick.tag;
        rawHypot = Math.hypot(pick.x, pick.y);
        const dz = applyStickDeadzone(pick.x, -pick.y, stickDeadzone);
        moveX = dz.x;
        moveY = dz.y;
        moveMag = dz.mag;
    }

    let snapX = 0;
    const SINGLE_CTRL_SNAP_AX1_MAX = 0.38;
    if (snapEntry && snapEntry !== moveEntry) {
        const sp = pickPrimaryThumbstickXY(snapEntry.gp);
        snapX = sp.x;
    } else if (moveEntry && (!snapEntry || snapEntry === moveEntry)) {
        const pick = pickPrimaryThumbstickXY(moveEntry.gp);
        if (Math.abs(pick.y) < SINGLE_CTRL_SNAP_AX1_MAX) {
            snapX = pick.x;
        }
    }

    let leftGrip = false;
    for (const entry of sources) {
        if (entry.src.handedness === 'left') {
            const b1 = entry.gp.buttons[1];
            leftGrip = !!(b1 && b1.pressed);
            break;
        }
    }
    if (!leftGrip && sources.length === 1) {
        const b1 = sources[0].gp.buttons[1];
        leftGrip = !!(b1 && b1.pressed);
    }

    return {
        moveX,
        moveY,
        moveMag,
        snapX,
        leftGrip,
        rawHypot,
        axisTag,
        hasMoveGamepad,
        sourceCount,
        sources,
        allInputSources: session.inputSources
    };
}

/**
 * 入力ソース一覧の表示テキストを生成する。
 * @param {XRInputSource[]} inputSources
 */
export function formatInputSources(inputSources) {
    if (!inputSources.length) {
        return '入力ソース: 0\n（コントローラー未接続）';
    }
    const blocks = [];
    for (let i = 0; i < inputSources.length; i++) {
        const src = inputSources[i];
        const gp = src.gamepad;
        const lines = [
            `— Source #${i} —`,
            `  handedness: ${src.handedness}`,
            `  targetRayMode: ${src.targetRayMode}`,
            `  profiles: ${(src.profiles || []).join(', ') || '—'}`,
            `  gamepad.id: ${gp?.id || '—'}`,
            `  axes:\n${formatAxes(gp?.axes)}`,
            `  buttons:\n${formatButtons(gp?.buttons)}`
        ];
        blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n');
}
