/**
 * WorldManager - Manages world configurations and switching.
 * Worlds are loaded from GET /api/worlds (data/worlds.json). No hardcoded fallback.
 */

class WorldManager {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.currentWorld = null;
        this.onWorldChangeCallback = null;
        this.worlds = null; // Set by init() from API
    }

    /**
     * Load worlds from API. Call once before loadWorld.
     */
    async init() {
        try {
            const res = await fetch('/api/worlds');
            if (res.ok) {
                const data = await res.json();
                if (data && typeof data === 'object') {
                    this.worlds = data;
                    console.log('Worlds loaded from API');
                    return;
                }
            }
        } catch (err) {
            console.warn('Failed to fetch worlds:', err.message);
        }
        this.worlds = this.worlds || {};
    }

    /**
     * Get world configuration by ID
     */
    getWorld(worldId) {
        if (!this.worlds) return null;
        return this.worlds[worldId] || null;
    }

    /**
     * Get current world
     */
    getCurrentWorld() {
        return this.currentWorld;
    }

    /**
     * Get current world ID
     */
    getCurrentWorldId() {
        return this.currentWorld ? this.currentWorld.id : null;
    }

    /**
     * Load a world by ID
     * @param {string} worldId - World ID to load
     * @param {function} onComplete - Callback when world is loaded
     */
    async loadWorld(worldId, onComplete) {
        const world = this.getWorld(worldId);
        if (!world) {
            console.error(`World not found: ${worldId}`);
            return;
        }

        console.log(`Loading world: ${worldId}`);

        // Clear current world if any
        if (this.currentWorld) {
            this.sceneManager.clearWorld();
        }

        // Set current world
        this.currentWorld = world;

        this.sceneManager.setFloorVisible(world.floorEnabled !== false);

        // Add world-specific lights (position, type, intensity)
        this.sceneManager.addWorldLights(world.lights);

        // Load world models
        await this.sceneManager.loadWorldModels(world.models, async () => {
            await this.sceneManager.loadWorldPdfs(world.pdfs || []);
            console.log(`World loaded: ${worldId}`);

            // Call completion callback
            if (onComplete) {
                onComplete(world);
            }

            // Call world change callback
            if (this.onWorldChangeCallback) {
                this.onWorldChangeCallback(world);
            }
        });
    }

    /**
     * Switch to a different world
     * @param {string} worldId - Target world ID
     * @param {function} onComplete - Callback when switch is complete
     */
    async switchWorld(worldId, onComplete) {
        console.log(`Switching to world: ${worldId}`);
        await this.loadWorld(worldId, onComplete);
    }

    /**
     * Set callback for world changes
     */
    onWorldChange(callback) {
        this.onWorldChangeCallback = callback;
    }

    /**
     * Get spawn point for current world
     */
    getSpawnPoint() {
        if (!this.currentWorld) {
            return { x: 0, y: 10, z: 0 }; // Default spawn
        }
        return this.currentWorld.spawnPoint;
    }

    /**
     * Get all available worlds
     */
    getAllWorlds() {
        if (!this.worlds) return [];
        return Object.values(this.worlds);
    }
}

export default WorldManager;
