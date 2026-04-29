// ============================================================
// renderer.js — Three.js 3D engine: smooth interpolation + altitude
// ============================================================

class Renderer {
  constructor(container, grid, drone, threatManager = null, swarm = null) {
    this.container      = container;
    this.grid           = grid;
    this.drone          = drone;
    this._threatManager = threatManager;
    this._swarm         = swarm;
    this.showPath       = true;

    this.scene         = null;
    this.camera        = null;
    this.threeRenderer = null;
    this.controls      = null;

    this.droneMesh  = null;
    this.droneLight = null;
    this.rotors     = [];
    this._statusLed = null;

    this.cellMeshes  = [];
    this.targetGroup = null;
    this.pathLine    = null;
    this.trailMeshes = [];

    this._dynThreatMeshes = [];
    this._patrolMeshes    = [];
    this._swarmGroups     = [];
    this._selectedThreatId = null;
    this._selectionRing   = null;

    this._movingTargetMesh = null;
    this._movingTargetTex  = null;
    this._movingTargetState = { cx: 0, cy: 0, vx: 1, vy: 1 };
    
    // Explosions
    this._explosions = [];

    this._stepStartTime = 0;
    this._interp        = 1;
    this._prevPos       = { x: drone.position.x, y: drone.position.y };
    this._currPos       = { x: drone.position.x, y: drone.position.y };
    this._currentAlt    = drone.altitude || CONFIG.DRONE_FLY_HEIGHT;

    this._init();
  }

  // ── Grid ↔ World ────────────────────────────────────────────

  _gw(col, row, h = 0) {
    return new THREE.Vector3(
      col - CONFIG.GRID_COLS / 2 + 0.5,
      h,
      row - CONFIG.GRID_ROWS / 2 + 0.5
    );
  }

  /** Dynamic altitude: normal cruise, or above obstacle if path crosses one */
  _droneAltAt(col, row) {
    const col_ = Math.round(col);
    const row_ = Math.round(row);
    const type = this.grid.get(col_, row_);
    if (type === CONFIG.CELL.OBSTACLE) {
      const h = this.grid.getObstacleHeight(col_, row_);
      return h + CONFIG.OBSTACLE_FLY_CLEARANCE;
    }
    return CONFIG.DRONE_FLY_HEIGHT;
  }

  // ── Init ────────────────────────────────────────────────────

  _init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(CONFIG.COLOR.BG);
    this.scene.fog = new THREE.FogExp2(CONFIG.COLOR.FOG, 0.020);

    const parent = this.container.parentElement || this.container;
    const w0 = parent.clientWidth  || (window.innerWidth  - 520);
    const h0 = parent.clientHeight || (window.innerHeight - 34);

    this.camera = new THREE.PerspectiveCamera(52, w0 / h0, 0.1, 200);
    this.camera.position.set(0, 24, 20);
    this.camera.lookAt(0, 0, 0);

    this.threeRenderer = new THREE.WebGLRenderer({ antialias: true });
    this.threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.threeRenderer.shadowMap.enabled = true;
    this.threeRenderer.shadowMap.type    = THREE.PCFSoftShadowMap;

    this.container.appendChild(this.threeRenderer.domElement);
    const canvas = this.threeRenderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.inset    = '0';
    canvas.style.width    = '100%';
    canvas.style.height   = '100%';

    this.threeRenderer.setSize(w0, h0);

    new ResizeObserver(() => this.resize()).observe(parent);

    this.controls = new THREE.OrbitControls(this.camera, this.threeRenderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = 5;
    this.controls.maxDistance = 65;
    this.controls.maxPolarAngle = Math.PI / 2.1;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.update();

    // Lighting
    this.scene.add(new THREE.AmbientLight(CONFIG.COLOR.AMBIENT, 0.9));
    const sun = new THREE.DirectionalLight(CONFIG.COLOR.DIR_LIGHT, 1.1);
    sun.position.set(8, 20, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near  = 0.5;
    sun.shadow.camera.far   = 80;
    sun.shadow.camera.left  = sun.shadow.camera.bottom = -22;
    sun.shadow.camera.right = sun.shadow.camera.top    =  22;
    this.scene.add(sun);

    this._buildStarfield();
    this._buildGround();
    this._buildGridLines();
    this._buildCells();
    this._buildDrone();
    this._initDynamicMeshes();

    window.addEventListener('resize', () => this.resize());
  }

  _buildGround() {
    const geo  = new THREE.PlaneGeometry(CONFIG.GRID_COLS, CONFIG.GRID_ROWS);
    const mat  = new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.EMPTY_GROUND });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.01;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  _buildGridLines() {
    const hC = CONFIG.GRID_COLS / 2, hR = CONFIG.GRID_ROWS / 2;
    const pts = [];
    for (let c = 0; c <= CONFIG.GRID_COLS; c++) {
      const x = c - hC;
      pts.push(new THREE.Vector3(x, 0.005, -hR), new THREE.Vector3(x, 0.005, hR));
    }
    for (let r = 0; r <= CONFIG.GRID_ROWS; r++) {
      const z = r - hR;
      pts.push(new THREE.Vector3(-hC, 0.005, z), new THREE.Vector3(hC, 0.005, z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0x1a2a1a, opacity: 0.5, transparent: true });
    this.scene.add(new THREE.LineSegments(geo, mat));
  }

  _buildStarfield() {
    const pts = [];
    for (let i = 0; i < 280; i++) {
      pts.push((Math.random() - 0.5) * 140, 30 + Math.random() * 40, (Math.random() - 0.5) * 140);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x224422, size: 0.12 })));
  }

  // ── Cells ───────────────────────────────────────────────────

  _buildCells() {
    const { CELL } = CONFIG;
    for (let row = 0; row < CONFIG.GRID_ROWS; row++) {
      this.cellMeshes[row] = [];
      for (let col = 0; col < CONFIG.GRID_COLS; col++) {
        const result = this._createCell(this.grid.get(col, row), col, row);
        if (result) { this.scene.add(result); this.cellMeshes[row][col] = result; }
      }
    }
  }

  _createCell(type, col, row) {
    const { CELL } = CONFIG;
    const wp = this._gw(col, row);

    switch (type) {
      case CELL.OBSTACLE: {
        // Height comes from grid (pre-computed and shared with pathfinder)
        const h   = this.grid.getObstacleHeight(col, row);
        const geo = new THREE.BoxGeometry(0.88, h, 0.88);
        const mat = new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.OBSTACLE });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(wp.x, h / 2, wp.z);
        mesh.castShadow = mesh.receiveShadow = true;
        return mesh;
      }

      case CELL.THREAT: {
        const geo  = new THREE.BoxGeometry(0.96, 1.1, 0.96);
        const mat  = new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.THREAT, transparent: true, opacity: 0.28, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(wp.x, 0.55, wp.z);
        mesh._isThreat = true;
        return mesh;
      }

      case CELL.SAFE: {
        const geo  = new THREE.BoxGeometry(0.96, 0.06, 0.96);
        const mat  = new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.SAFE, transparent: true, opacity: 0.75 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(wp.x, 0.03, wp.z);
        return mesh;
      }

      case CELL.TARGET: {
        const group = new THREE.Group();

        const base = new THREE.Mesh(
          new THREE.CylinderGeometry(0.44, 0.44, 0.08, 20),
          new THREE.MeshLambertMaterial({ color: 0xaa8800 })
        );
        base.position.set(0, 0.04, 0);
        group.add(base);

        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.035, 0.035, 1.8, 8),
          new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.TARGET })
        );
        pole.position.y = 1.0;
        group.add(pole);

        [0.44, 0.30, 0.16].forEach((r, i) => {
          const t = new THREE.Mesh(
            new THREE.TorusGeometry(r, 0.022, 8, 28),
            new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.TARGET, transparent: true, opacity: i === 0 ? 0.55 : 0.9 })
          );
          t.rotation.x = Math.PI / 2;
          t.position.y = 2.0;
          group.add(t);
        });

        const tLight = new THREE.PointLight(CONFIG.COLOR.TARGET_LIGHT, 1.8, 5);
        tLight.position.y = 2.2;
        group.add(tLight);
        group._targetLight = tLight;

        group.position.set(wp.x, 0, wp.z);
        this.targetGroup = group;
        this.scene.add(group);
        return null;
      }

      case CELL.START: {
        const geo  = new THREE.BoxGeometry(0.88, 0.04, 0.88);
        const mat  = new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.START });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(wp.x, 0.02, wp.z);
        return mesh;
      }

      case CELL.URBAN: {
        const h     = this.grid.getObstacleHeight(col, row) || 3.5;
        const group = new THREE.Group();
        const bMesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.82, h, 0.82),
          new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.URBAN })
        );
        bMesh.position.y = h / 2;
        bMesh.castShadow = true;
        group.add(bMesh);
        const top = new THREE.Mesh(
          new THREE.BoxGeometry(0.88, 0.10, 0.88),
          new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.URBAN_TOP })
        );
        top.position.y = h + 0.05;
        group.add(top);
        const numFloors = Math.max(1, Math.floor(h * 0.85));
        for (let fl = 0; fl < numFloors; fl++) {
          const yy  = 0.55 + fl * (h / (numFloors + 0.5));
          const lit = Math.random() > 0.35;
          const wMat = new THREE.MeshBasicMaterial({ color: lit ? 0xffee88 : 0x223344, transparent: true, opacity: lit ? 0.88 : 0.3 });
          [{ px: 0, pz: 0.415, ry: 0 }, { px: 0, pz: -0.415, ry: Math.PI },
           { px: 0.415, pz: 0, ry: Math.PI / 2 }, { px: -0.415, pz: 0, ry: -Math.PI / 2 }].forEach(f => {
            const w = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.13), wMat.clone());
            w.position.set(f.px, yy, f.pz);
            w.rotation.y = f.ry;
            group.add(w);
          });
        }
        group.position.set(wp.x, 0, wp.z);
        return group;
      }

      case CELL.FOREST: {
        const group  = new THREE.Group();
        const trunkH = 0.4 + Math.random() * 0.3;
        const trunk  = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.09, trunkH, 6),
          new THREE.MeshLambertMaterial({ color: 0x3d1c02 })
        );
        trunk.position.y = trunkH / 2;
        group.add(trunk);
        [0, 0.3, 0.55].forEach((off, i) => {
          const r = 0.30 - i * 0.07;
          if (r <= 0) return;
          const cH   = 0.85 - i * 0.18;
          const cone = new THREE.Mesh(
            new THREE.ConeGeometry(r, cH, 7),
            new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.FOREST_CONE })
          );
          cone.position.y = trunkH + off * 0.9 + cH / 2;
          group.add(cone);
        });
        group.position.set(wp.x, 0, wp.z);
        return group;
      }

      case CELL.RIVER: {
        const geo  = new THREE.PlaneGeometry(0.96, 0.96);
        const mat  = new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.RIVER_SURFACE, transparent: true, opacity: 0.72 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(wp.x, 0.015, wp.z);
        mesh._isRiver = true;
        return mesh;
      }

      default: return null;
    }
  }

  // ── Dynamic threat & patrol meshes ──────────────────────────

  _initDynamicMeshes() {
    this._dynThreatMeshes.forEach(m => this.scene.remove(m));
    this._patrolMeshes.forEach(m => this.scene.remove(m));
    if (this._selectionRing) { this.scene.remove(this._selectionRing); this._selectionRing = null; }
    this._dynThreatMeshes = [];
    this._patrolMeshes    = [];
    this._selectedThreatId = null;
    if (!this._threatManager) return;
    for (const t of this._threatManager.dynamicThreats) {
      this._addDynThreatMesh(t);
    }
    for (const p of this._threatManager.patrolObstacles) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.82, 2.6, 0.82),
        new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.PATROL })
      );
      mesh._patrolRef = p;
      this.scene.add(mesh);
      this._patrolMeshes.push(mesh);
    }

    // Build the selection ring (shared, repositioned to selected threat)
    const ringGeo = new THREE.TorusGeometry(1.3, 0.055, 8, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.85 });
    this._selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this._selectionRing.rotation.x = Math.PI / 2;
    this._selectionRing.visible = false;
    this.scene.add(this._selectionRing);
  }

  /** Create and register a mesh for a single dynamic threat. */
  _addDynThreatMesh(t) {
    let geo, matColor;
    if (t.type === 'ANTI_AIR') {
      geo = new THREE.CylinderGeometry(t.radius * 0.85, t.radius * 0.85, 2.0, 16);
      matColor = 0xff8800; // orange
    } else if (t.type === 'PERSONNEL') {
      geo = new THREE.BoxGeometry(0.8, 1.8, 0.8);
      matColor = 0xffff00; // yellow
    } else { // ENEMY_DRONE
      geo = new THREE.SphereGeometry(t.radius * 0.85, 12, 8);
      matColor = CONFIG.COLOR.DYN_THREAT;
    }
    
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: matColor, transparent: true, opacity: 0.25, depthWrite: false })
    );
    mesh._threatRef = t;
    mesh._baseColor = matColor;
    
    const ringGeo = new THREE.RingGeometry(t.radius * 0.85, t.radius * 0.95, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: matColor, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
    const radarRing = new THREE.Mesh(ringGeo, ringMat);
    radarRing.rotation.x = -Math.PI / 2;
    radarRing.position.y = -0.4;
    mesh.add(radarRing);
    mesh._radarRing = radarRing;

    this.scene.add(mesh);
    this._dynThreatMeshes.push(mesh);
    return mesh;
  }

  /** Sync mesh list when a threat is removed externally. */
  removeDynThreatMesh(threatId) {
    const idx = this._dynThreatMeshes.findIndex(m => m._threatRef && m._threatRef.id === threatId);
    if (idx === -1) return;
    this.scene.remove(this._dynThreatMeshes[idx]);
    this._dynThreatMeshes.splice(idx, 1);
    if (this._selectedThreatId === threatId) {
      this._selectedThreatId = null;
      if (this._selectionRing) this._selectionRing.visible = false;
    }
  }

  _updateDynamicMeshes(timestamp) {
    if (!this._threatManager || !CONFIG.THREAT_ENABLED) {
      this._dynThreatMeshes.forEach(m => { m.visible = false; });
      this._patrolMeshes.forEach(m => { m.visible = false; });
      if (this._selectionRing) this._selectionRing.visible = false;
      return;
    }
    const pulse = 0.16 + 0.10 * Math.sin(timestamp * 0.0038);
    for (const mesh of this._dynThreatMeshes) {
      const t = mesh._threatRef;
      if (!t) continue;
      mesh.visible = true;
      mesh.position.copy(this._gw(t.cx, t.cy, 0.8));
      const sc = 1 + 0.18 * Math.sin(t.phase);
      mesh.scale.setScalar(Math.max(0.1, sc));
      mesh.material.opacity = pulse * t.intensity;
      if (!t.frozen) mesh.rotation.y += 0.018;

      if (mesh._radarRing) {
        const pingPhase = (timestamp * 0.0015 + t.id * 0.5) % 2;
        if (pingPhase < 1) {
          const sc = 1 + pingPhase * 3;
          mesh._radarRing.scale.set(sc, sc, sc);
          mesh._radarRing.material.opacity = (1 - pingPhase) * 0.6;
          mesh._radarRing.visible = true;
        } else {
          mesh._radarRing.visible = false;
        }
      }

      // Highlight selected threat
      const isSelected = (t.id === this._selectedThreatId);
      mesh.material.color.setHex(isSelected ? 0xffffff : mesh._baseColor);
      mesh.material.opacity = isSelected
        ? 0.55 + 0.20 * Math.sin(timestamp * 0.007)
        : pulse * t.intensity;
    }

    // Move selection ring to selected threat
    if (this._selectionRing) {
      const selMesh = this._dynThreatMeshes.find(m => m._threatRef && m._threatRef.id === this._selectedThreatId);
      if (selMesh && selMesh.visible) {
        this._selectionRing.position.copy(selMesh.position);
        this._selectionRing.rotation.z += 0.025;
        this._selectionRing.visible = true;
        this._selectionRing.material.opacity = 0.6 + 0.35 * Math.sin(timestamp * 0.006);
      } else {
        this._selectionRing.visible = false;
      }
    }

    for (const mesh of this._patrolMeshes) {
      const p = mesh._patrolRef;
      if (!p) continue;
      mesh.visible = true;
      mesh.position.copy(this._gw(p.cx, p.cy, 1.3));
    }
  }

  /**
   * Raycast against dynamic threat sphere meshes.
   * Returns the nearest threat object or null.
   */
  getClickedThreat(clientX, clientY) {
    const rect   = this.container.getBoundingClientRect();
    const mouse  = new THREE.Vector2(
      ((clientX - rect.left) / rect.width)  * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);
    raycaster.params.Mesh.threshold = 0.4;

    // Temporarily scale up spheres for easier clicking
    const intersects = raycaster.intersectObjects(this._dynThreatMeshes);
    if (intersects.length === 0) return null;
    return intersects[0].object._threatRef || null;
  }

  // ── Swarm drone groups ───────────────────────────────────────

  _buildSwarmDroneGroup(role) {
    const color  = CONFIG.SWARM_ROLE_COLOR[role] ?? 0xffffff;
    const group  = new THREE.Group();
    const body   = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.08, 0.22),
      new THREE.MeshLambertMaterial({ color: 0x111111 })
    );
    group.add(body);
    const rotors = [];
    [45, 135, 225, 315].forEach((deg, idx) => {
      const rad = deg * Math.PI / 180;
      const r   = 0.24;
      const ax  = Math.cos(rad) * r, az = Math.sin(rad) * r;
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(r * 1.8, 0.028, 0.044),
        new THREE.MeshLambertMaterial({ color })
      );
      arm.position.set(ax * 0.5, 0, az * 0.5);
      arm.rotation.y = -rad;
      group.add(arm);
      const rotor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.13, 0.012, 14),
        new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.5 })
      );
      rotor.position.set(ax, 0.04, az);
      group.add(rotor);
      rotors.push({ mesh: rotor, dir: idx % 2 === 0 ? 1 : -1 });
    });
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.025, 6, 4),
      new THREE.MeshBasicMaterial({ color })
    );
    led.position.set(0, 0.055, 0);
    group.add(led);
    const light = new THREE.PointLight(color, 1.2, 4);
    group.add(light);
    return { group, rotors, led };
  }

  _syncSwarmGroups() {
    if (!this._swarm) return;
    // Add groups for any new members
    while (this._swarmGroups.length < this._swarm.members.length) {
      const m   = this._swarm.members[this._swarmGroups.length];
      const sg  = this._buildSwarmDroneGroup(m.role);
      const wp  = this._gw(m.drone.position.x, m.drone.position.y, CONFIG.DRONE_FLY_HEIGHT);
      sg.group.position.copy(wp);
      this.scene.add(sg.group);
      this._swarmGroups.push(sg);
    }
    // Remove excess groups
    while (this._swarmGroups.length > this._swarm.members.length) {
      const sg = this._swarmGroups.pop();
      this.scene.remove(sg.group);
    }
  }

  _updateSwarmDrones() {
    if (!this._swarm) return;
    this._syncSwarmGroups();
    for (let i = 0; i < this._swarm.members.length; i++) {
      const m  = this._swarm.members[i];
      const sg = this._swarmGroups[i];
      if (!sg) continue;
      const targetWP = this._gw(m.drone.position.x, m.drone.position.y, CONFIG.DRONE_FLY_HEIGHT);
      sg.group.position.lerp(targetWP, 0.10);
      sg.group.visible = !m.drone.status.includes('FAILED');
      const rSpeed = m.drone.isNavigating ? CONFIG.ROTOR_SPEED : CONFIG.ROTOR_SPEED * 0.2;
      sg.rotors.forEach(r => { r.mesh.rotation.y += rSpeed * r.dir; });
      if (m.drone.isNavigating) sg.group.rotation.y += 0.008;
    }
  }

  // ── Drone model ─────────────────────────────────────────────

  _buildDrone() {
    this.droneMesh = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.10, 0.28),
      new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.DRONE_BODY })
    );
    this.droneMesh.add(body);

    const cam = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x111133, transparent: true, opacity: 0.8 })
    );
    cam.position.y = -0.06;
    this.droneMesh.add(cam);

    this.rotors = [];
    [45, 135, 225, 315].forEach((deg, idx) => {
      const rad = deg * Math.PI / 180;
      const r   = 0.30;
      const ax  = Math.cos(rad) * r;
      const az  = Math.sin(rad) * r;

      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(r * 1.9, 0.035, 0.055),
        new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.DRONE_ARM })
      );
      arm.position.set(ax * 0.5, 0, az * 0.5);
      arm.rotation.y = -rad;
      this.droneMesh.add(arm);

      const mount = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, 0.075, 8),
        new THREE.MeshLambertMaterial({ color: 0x1a1a1a })
      );
      mount.position.set(ax, 0, az);
      this.droneMesh.add(mount);

      const rotor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.17, 0.015, 18),
        new THREE.MeshLambertMaterial({ color: CONFIG.COLOR.DRONE_ROTOR, transparent: true, opacity: 0.5 })
      );
      rotor.position.set(ax, 0.05, az);
      this.droneMesh.add(rotor);
      this.rotors.push({ mesh: rotor, dir: idx % 2 === 0 ? 1 : -1 });
    });

    this._statusLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 6, 4),
      new THREE.MeshBasicMaterial({ color: 0x00ff88 })
    );
    this._statusLed.position.set(0, 0.07, 0);
    this.droneMesh.add(this._statusLed);

    this.droneLight = new THREE.PointLight(CONFIG.COLOR.DRONE_LIGHT, 1.8, 6);
    this.droneMesh.add(this.droneLight);

    const spot = new THREE.SpotLight(0x00ff44, 0.9, 8, Math.PI / 7, 0.5);
    spot.position.y = 0;
    spot.target.position.set(0, -4, 0);
    this.droneMesh.add(spot);
    this.droneMesh.add(spot.target);

    const startWP = this._gw(this.drone.position.x, this.drone.position.y, CONFIG.DRONE_FLY_HEIGHT);
    this.droneMesh.position.copy(startWP);
    this.scene.add(this.droneMesh);
  }

  // ── Main draw ────────────────────────────────────────────────

  draw(timestamp) {
    this.controls.update();

    // ── Timestamp-based smooth interpolation ──────────────────
    // _interp goes from 0 → 1 over exactly MOVE_INTERVAL_MS milliseconds
    const elapsed = performance.now() - this._stepStartTime;
    this._interp = Math.min(1, elapsed / Math.max(80, CONFIG.MOVE_INTERVAL_MS));
    const t = this._easeOut(this._interp);

    // Interpolated grid coords (fractional, not quantised)
    const iCol = this._prevPos.x + (this._currPos.x - this._prevPos.x) * t;
    const iRow = this._prevPos.y + (this._currPos.y - this._prevPos.y) * t;

    // ── Altitude ───────────────────────────────────────────────
    // AUTO mode: lerp between cell-based altitudes along the path
    // MANUAL mode: use drone.altitude directly (user-controlled with Q/E)
    let targetAlt;
    if (this.drone.mode === 'MANUAL') {
      targetAlt = this.drone.altitude;
    } else {
      const prevAlt = this._droneAltAt(this._prevPos.x, this._prevPos.y);
      const currAlt = this._droneAltAt(this._currPos.x, this._currPos.y);
      targetAlt = prevAlt + (currAlt - prevAlt) * t;
    }
    // Smooth convergence to target altitude every frame
    this._currentAlt = THREE.MathUtils.lerp(this._currentAlt, targetAlt, 0.10);

    const hover = Math.sin(timestamp * 0.0022) * 0.07;
    const wp    = this._gw(iCol, iRow, this._currentAlt + hover);
    this.droneMesh.position.copy(wp);

    // Body tilt during movement
    if (this._interp < 1) {
      const dx = this._currPos.x - this._prevPos.x;
      const dz = this._currPos.y - this._prevPos.y;
      this.droneMesh.rotation.x = THREE.MathUtils.lerp(this.droneMesh.rotation.x, dz * 0.18, 0.22);
      this.droneMesh.rotation.z = THREE.MathUtils.lerp(this.droneMesh.rotation.z, -dx * 0.18, 0.22);
    } else {
      this.droneMesh.rotation.x = THREE.MathUtils.lerp(this.droneMesh.rotation.x, 0, 0.12);
      this.droneMesh.rotation.z = THREE.MathUtils.lerp(this.droneMesh.rotation.z, 0, 0.12);
    }

    // Rotor spin
    const rSpeed = this.drone.isNavigating ? CONFIG.ROTOR_SPEED : CONFIG.ROTOR_SPEED * 0.25;
    this.rotors.forEach(r => { r.mesh.rotation.y += rSpeed * r.dir; });

    // Body yaw while navigating
    if (this.drone.isNavigating) this.droneMesh.rotation.y += 0.01;

    // LED status color
    if (this._statusLed) {
      this._statusLed.material.color.setHex(
        this.drone.status === STATUS.REACHED   ? 0x44ff44 :
        this.drone.status === STATUS.FAILED    ? 0xff2222 :
        this.drone.isNavigating                ? 0x00ffcc :
        this.drone.inThreatZone                ? 0xff6600 : 0xffcc00
      );
    }

    // Pulsing threat cells
    const tPulse = 0.22 + 0.16 * Math.sin(timestamp * 0.003);
    this.cellMeshes.forEach(row => {
      row && row.forEach(m => { if (m && m._isThreat) m.material.opacity = tPulse; });
    });

    // Animated river cells
    const rOpacity = 0.60 + 0.18 * Math.sin(timestamp * 0.0017);
    this.cellMeshes.forEach(row => {
      row && row.forEach(m => { if (m && m._isRiver) m.material.opacity = rOpacity; });
    });

    // Pulsing target light
    if (this.targetGroup?._targetLight) {
      this.targetGroup._targetLight.intensity = 1.4 + 0.9 * Math.sin(timestamp * 0.004);
    }

    // Dynamic threats + patrol obstacles
    this._updateDynamicMeshes(timestamp);

    // Moving target
    this._updateMovingTarget(timestamp);

    // Swarm drones
    this._updateSwarmDrones();

    // ── Altitude meter HUD ─────────────────────────────────────
    if (!this._altFill) {
      this._altFill    = document.getElementById('alt-fill');
      this._altReadout = document.getElementById('alt-readout');
    }
    if (this._altFill) {
      const range = CONFIG.DRONE_MAX_ALT - CONFIG.DRONE_MIN_ALT;
      const pct   = ((this._currentAlt - CONFIG.DRONE_MIN_ALT) / range) * 100;
      this._altFill.style.height    = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
      this._altReadout.textContent  = this._currentAlt.toFixed(2);
    }

    this.threeRenderer.render(this.scene, this.camera);
  }

  // Called immediately when drone advances one cell
  onDroneStep() {
    this._prevPos      = { ...this._currPos };
    this._currPos      = { x: this.drone.position.x, y: this.drone.position.y };
    this._stepStartTime = performance.now();
    this._interp        = 0;

    this._refreshTrail();
    if (this.showPath) this._refreshPath();
  }

  // ── Path & trail ─────────────────────────────────────────────

  _refreshPath() {
    if (this.pathLine) { this.scene.remove(this.pathLine); this.pathLine = null; }
    const path = this.drone.fullPath;
    if (!path || path.length < 2 || !this.showPath) return;

    // Path altitude follows obstacle heights — shows 3D flyover visually
    const points = path.map(p => {
      const alt = this._droneAltAt(p.x, p.y) + 0.1;
      return this._gw(p.x, p.y, alt);
    });
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color: CONFIG.COLOR.PATH, transparent: true, opacity: 0.55 });
    this.pathLine = new THREE.Line(geo, mat);
    this.scene.add(this.pathLine);
  }

  _refreshTrail() {
    this.trailMeshes.forEach(m => this.scene.remove(m));
    this.trailMeshes = [];

    this.drone.trail.forEach((p, i) => {
      const frac = (i + 1) / this.drone.trail.length;
      const geo  = new THREE.SphereGeometry(0.055 * frac, 4, 4);
      const mat  = new THREE.MeshBasicMaterial({ color: 0x00cc66, transparent: true, opacity: frac * 0.45 });
      const m    = new THREE.Mesh(geo, mat);
      m.position.copy(this._gw(p.x, p.y, this._droneAltAt(p.x, p.y) - 0.05));
      this.scene.add(m);
      this.trailMeshes.push(m);
    });
  }

  // ── Rebuild single cell (terrain editor) ──────────────────────

  rebuildCell(col, row) {
    if (!this.cellMeshes[row]) this.cellMeshes[row] = [];
    const old = this.cellMeshes[row][col];
    if (old) { this.scene.remove(old); this.cellMeshes[row][col] = null; }

    // If old cell was the target group, remove it
    if (this.targetGroup) {
      const tgt = this.grid.target;
      if (tgt && tgt.x === col && tgt.y === row) {
        this.scene.remove(this.targetGroup);
        this.targetGroup = null;
      }
    }

    const mesh = this._createCell(this.grid.get(col, row), col, row);
    if (mesh) {
      this.scene.add(mesh);
      this.cellMeshes[row][col] = mesh;
    }
    // If target was placed here, _createCell handles targetGroup internally
  }

  // ── Rebuild (after map regen) ────────────────────────────────

  rebuildScene() {
    this.cellMeshes.forEach(row => row && row.forEach(m => m && this.scene.remove(m)));
    this.cellMeshes = [];
    if (this.targetGroup)  { this.scene.remove(this.targetGroup); this.targetGroup = null; }
    if (this.pathLine)     { this.scene.remove(this.pathLine);    this.pathLine    = null; }
    this.trailMeshes.forEach(m => this.scene.remove(m));
    this.trailMeshes = [];

    // Remove swarm groups
    this._swarmGroups.forEach(sg => this.scene.remove(sg.group));
    this._swarmGroups = [];

    if (this.droneMesh) this.scene.remove(this.droneMesh);

    this._buildCells();
    this._initDynamicMeshes();

    this._prevPos = { x: this.drone.position.x, y: this.drone.position.y };
    this._currPos = { x: this.drone.position.x, y: this.drone.position.y };
    this._stepStartTime = 0;
    this._interp = 1;
    this._currentAlt = this.drone.altitude || CONFIG.DRONE_FLY_HEIGHT;
    this.droneMesh.position.copy(this._gw(this.drone.position.x, this.drone.position.y, this._currentAlt));
    this.scene.add(this.droneMesh);
  }

  // ── Explosions ───────────────────────────────────────────────

  triggerExplosion(x, y) {
    const geo = new THREE.SphereGeometry(0.5, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 1.0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(this._gw(x, y, 1.0));
    this.scene.add(mesh);
    this._explosions.push({ mesh, startTime: performance.now(), duration: 1200 });
  }

  _updateExplosions(timestamp) {
    for (let i = this._explosions.length - 1; i >= 0; i--) {
      const exp = this._explosions[i];
      const elapsed = timestamp - exp.startTime;
      if (elapsed > exp.duration) {
        this.scene.remove(exp.mesh);
        exp.mesh.geometry.dispose();
        exp.mesh.material.dispose();
        this._explosions.splice(i, 1);
        continue;
      }
      const progress = elapsed / exp.duration;
      // Expand quickly, then slow down
      const scale = 1 + Math.pow(progress, 0.5) * 8;
      exp.mesh.scale.set(scale, scale, scale);
      // Fade out
      exp.mesh.material.opacity = 1 - progress;
      // Shift color from yellow/orange to red/dark
      const hue = 0.1 - (progress * 0.1);
      exp.mesh.material.color.setHSL(Math.max(0, hue), 1.0, 0.5);
    }
  }

  // ── Moving Photo Target ──────────────────────────────────────

  setMovingTargetTexture(dataUrl) {
    const loader = new THREE.TextureLoader();
    loader.load(dataUrl, (tex) => {
      this._movingTargetTex = tex;
      this._movingTargetTex.colorSpace = THREE.SRGBColorSpace;
      
      if (this._movingTargetMesh) {
        this.scene.remove(this._movingTargetMesh);
      }
      
      const geo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
      const mat = new THREE.MeshLambertMaterial({ map: this._movingTargetTex });
      this._movingTargetMesh = new THREE.Mesh(geo, mat);
      this._movingTargetMesh.position.copy(this._gw(this.grid.target ? this.grid.target.x : 0, this.grid.target ? this.grid.target.y : 0, 1.0));
      
      if (CONFIG.MOVING_TARGET_ENABLED) {
        this.scene.add(this._movingTargetMesh);
        this._movingTargetState.cx = this.grid.target ? this.grid.target.x : 0;
        this._movingTargetState.cy = this.grid.target ? this.grid.target.y : 0;
        
        // Pick a random initial direction
        const ang = Math.random() * Math.PI * 2;
        this._movingTargetState.vx = Math.cos(ang);
        this._movingTargetState.vy = Math.sin(ang);
      }
    });
  }

  toggleMovingTarget(enabled) {
    if (!this._movingTargetMesh) return;
    if (enabled) {
      this.scene.add(this._movingTargetMesh);
      this._movingTargetState.cx = this.grid.target ? this.grid.target.x : 0;
      this._movingTargetState.cy = this.grid.target ? this.grid.target.y : 0;
    } else {
      this.scene.remove(this._movingTargetMesh);
    }
  }

  _updateMovingTarget(timestamp) {
    if (!CONFIG.MOVING_TARGET_ENABLED || !this._movingTargetMesh) return;

    // Time delta for movement
    const dt = 16 / 1000; // Approx 60FPS
    const speed = CONFIG.MOVING_TARGET_SPEED;

    this._movingTargetState.cx += this._movingTargetState.vx * speed * dt;
    this._movingTargetState.cy += this._movingTargetState.vy * speed * dt;

    // Bounce off edges
    if (this._movingTargetState.cx <= 0) {
      this._movingTargetState.cx = 0;
      this._movingTargetState.vx *= -1;
    } else if (this._movingTargetState.cx >= CONFIG.GRID_COLS - 1) {
      this._movingTargetState.cx = CONFIG.GRID_COLS - 1;
      this._movingTargetState.vx *= -1;
    }

    if (this._movingTargetState.cy <= 0) {
      this._movingTargetState.cy = 0;
      this._movingTargetState.vy *= -1;
    } else if (this._movingTargetState.cy >= CONFIG.GRID_ROWS - 1) {
      this._movingTargetState.cy = CONFIG.GRID_ROWS - 1;
      this._movingTargetState.vy *= -1;
    }

    // Update mesh position and rotation
    this._movingTargetMesh.position.copy(this._gw(this._movingTargetState.cx, this._movingTargetState.cy, 1.2));
    this._movingTargetMesh.rotation.y += 0.02;
    this._movingTargetMesh.rotation.x += 0.01;

    // Update actual grid target cell so the drone follows it
    const newCol = Math.round(this._movingTargetState.cx);
    const newRow = Math.round(this._movingTargetState.cy);

    if (this.grid.target && (newCol !== this.grid.target.x || newRow !== this.grid.target.y)) {
      this.grid.setTarget(newCol, newRow);
    }
  }

  // ── Resize ───────────────────────────────────────────────────

  resize() {
    const parent = this.container.parentElement || this.container;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.threeRenderer.setSize(w, h);
  }

  // ── Raycasting for click-to-set-target ───────────────────────

  cellFromPixel(clientX, clientY) {
    const rect  = this.container.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left)  / rect.width)  * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);
    const plane  = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const target = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, target)) return null;
    const col = Math.floor(target.x + CONFIG.GRID_COLS / 2);
    const row = Math.floor(target.z + CONFIG.GRID_ROWS / 2);
    if (col < 0 || row < 0 || col >= CONFIG.GRID_COLS || row >= CONFIG.GRID_ROWS) return null;
    return { x: col, y: row };
  }

  _easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  get domElement() { return this.threeRenderer.domElement; }
}
