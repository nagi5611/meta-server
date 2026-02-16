import SceneManager from './scene-manager.js';
import PhysicsManager from './physics-manager.js';
import CharacterController from './character-controller.js';
import PlayerManager from './player-manager.js';
import NetworkManager from './network-manager.js';

class MetaverseApp {
    constructor() {
        this.sceneManager = null;
        this.physicsManager = null;
        this.characterController = null;
        this.playerManager = null;
        this.networkManager = null;

        this.clock = null;
        this.lastTime = 0;
    }

    async init() {
        console.log('Initializing Metaverse Simple...');

        // Initialize scene
        this.sceneManager = new SceneManager();
        this.sceneManager.init();

        // Initialize physics
        this.physicsManager = new PhysicsManager();
        await this.physicsManager.init();

        // Create static colliders for environment
        this.physicsManager.createGroundCollider();

        const cubePositions = [
            { x: 5, y: 1, z: 5 },
            { x: -5, y: 1, z: 5 },
            { x: 5, y: 1, z: -5 },
            { x: -5, y: 1, z: -5 },
            { x: 0, y: 1, z: -10 },
            { x: 10, y: 1, z: 0 },
            { x: -10, y: 1, z: 0 }
        ];
        this.physicsManager.createStaticCubeColliders(cubePositions);

        // Create character controller
        this.physicsManager.createCharacterController({ x: 0, y: 5, z: 0 });
        this.characterController = new CharacterController(
            this.sceneManager.getCamera(),
            this.physicsManager
        );

        // Initialize player manager
        this.playerManager = new PlayerManager(this.sceneManager.getScene());
        this.playerManager.createLocalPlayer({ x: 0, y: 5, z: 0 });

        // Initialize network
        this.networkManager = new NetworkManager(this.playerManager);
        this.networkManager.connect();
        this.networkManager.startSendingUpdates(this.characterController);

        // Start game loop
        this.clock = performance.now();
        this.animate();

        console.log('Metaverse Simple initialized!');
        console.log('Click to lock pointer, then use WASD to move, Space to jump');
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        // Calculate delta time
        const currentTime = performance.now();
        const deltaTime = (currentTime - this.clock) / 1000;
        this.clock = currentTime;

        // Update physics
        this.physicsManager.step(deltaTime);

        // Update character controller
        this.characterController.update(deltaTime);

        // Update local player visual
        const position = this.characterController.getPosition();
        const rotation = this.characterController.getRotation();
        this.playerManager.updateLocalPlayer(position, rotation);

        // Render scene
        this.sceneManager.render();
    }
}

export default MetaverseApp;
