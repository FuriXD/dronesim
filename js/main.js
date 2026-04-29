// ============================================================
// main.js — Entry point
// ============================================================

window._grid          = null;
window._threatManager = null;

(function () {
  'use strict';

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  let grid, drone, renderer, controls, threatManager, swarm;
  let lastTime = performance.now();

  function init() {
    const container = document.getElementById('viewport');

    if (!window.THREE) { showError('THREE.js failed to load.'); return; }

    const testCanvas = document.createElement('canvas');
    if (!testCanvas.getContext('webgl') && !testCanvas.getContext('experimental-webgl')) {
      showError('WebGL is not supported in this browser.'); return;
    }

    try {
      grid              = new Grid().generate();
      window._grid      = grid;

      threatManager          = new ThreatManager();
      window._threatManager  = threatManager;
      threatManager.init(grid);

      swarm  = new SwarmManager();
      drone  = new Drone(grid.start);

      renderer = new Renderer(container, grid, drone, threatManager, swarm);
      controls = new Controls(grid, drone, renderer, swarm, threatManager, regenMap);
      new MapImporter(grid, renderer);
    } catch (e) {
      showError('Init error: ' + e.message + '\n' + e.stack);
      console.error(e);
      return;
    }

    Drone.applySpecs(CONFIG.DRONE_SPECS);
    window.addEventListener('resize', () => renderer.resize());
    requestAnimationFrame(loop);
    controls.updateDashboard();
  }

  function showError(msg) {
    const el = document.getElementById('viewport');
    if (el) el.innerHTML = `<div style="color:#ff4444;font-family:monospace;padding:30px;font-size:13px;white-space:pre-wrap;">[ERROR]\n${msg}</div>`;
  }

  function loop(timestamp) {
    const now = performance.now();
    const dt  = Math.min((now - lastTime) / 1000, 0.1);  // cap dt at 100ms
    lastTime  = now;

    // Tick dynamic systems
    if (threatManager) threatManager.tick(dt, grid);
    if (swarm)         swarm.tick(now, grid, threatManager);

    // Drive drones
    if (controls) {
      controls.driveStep();
      controls.driveManual();
    }

    renderer.draw(timestamp);
    requestAnimationFrame(loop);
  }

  function regenMap() {
    if (controls) controls.reset();
    grid.generate();
    window._grid = grid;
    drone.updateStart(grid.start);
    drone.reset();

    if (threatManager) {
      threatManager.init(grid);
      window._threatManager = threatManager;
    }
    if (swarm) {
      swarm.clearAll();
    }

    renderer.grid = grid;
    renderer.rebuildScene();
    if (controls) controls.updateDashboard();
  }

})();
