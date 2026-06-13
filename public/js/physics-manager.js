import * as THREE from 'three';

class PhysicsManager {
    constructor() {
        this.collider = null; // BVH collider mesh
        /** No collider 警告の連打防止 */
        this._warnedNoCollider = false;
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

        /** 挟み込み検出: 直近3秒間に大きな位置補正があった時刻（ms） */
        this._stuckResolveTimestamps = [];
        /** 3秒間にこの回数以上なら Y を持ち上げて抜ける */
        this.STUCK_RESOLVE_THRESHOLD = 20;
        this.STUCK_RESOLVE_WINDOW_MS = 3000;
        /** この長さ以上の位置補正だけを挟み込み候補とみなす（m）。小さい補正は通常の壁/床接触 */
        this.STUCK_MIN_OFFSET = 0.08;
        /** 挟み込み解除時に加算する Y（m） */
        this.STUCK_Y_LIFT = 2;

        /** 三人称カメラの壁抜け防止用（レイ・座標の一時領域） */
        this._camRay = new THREE.Ray();
        this._camRayOriginLocal = new THREE.Vector3();
        this._camRayEndLocal = new THREE.Vector3();
        this._camRayDirLocal = new THREE.Vector3();
        this._camDirWorld = new THREE.Vector3();
        this._camHitWorld = new THREE.Vector3();
        this._camAlongScratch = new THREE.Vector3();

        /** updatePlayer: フレーム開始時の位置（メッシュ貫通ロールバック用） */
        this._tunnelStart = new THREE.Vector3();
        /** 胴体高さでの移動線分（壁検出） */
        this._segFrom = new THREE.Vector3();
        this._segTo = new THREE.Vector3();
        this._segDir = new THREE.Vector3();
        this._triNa = new THREE.Vector3();
        this._triNb = new THREE.Vector3();
        this._triNc = new THREE.Vector3();
        this._hitNormalWorld = new THREE.Vector3();
        this._rayDown = new THREE.Vector3(0, -1, 0);

        /** 足元プローブ: 床との隙間（m）許容。スポーン高め・レイずれ対策で上限を広げる */
        this.groundProbeGapMin = -0.15;
        this.groundProbeGapMax = 1.0;
        /** 地面を離れた直後もジャンプ可能な時間（ms）。低 FPS・接地フラグの一瞬 false 対策 */
        this.coyoteJumpMs = 130;
        /** 接地判定で delta×vy 項の上限（m）。大きい delta で閾値が膨らみすぎないようにする */
        this.groundDeltaVyPushbackCap = 0.06;
        /** コヨーテ終了時刻（performance.now） */
        this._coyoteJumpUntilMs = 0;

        /** 床レイの最大距離（m）— 飛行機と同様に長めで取りこぼしを減らす */
        this.groundRayMax = 500;
        /** 足元と床面のクリアランス（m） */
        this.feetClearanceAboveGround = 0.038;
        /** 床レイ原点をカプセル中心より上にずらす（m）— メッシュ内での取りこぼし緩和 */
        this.groundProbeOriginLift = 2;
        /** 床スナップ: このめり込み以上のみ復帰（通常落下には干渉しない） */
        this.floorSnapDeepPenetration = 0.35;
        /**
         * BVH 接地: これより速く落下中は床への擦過で接地扱いにしない (m/s)
         * 誤接地 → 次フレームで vy=0・重力停止 → 落下が遅く見えるのを防ぐ
         */
        this.groundMaxFallSpeedForGrounded = 1.25;
    }

    async init() {
        console.log('BVH-based physics initialized');
    }

    setCollider(collider) {
        this.collider = collider;
        if (!collider) {
            this._warnedNoCollider = false;
            return;
        }
        this._warnedNoCollider = false;
        const idx = collider.geometry?.index;
        const triCount = idx?.count ? idx.count / 3 : (collider.geometry?.attributes?.position?.count || 0) / 3;
        console.log('BVH collider set, triangle count:', triCount);
    }

    /**
     * 注視点から理想カメラ位置への直線が静的メッシュに遮られる場合、手前（アバター側）に寄せた位置を out に書く
     * @param {THREE.Vector3} pivotWorld 注視点（ワールド）
     * @param {THREE.Vector3} desiredCameraWorld 障害物なしのカメラ位置（ワールド）
     * @param {THREE.Vector3} out 結果のカメラ位置
     * @returns {THREE.Vector3} out
     */
    clampThirdPersonCameraPosition(pivotWorld, desiredCameraWorld, out) {
        if (!this.collider || !this.collider.geometry.boundsTree) {
            out.copy(desiredCameraWorld);
            return out;
        }

        const skinWidth = 0.15;
        const rayNearLocal = 0.02;

        const dirWorld = this._camDirWorld.subVectors(desiredCameraWorld, pivotWorld);
        const maxDist = dirWorld.length();
        if (maxDist < 1e-4) {
            out.copy(desiredCameraWorld);
            return out;
        }
        dirWorld.multiplyScalar(1 / maxDist);

        const inv = this.tempMat.copy(this.collider.matrixWorld).invert();
        const originLocal = this._camRayOriginLocal.copy(pivotWorld).applyMatrix4(inv);
        const endLocal = this._camRayEndLocal.copy(desiredCameraWorld).applyMatrix4(inv);
        const dirLocal = this._camRayDirLocal.subVectors(endLocal, originLocal);
        const localSpan = dirLocal.length();
        if (localSpan < 1e-6) {
            out.copy(desiredCameraWorld);
            return out;
        }
        dirLocal.multiplyScalar(1 / localSpan);

        this._camRay.set(originLocal, dirLocal);
        const hit = this.collider.geometry.boundsTree.raycastFirst(
            this._camRay,
            THREE.DoubleSide,
            rayNearLocal,
            localSpan
        );

        if (!hit || hit.point == null) {
            out.copy(desiredCameraWorld);
            return out;
        }

        const hitWorld = this._camHitWorld.copy(hit.point).applyMatrix4(this.collider.matrixWorld);
        const alongWorld = this._camAlongScratch.subVectors(hitWorld, pivotWorld).dot(dirWorld);
        let allowed = Math.min(maxDist, alongWorld - skinWidth);
        if (!Number.isFinite(allowed)) {
            out.copy(desiredCameraWorld);
            return out;
        }
        allowed = Math.max(0, allowed);
        if (allowed < 1e-3) {
            out.copy(pivotWorld).addScaledVector(dirWorld, Math.min(maxDist, 0.08));
            return out;
        }

        out.copy(pivotWorld).addScaledVector(dirWorld, allowed);
        return out;
    }

    updatePlayer(delta, moveDirection) {
        if (!this.collider || !this.collider.geometry.boundsTree) {
            if (!this._warnedNoCollider) {
                console.warn('No collider or BVH available');
                this._warnedNoCollider = true;
            }
            return;
        }
        this._warnedNoCollider = false;

        const wasGroundedAtStart = this.playerIsOnGround;

        this._tunnelStart.copy(this.playerPosition);

        // 接地かつ下向き／静止のときだけ vy を 0（上向きはジャンプ残り → 重力を積分する）
        if (this.playerIsOnGround && this.playerVelocity.y <= 0.12) {
            this.playerVelocity.y = 0;
        } else {
            this.playerVelocity.y += delta * this.gravity;
        }

        // Apply gravity to position（元のフル速度積分）
        this.playerPosition.addScaledVector(this.playerVelocity, delta);

        // Apply horizontal movement
        this.playerPosition.add(moveDirection);

        const horiz = Math.hypot(
            this.playerPosition.x - this._tunnelStart.x,
            this.playerPosition.z - this._tunnelStart.z
        );
        // ジャンプ・上昇中は線分検査しない（誤検知で XZ ロールバックされジャンプが潰れるのを防ぐ）
        const allowWallTunnelCheck =
            this.playerIsOnGround && this.playerVelocity.y <= 0.12;
        if (allowWallTunnelCheck && horiz > 0.004) {
            const midY = (this._tunnelStart.y + this.playerPosition.y) * 0.5 + 0.4;
            this._segFrom.set(this._tunnelStart.x, midY, this._tunnelStart.z);
            this._segTo.set(this.playerPosition.x, midY, this.playerPosition.z);
            if (this.segmentBlockedByWallMesh(this._segFrom, this._segTo)) {
                const keepY = this.playerPosition.y;
                this.playerPosition.x = this._tunnelStart.x;
                this.playerPosition.z = this._tunnelStart.z;
                this.playerPosition.y = keepY;
                this.playerVelocity.x = 0;
                this.playerVelocity.z = 0;
            }
        }

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

        // Check if player is on ground（上向き速度があるときは誤接地扱いにしない → ジャンプが即座に潰れるのを防ぐ）
        const vyPushback = Math.abs(delta * this.playerVelocity.y * 0.25);
        const cappedVyPushback = Math.min(vyPushback, this.groundDeltaVyPushbackCap);
        const bvhPushesUp = deltaVector.y > cappedVyPushback;
        if (this.playerVelocity.y > 0.12) {
            this.playerIsOnGround = false;
        } else {
            this.playerIsOnGround =
                bvhPushesUp && this.playerVelocity.y > -this.groundMaxFallSpeedForGrounded;
        }

        const offset = Math.max(0.0, deltaVector.length() - 1e-5);
        deltaVector.normalize().multiplyScalar(offset);

        // Apply position adjustment
        this.playerPosition.add(deltaVector);

        if (this.playerIsOnGround) {
            this.unburyFeetFromFloor();
        }

        this._enforceFloorFromRaycast();

        // 床・メッシュ挟み込み: 大きな補正が短時間に繰り返されたら Y を持ち上げて抜ける（スポーン TP はしない）
        if (offset >= this.STUCK_MIN_OFFSET) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            this._stuckResolveTimestamps.push(now);
            const cutoff = now - this.STUCK_RESOLVE_WINDOW_MS;
            while (this._stuckResolveTimestamps.length > 0 && this._stuckResolveTimestamps[0] < cutoff) {
                this._stuckResolveTimestamps.shift();
            }
            if (this._stuckResolveTimestamps.length >= this.STUCK_RESOLVE_THRESHOLD) {
                this._stuckResolveTimestamps.length = 0;
                this.playerPosition.y += this.STUCK_Y_LIFT;
                this.playerVelocity.set(0, 0, 0);
                return;
            }
        }

        if (!this.playerIsOnGround) {
            deltaVector.normalize();
            this.playerVelocity.addScaledVector(deltaVector, -deltaVector.dot(this.playerVelocity));
        } else {
            // 接地でも上昇中は vy を残す（誤接地のフレームでジャンプ初速を消さない）
            if (this.playerVelocity.y <= 0) {
                this.playerVelocity.set(0, 0, 0);
            } else {
                this.playerVelocity.x = 0;
                this.playerVelocity.z = 0;
            }
        }

        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (wasGroundedAtStart && !this.playerIsOnGround && this.playerVelocity.y <= 0.12) {
            this._coyoteJumpUntilMs = nowMs + this.coyoteJumpMs;
        }
        if (this.playerIsOnGround) {
            this._coyoteJumpUntilMs = 0;
        }

        // Reset if fallen too far
        if (this.playerPosition.y < -100) {
            this.reset();
        }
    }

    jump(force = 10.0) {
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const coyoteOk = nowMs < this._coyoteJumpUntilMs;
        if (!this.playerIsOnGround && !coyoteOk) {
            return;
        }
        this._coyoteJumpUntilMs = 0;
        this.playerVelocity.y = force;
        this.playerIsOnGround = false;
    }

    /**
     * 物理停止から再開する直前用: 足元直下に床があれば playerIsOnGround を true にする（初回ジャンプ用）
     */
    probeGroundedAtFeet() {
        if (!this.collider || !this.collider.geometry?.boundsTree) {
            this.playerIsOnGround = false;
            return;
        }
        this.collider.updateMatrixWorld(true);
        const origin = this.tempVector.set(
            this.playerPosition.x,
            this.playerPosition.y + 0.28,
            this.playerPosition.z
        );
        const hit = this.raycastStaticWorld(origin, this._rayDown, 2.5);
        if (!hit || hit.point == null) {
            this.playerIsOnGround = false;
            return;
        }
        const feetY = this.playerPosition.y - this.capsuleInfo.radius;
        const gap = hit.point.y - feetY;
        this.playerIsOnGround = gap > this.groundProbeGapMin && gap < this.groundProbeGapMax;
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
        this._coyoteJumpUntilMs = 0;
    }

    isGrounded() {
        return this.playerIsOnGround;
    }

    reset() {
        this._stuckResolveTimestamps.length = 0;
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
        this._coyoteJumpUntilMs = 0;
        console.log('Player reset');
    }

    /**
     * スポーン地点取得関数を登録する（現在ワールドの spawnPoint を返すコールバック）
     * @param {() => { x: number, y: number, z: number }} fn
     */
    setSpawnPointGetter(fn) {
        this.getSpawnPoint = typeof fn === 'function' ? fn : null;
    }

    /**
     * 静的 BVH コライダーへのワールド空間レイキャスト（テレポート着地など用）
     * @param {THREE.Vector3} originWorld
     * @param {THREE.Vector3} directionWorld 正規化済み推奨
     * @param {number} maxDistance
     * @returns {{ point: THREE.Vector3, distance: number, faceIndex?: number } | null}
     */
    raycastStaticWorld(originWorld, directionWorld, maxDistance) {
        if (!this.collider || !this.collider.geometry?.boundsTree) return null;

        const dir = this.tempVector2.copy(directionWorld);
        if (dir.lengthSq() < 1e-12) return null;
        dir.normalize();

        const inv = this.tempMat.copy(this.collider.matrixWorld).invert();
        const originLocal = this.tempVector.copy(originWorld).applyMatrix4(inv);
        const dirLocal = this._camRayDirLocal.copy(dir).transformDirection(inv).normalize();

        this._camRay.set(originLocal, dirLocal);
        const hit = this.collider.geometry.boundsTree.raycastFirst(
            this._camRay,
            THREE.DoubleSide,
            0.02,
            maxDistance
        );

        if (!hit || hit.point == null) return null;

        const pointWorld = hit.point.clone().applyMatrix4(this.collider.matrixWorld);
        const dist = originWorld.distanceTo(pointWorld);
        return { point: pointWorld, distance: dist, faceIndex: hit.faceIndex };
    }

    /**
     * レイキャストヒットの三角形法線をワールドへ（壁判定用）
     * @param {number} faceIndex
     * @param {THREE.Vector3} outWorld
     */
    _triangleNormalWorld(faceIndex, outWorld) {
        const geom = this.collider.geometry;
        const pos = geom.attributes.position;
        const idx = geom.index;
        let a;
        let b;
        let c;
        if (idx) {
            const i3 = faceIndex * 3;
            a = idx.getX(i3);
            b = idx.getX(i3 + 1);
            c = idx.getX(i3 + 2);
        } else {
            const base = faceIndex * 3;
            a = base;
            b = base + 1;
            c = base + 2;
        }
        this._triNa.fromBufferAttribute(pos, a);
        this._triNb.fromBufferAttribute(pos, b);
        this._triNc.fromBufferAttribute(pos, c);
        THREE.Triangle.getNormal(this._triNa, this._triNb, this._triNc, outWorld);
        outWorld.transformDirection(this.collider.matrixWorld).normalize();
    }

    /**
     * ワールド空間の線分が壁向きの静的メッシュと交差するか（薄い壁貫通のロールバック用）
     * @param {THREE.Vector3} fromWorld
     * @param {THREE.Vector3} toWorld
     * @returns {boolean}
     */
    segmentBlockedByWallMesh(fromWorld, toWorld) {
        if (!this.collider || !this.collider.geometry?.boundsTree) return false;

        const inv = this.tempMat.copy(this.collider.matrixWorld).invert();
        const oL = this._segFrom.copy(fromWorld).applyMatrix4(inv);
        const tL = this._segTo.copy(toWorld).applyMatrix4(inv);
        this._segDir.subVectors(tL, oL);
        const segLen = this._segDir.length();
        if (segLen < 1e-4) return false;

        this._segDir.multiplyScalar(1 / segLen);

        this._camRay.set(oL, this._segDir);
        const hit = this.collider.geometry.boundsTree.raycastFirst(
            this._camRay,
            THREE.DoubleSide,
            0.04,
            segLen - 0.06
        );

        if (!hit || hit.faceIndex == null) return false;

        const distLocal = hit.distance;
        if (distLocal < 0.05 || distLocal > segLen - 0.08) return false;

        this._triangleNormalWorld(hit.faceIndex, this._hitNormalWorld);
        if (Math.abs(this._hitNormalWorld.y) >= 0.52) return false;

        return true;
    }

    /**
     * カプセル中心位置から直下の床をレイでサンプル（飛行機 _sampleGroundBelow と同系）
     * @param {THREE.Vector3} capsuleCenterWorld カプセル下端球の中心（playerPosition）
     * @returns {{ minCapsuleY: number, headroom: number } | null}
     */
    _sampleGroundBelow(capsuleCenterWorld) {
        if (!this.collider?.geometry?.boundsTree) return null;

        const lift = this.groundProbeOriginLift;
        const origin = this._segFrom.set(
            capsuleCenterWorld.x,
            capsuleCenterWorld.y + lift,
            capsuleCenterWorld.z
        );
        const hit = this.raycastStaticWorld(
            origin,
            this._rayDown,
            this.groundRayMax + lift
        );
        if (!hit?.point) return null;

        const minCapsuleY = hit.point.y + this.feetClearanceAboveGround + this.capsuleInfo.radius;
        return {
            minCapsuleY,
            headroom: capsuleCenterWorld.y - minCapsuleY,
        };
    }

    /**
     * 深い床抜け時のみ Y をレイで復帰（速度・接地フラグは変更しない）
     * @returns {boolean}
     */
    _enforceFloorFromRaycast() {
        if (this.playerVelocity.y > 0.12) return false;

        const ground = this._sampleGroundBelow(this.playerPosition);
        const minCapsuleY = ground?.minCapsuleY ?? null;
        if (minCapsuleY == null || this.playerPosition.y >= minCapsuleY) return false;

        const penetration = minCapsuleY - this.playerPosition.y;
        if (penetration < this.floorSnapDeepPenetration) return false;

        this.playerPosition.y = minCapsuleY;
        return true;
    }

    /**
     * 接地時に足元が床面よりわずかに下なら持ち上げる（めり込み緩和）
     */
    unburyFeetFromFloor() {
        if (!this.collider || !this.collider.geometry?.boundsTree || !this.playerIsOnGround) return;

        const origin = this._segTo.set(
            this.playerPosition.x,
            this.playerPosition.y + 0.38,
            this.playerPosition.z
        );
        const hit = this.raycastStaticWorld(origin, this._rayDown, 2.2);
        if (!hit || hit.point == null) return;

        const feetY = this.playerPosition.y - this.capsuleInfo.radius;
        const surfaceY = hit.point.y;
        const buried = surfaceY - feetY;
        if (buried > 0.012 && buried < 0.55) {
            const targetFeet = surfaceY + 0.038;
            this.playerPosition.y = targetFeet + this.capsuleInfo.radius;
        }
    }
}

export default PhysicsManager;
