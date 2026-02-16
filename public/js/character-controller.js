import * as THREE from 'three';

class CharacterController {
    constructor(camera, physicsManager, options = {}) {
        this.camera = camera;
        this.physicsManager = physicsManager;

        // Movement state
        this.moveForward = false;
        this.moveBackward = false;
        this.moveLeft = false;
        this.moveRight = false;
        this.keysShift = false;

        // Mobile input state
        this.isMobileMode = options.isMobileMode ?? false;
        this.mobileMoveVector = { x: 0, y: 0 };
        this.mobileMoveForce = 0;
        this.mobileCameraDelta = { x: 0, y: 0 };

        // Movement parameters
        this.moveSpeed = 2.8;  // 2x faster
        this.dashSpeedMultiplier = 2;  // Shift dash speed

        // Third-person camera parameters
        this.cameraDistance = 5;  // Distance behind player
        this.cameraHeight = 2;    // Height above player
        this.cameraYaw = 0;       // Horizontal camera rotation (radians)
        this.cameraPitch = -0.3;  // Vertical camera angle (radians, slightly looking down)
        this.mouseSensitivity = 0.002;
        this.isPointerLocked = false;

        // Player orientation
        this.playerYaw = 0;  // Player's facing direction (radians)
        this.playerQuaternion = new THREE.Quaternion();

        // Movement direction
        this.direction = new THREE.Vector3();

        this.setupControls();
    }

    setMobileMode(enabled) {
        this.isMobileMode = enabled;
        if (enabled) {
            this.mobileMoveVector = { x: 0, y: 0 };
            this.mobileMoveForce = 0;
            this.mobileCameraDelta = { x: 0, y: 0 };
        }
    }

    setMobileMove(vector) {
        this.mobileMoveVector.x = vector.x;
        this.mobileMoveVector.y = vector.y;
        this.mobileMoveForce = typeof vector.force === 'number' ? Math.min(1, Math.max(0, vector.force)) : 1;
    }

    addMobileCameraDelta(dx, dy) {
        this.mobileCameraDelta.x += dx;
        this.mobileCameraDelta.y += dy;
    }

    resetMobileCameraDelta() {
        this.mobileCameraDelta.x = 0;
        this.mobileCameraDelta.y = 0;
    }

    trigger() {
        if (this.isInputActive()) return;
        this.physicsManager.jump(10.0);
    }

    /**
     * ジャンプ実行（モバイルジャンプボタン用・入力欄チェックなし・移動中も可）
     */
    triggerJump() {
        this.physicsManager.jump(10.0);
    }

    setupControls() {
        // Keyboard controls
        document.addEventListener('keydown', (e) => this.onKeyDown(e));
        document.addEventListener('keyup', (e) => this.onKeyUp(e));

        // Mouse controls - pointer lock (canvas only, skip when mobile mode)
        const canvas = document.getElementById('canvas');
        if (canvas) {
            canvas.addEventListener('click', () => {
                if (this.isMobileMode) return;
                if (!this.isPointerLocked) {
                    document.body.requestPointerLock();
                }
            });
        }

        document.addEventListener('pointerlockchange', () => {
            this.isPointerLocked = document.pointerLockElement === document.body;
        });

        // ポインターロック中はクリックがUIに届かないため、Shift+クリックで解除
        document.addEventListener('mousedown', (e) => {
            if (document.pointerLockElement && (e.shiftKey || e.ctrlKey)) {
                document.exitPointerLock();
            }
        }, true);

        document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    }

    onKeyDown(event) {
        // Ignore keyboard input if user is typing in chat or other input fields
        if (this.isInputActive()) {
            return;
        }

        switch (event.code) {
            case 'KeyU':
                if (document.pointerLockElement) document.exitPointerLock();
                break;
            case 'KeyW':
                this.moveForward = true;
                break;
            case 'KeyS':
                this.moveBackward = true;
                break;
            case 'KeyA':
                this.moveLeft = true;
                break;
            case 'KeyD':
                this.moveRight = true;
                break;
            case 'Space':
                this.physicsManager.jump(10.0);
                break;
            case 'ShiftLeft':
            case 'ShiftRight':
                this.keysShift = true;
                break;
        }
    }

    onKeyUp(event) {
        // Ignore keyboard input if user is typing in chat or other input fields
        if (this.isInputActive()) {
            return;
        }

        switch (event.code) {
            case 'KeyW':
                this.moveForward = false;
                break;
            case 'KeyS':
                this.moveBackward = false;
                break;
            case 'KeyA':
                this.moveLeft = false;
                break;
            case 'KeyD':
                this.moveRight = false;
                break;
            case 'ShiftLeft':
            case 'ShiftRight':
                this.keysShift = false;
                break;
        }
    }

    /**
     * Reset movement keys (e.g. when PDF viewer opens so character stops moving).
     */
    resetMovement() {
        this.moveForward = false;
        this.moveBackward = false;
        this.moveLeft = false;
        this.moveRight = false;
        this.keysShift = false;
    }

    /**
     * Get movement state for animation (idle / walk / dash / jump)
     * @returns {{ isMoving: boolean, isDashing: boolean, isGrounded: boolean }}
     */
    getMovementState() {
        const kbMoving = this.moveForward || this.moveBackward || this.moveLeft || this.moveRight;
        const mobileMoving = this.isMobileMode && (this.mobileMoveVector.x !== 0 || this.mobileMoveVector.y !== 0);
        const isMoving = kbMoving || mobileMoving;
        const mobileDashing = this.isMobileMode && mobileMoving && this.mobileMoveForce >= 0.85;
        const isGrounded = this.physicsManager.isGrounded();
        return { isMoving, isDashing: (isMoving && this.keysShift) || mobileDashing, isGrounded };
    }

    onMouseMove(event) {
        if (!this.isPointerLocked) return;

        // Update camera horizontal rotation (yaw)
        this.cameraYaw -= event.movementX * this.mouseSensitivity;

        // Update camera vertical angle (pitch) with limits
        this.cameraPitch -= event.movementY * this.mouseSensitivity;
        
        // Clamp vertical rotation (prevent camera from going too high or too low)
        this.cameraPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(0.2, this.cameraPitch));
    }

    /**
     * Check if an input field (chat, modal, etc.) is currently active
     */
    isInputActive() {
        const activeElement = document.activeElement;
        
        // Check if user is typing in any input or textarea
        if (activeElement && (
            activeElement.tagName === 'INPUT' || 
            activeElement.tagName === 'TEXTAREA' ||
            activeElement.id === 'chat-input'
        )) {
            return true;
        }

        // Check if any modal is open
        const modals = document.querySelectorAll('.modal.visible');
        if (modals.length > 0) {
            return true;
        }

        // Check if PDF viewer overlay is open
        if (document.body.dataset.pdfViewerOpen === '1') {
            return true;
        }

        return false;
    }

    update(deltaTime) {
        // Apply mobile camera delta (right stick) before movement
        if (this.isMobileMode && (this.mobileCameraDelta.x !== 0 || this.mobileCameraDelta.y !== 0)) {
            this.cameraYaw -= this.mobileCameraDelta.x;
            this.cameraPitch -= this.mobileCameraDelta.y;
            this.cameraPitch = Math.max(-Math.PI / 2 + 0.1, Math.min(0.2, this.cameraPitch));
            this.mobileCameraDelta.x = 0;
            this.mobileCameraDelta.y = 0;
        }

        // Calculate movement direction based on camera orientation
        this.direction.set(0, 0, 0);

        // Get camera forward direction (horizontal only)
        // Camera is behind player, so forward is opposite of camera direction
        const cameraForward = new THREE.Vector3(
            -Math.sin(this.cameraYaw),
            0,
            -Math.cos(this.cameraYaw)
        );
        
        const cameraRight = new THREE.Vector3(
            Math.cos(this.cameraYaw),
            0,
            -Math.sin(this.cameraYaw)
        );

        const useMobileMove = this.isMobileMode && (this.mobileMoveVector.x !== 0 || this.mobileMoveVector.y !== 0);
        if (useMobileMove) {
            this.direction.add(cameraForward.clone().multiplyScalar(this.mobileMoveVector.y));
            this.direction.add(cameraRight.clone().multiplyScalar(this.mobileMoveVector.x));
        } else {
            if (this.moveForward) {
                this.direction.add(cameraForward);
            }
            if (this.moveBackward) {
                this.direction.sub(cameraForward);
            }
            if (this.moveLeft) {
                this.direction.sub(cameraRight);
            }
            if (this.moveRight) {
                this.direction.add(cameraRight);
            }
        }

        // Update player rotation based on movement direction
        if (this.direction.length() > 0) {
            this.direction.normalize();
            // Player faces the movement direction
            this.playerYaw = Math.atan2(this.direction.x, this.direction.z);
            this.playerQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.playerYaw);
        }

        // Apply movement (dash speed when Shift held, or mobile force-based speed)
        const moveDirection = new THREE.Vector3();
        if (this.direction.length() > 0) {
            let speed;
            if (useMobileMove && this.isMobileMode) {
                const f = this.mobileMoveForce;
                if (f < 0.5) {
                    speed = this.moveSpeed * (0.5 + 0.6 * (f / 0.5));
                } else {
                    speed = this.moveSpeed * (0.8 + 1.2 * ((f - 0.5) / 0.5));
                }
            } else {
                speed = this.keysShift ? this.moveSpeed * this.dashSpeedMultiplier : this.moveSpeed;
            }
            moveDirection.copy(this.direction).multiplyScalar(speed * deltaTime);
        }

        // Update physics with movement
        this.physicsManager.updatePlayer(deltaTime, moveDirection);

        // Update camera position (third-person view)
        const characterPos = this.physicsManager.getCharacterPosition();
        
        // Calculate camera position behind and above player
        const cameraOffset = new THREE.Vector3(
            Math.sin(this.cameraYaw) * this.cameraDistance * Math.cos(this.cameraPitch),
            this.cameraHeight - this.cameraDistance * Math.sin(this.cameraPitch),
            Math.cos(this.cameraYaw) * this.cameraDistance * Math.cos(this.cameraPitch)
        );
        
        this.camera.position.copy(characterPos).add(cameraOffset);
        
        // Look at player position (slightly above ground)
        const lookAtTarget = new THREE.Vector3(
            characterPos.x,
            characterPos.y + 1.0,
            characterPos.z
        );
        this.camera.lookAt(lookAtTarget);
    }

    getPosition() {
        return this.physicsManager.getCharacterPosition();
    }

    setPosition(x, y, z) {
        this.physicsManager.setCharacterPosition(x, y, z);
    }

    resetVelocity() {
        this.physicsManager.resetVelocity();
    }

    getRotation() {
        // Return player's facing direction (not camera quaternion)
        return this.playerQuaternion;
    }
}

export default CharacterController;
