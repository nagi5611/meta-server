import * as THREE from 'three';

/**
 * TeleportManager - Manages teleport zones and player teleportation
 */

/** テレポーター利用権限: access とユーザーの実効ロールで利用可否を判定 */
function canUseTeleporter(access, userRole) {
    const role = userRole || 'guest';
    if (access === 'public') return true;
    if (access === 'student+') return role === 'student' || role === 'teacher' || role === 'admin';
    if (access === 'teacher+') return role === 'teacher' || role === 'admin';
    if (access === 'admin') return role === 'admin';
    return true;
}

class TeleportManager {
    constructor(worldManager, uiManager) {
        this.worldManager = worldManager;
        this.uiManager = uiManager;
        this.teleportZones = [];
        this.nearestZone = null;
        this.keyPressed = false;
        this.getPdfPath = null;
        this.openPdfViewer = null;
        /** ユーザーの実効ロール: 'guest' | 'student' | 'teacher' | 'admin' */
        this.userRole = 'guest';
        /** テレポート実行時のコールバック (destinationWorld, teleporterId) => void。未設定時は従来どおり worldManager.switchWorld */
        this.teleportCallback = null;

        // Listen for E key
        this.setupKeyListener();

        // タップ/クリックでテレポート（モバイル・PC共通）
        this.setupClickListener();
    }

    setUserRole(role) {
        this.userRole = role || 'guest';
    }

    setTeleportCallback(fn) {
        this.teleportCallback = typeof fn === 'function' ? fn : null;
    }

    /**
     * プロンプトのクリック/タップでテレポート
     */
    setupClickListener() {
        const el = this.uiManager.teleportPrompt;
        if (!el) return;
        let lastTriggerTime = 0;
        const doHandle = () => {
            const now = Date.now();
            if (now - lastTriggerTime < 400) return;
            lastTriggerTime = now;
            this.handleTeleport();
        };
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            doHandle();
        });
        el.addEventListener('touchend', (e) => {
            e.preventDefault();
            doHandle();
        }, { passive: false });
    }

    setPdfCallbacks(getPdfPath, openPdfViewer) {
        this.getPdfPath = getPdfPath;
        this.openPdfViewer = openPdfViewer;
    }

    /**
     * Add a teleport zone
     * @param {object} zone - Zone configuration (access: 'public'|'student+'|'teacher+'|'admin')
     */
    addZone(zone) {
        this.teleportZones.push({
            id: zone.id,
            position: zone.position,
            radius: zone.radius || 3,
            destinationWorld: zone.destinationWorld,
            label: zone.label || zone.destinationWorld,
            worldId: zone.worldId,
            access: zone.access || 'public'
        });
    }

    /**
     * Setup keyboard listener for E key
     */
    setupKeyListener() {
        document.addEventListener('keydown', (event) => {
            if (event.code === 'KeyE' && !this.keyPressed) {
                this.keyPressed = true;
                this.handleTeleport();
            }
        });

        document.addEventListener('keyup', (event) => {
            if (event.code === 'KeyE') {
                this.keyPressed = false;
            }
        });
    }

    /**
     * Check proximity to teleport zones and update UI
     * @param {THREE.Vector3} playerPosition - Current player position
     */
    update(playerPosition) {
        const currentWorldId = this.worldManager.getCurrentWorldId();
        if (!currentWorldId) return;

        let closestZone = null;
        let closestDistance = Infinity;

        // Find closest zone in current world (権限のあるゾーンのみ対象)
        this.teleportZones.forEach(zone => {
            if (zone.worldId !== currentWorldId) return;
            if (!canUseTeleporter(zone.access, this.userRole)) return;

            const distance = Math.sqrt(
                Math.pow(playerPosition.x - zone.position.x, 2) +
                Math.pow(playerPosition.y - zone.position.y, 2) +
                Math.pow(playerPosition.z - zone.position.z, 2)
            );

            if (distance < zone.radius && distance < closestDistance) {
                closestDistance = distance;
                closestZone = zone;
            }
        });

        // Update UI based on proximity
        if (closestZone) {
            this.nearestZone = closestZone;
            this.uiManager.showTeleportPrompt(closestZone.label);
        } else {
            this.nearestZone = null;
            this.uiManager.hideTeleportPrompt();
        }
    }

    /**
     * Handle teleport action when E is pressed (PDF viewer takes priority over teleport)
     */
    handleTeleport() {
        const pdfPath = this.getPdfPath && this.getPdfPath();
        if (pdfPath && this.openPdfViewer) {
            this.uiManager.hideTeleportPrompt();
            this.openPdfViewer(pdfPath);
            return;
        }
        if (!this.nearestZone) return;
        if (!canUseTeleporter(this.nearestZone.access, this.userRole)) return;

        const dest = this.nearestZone.destinationWorld;
        const teleporterId = this.nearestZone.id;
        console.log(`Teleporting to: ${dest} (teleporter: ${teleporterId})`);

        this.uiManager.hideTeleportPrompt();

        if (this.teleportCallback) {
            this.teleportCallback(dest, teleporterId);
        } else {
            this.worldManager.switchWorld(dest);
        }
    }

    /**
     * Clear all zones (useful when changing worlds)
     */
    clearZones() {
        this.teleportZones = [];
        this.nearestZone = null;
        this.uiManager.hideTeleportPrompt();
    }

    /**
     * Get all zones for a specific world
     */
    getZonesForWorld(worldId) {
        return this.teleportZones.filter(zone => zone.worldId === worldId);
    }
}

export default TeleportManager;
