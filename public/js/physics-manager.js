import * as THREE from 'three';

class PhysicsManager {
    constructor() {
        this.collider = null; // BVH collider mesh
        this.gravity = -30;
        /** 現在ワールドのスポーン地点を返す関数（{ x, y, z }） */
        this.getSpawnPoint = null;

        // Character capsule info
        this.capsuleInfo = {
            radius: 0.5,
            segment: new THREE.Line3(
                new THREE.Vector3(0, 0, 0),      // Bottom (relative to player)
                new THREE.Vector3(0, 1.0, 0)     // Top (height = 1.0)
            )
        };

        // Character state
        this.playerPosition = new THREE.Vector3(0, 10, 0);
        this.playerVelocity = new THREE.Vector3();
        this.playerIsOnGround = false;

        // Temp variables for calculations
        this.tempBox = new THREE.Box3();
        this.tempMat = new THREE.Matrix4();
        this.tempSegment = new THREE.Line3();
        this.tempVector = new THREE.Vector3();
        this.tempVector2 = new THREE.Vector3();
        this.upVector = new THREE.Vector3(0, 1, 0);
        /** Cached feet position (bottom of capsule) for getCharacterPosition */
        this._feetPosition = new THREE.Vector3();

        /** 壁貫通ロールバック検出: 直近3秒間のロールバック時刻（ms） */
        this._rollbackTimestamps = [];
        /** 3秒間にこの回数以上ロールバックしたら初期位置へTP */
        this.ROLLBACK_TP_THRESHOLD = 20;
        this.ROLLBACK_WINDOW_MS = 3000;
        /** この長さ以上の位置補正だけをロールバックとみなす（m）。小さい補正は通常の壁/床接触 */
        this.ROLLBACK_MIN_OFFSET = 0.08;
    }

    async init() {
        console.log('BVH-based physics initialized');
    }

    setCollider(collider) {
        this.collider = collider;
        console.log('BVH collider set, triangle count:', collider.geometry.index.count / 3);
    }

    updatePlayer(delta, moveDirection) {
        if (!this.collider || !this.collider.geometry.boundsTree) {
            console.warn('No collider or BVH available');
            return;
        }

        // Apply gravity
        if (this.playerIsOnGround) {
            this.playerVelocity.y = delta * this.gravity;
        } else {
            this.playerVelocity.y += delta * this.gravity;
        }

        // Apply gravity to position
        this.playerPosition.addScaledVector(this.playerVelocity, delta);

        // Apply horizontal movement
        this.playerPosition.add(moveDirection);

        // Now perform collision detection
        // Copy capsule segment
        this.tempSegment.copy(this.capsuleInfo.segment);

        // Get collider inverse matrix
        this.tempMat.copy(this.collider.matrixWorld).invert();

        // Transform capsule to collider's local space
        // First add player world position, then transform to local space
        this.tempSegment.start.add(this.playerPosition);
        this.tempSegment.end.add(this.playerPosition);

        this.tempSegment.start.applyMatrix4(this.tempMat);
        this.tempSegment.end.applyMatrix4(this.tempMat);

        // Get axis-aligned bounding box of capsule
        this.tempBox.makeEmpty();
        this.tempBox.expandByPoint(this.tempSegment.start);
        this.tempBox.expandByPoint(this.tempSegment.end);
        this.tempBox.min.addScalar(-this.capsuleInfo.radius);
        this.tempBox.max.addScalar(this.capsuleInfo.radius);

        // Perform collision detection using BVH
        this.collider.geometry.boundsTree.shapecast({
            intersectsBounds: box => box.intersectsBox(this.tempBox),

            intersectsTriangle: tri => {
                // Check if triangle intersects capsule
                const triPoint = this.tempVector;
                const capsulePoint = this.tempVector2;

                const distance = tri.closestPointToSegment(
                    this.tempSegment,
                    triPoint,
                    capsulePoint
                );

                if (distance < this.capsuleInfo.radius) {
                    // Collision detected - push capsule away
                    const depth = this.capsuleInfo.radius - distance;
                    const direction = capsulePoint.sub(triPoint).normalize();

                    this.tempSegment.start.addScaledVector(direction, depth);
                    this.tempSegment.end.addScaledVector(direction, depth);
                }
            }
        });

        // Transform capsule back to world space
        const newPosition = this.tempVector;
        newPosition.copy(this.tempSegment.start).applyMatrix4(this.collider.matrixWorld);

        // Calculate how much the collider was moved
        const deltaVector = this.tempVector2;
        deltaVector.subVectors(newPosition, this.playerPosition);

        // Check if player is on ground
        this.playerIsOnGround = deltaVector.y > Math.abs(delta * this.playerVelocity.y * 0.25);

        const offset = Math.max(0.0, deltaVector.length() - 1e-5);
        deltaVector.normalize().multiplyScalar(offset);

        // Apply position adjustment
        this.playerPosition.add(deltaVector);

        // 壁貫通ロールバック: 補正が十分大きいときだけカウントし、3秒間に20回以上なら初期位置へTP
        if (offset >= this.ROLLBACK_MIN_OFFSET) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            this._rollbackTimestamps.push(now);
            const cutoff = now - this.ROLLBACK_WINDOW_MS;
            while (this._rollbackTimestamps.length > 0 && this._rollbackTimestamps[0] < cutoff) {
                this._rollbackTimestamps.shift();
            }
            if (this._rollbackTimestamps.length >= this.ROLLBACK_TP_THRESHOLD) {
                this._rollbackTimestamps.length = 0;
                this.reset();
                return;
            }
        }

        if (!this.playerIsOnGround) {
            deltaVector.normalize();
            this.playerVelocity.addScaledVector(deltaVector, -deltaVector.dot(this.playerVelocity));
        } else {
            this.playerVelocity.set(0, 0, 0);
        }

        // Reset if fallen too far
        if (this.playerPosition.y < -100) {
            this.reset();
        }
    }

    jump(force = 10.0) {
        if (this.playerIsOnGround) {
            this.playerVelocity.y = force;
            this.playerIsOnGround = false;
        }
    }

    /**
     * Returns feet position (bottom of capsule) so avatar touches ground.
     * Internal playerPosition is bottom sphere center; subtract radius for feet.
     */
    getCharacterPosition() {
        this._feetPosition.set(
            this.playerPosition.x,
            this.playerPosition.y - this.capsuleInfo.radius,
            this.playerPosition.z
        );
        return this._feetPosition;
    }

    /** Set character position from feet position (bottom of capsule). */
    setCharacterPosition(x, y, z) {
        this.playerPosition.set(x, y + this.capsuleInfo.radius, z);
    }

    resetVelocity() {
        this.playerVelocity.set(0, 0, 0);
        this.playerIsOnGround = false;
    }

    isGrounded() {
        return this.playerIsOnGround;
    }

    reset() {
        this._rollbackTimestamps.length = 0;
        if (typeof this.getSpawnPoint === 'function') {
            const spawn = this.getSpawnPoint();
            if (spawn && typeof spawn.x === 'number' && typeof spawn.y === 'number' && typeof spawn.z === 'number') {
                this.playerPosition.set(spawn.x, spawn.y + this.capsuleInfo.radius, spawn.z);
            } else {
                this.playerPosition.set(0, 10, 0);
            }
        } else {
            this.playerPosition.set(0, 10, 0);
        }
        this.playerVelocity.set(0, 0, 0);
        this.playerIsOnGround = false;
        console.log('Player reset');
    }

    /**
     * スポーン地点取得関数を登録する（現在ワールドの spawnPoint を返すコールバック）
     * @param {() => { x: number, y: number, z: number }} fn
     */
    setSpawnPointGetter(fn) {
        this.getSpawnPoint = typeof fn === 'function' ? fn : null;
    }
}

export default PhysicsManager;
