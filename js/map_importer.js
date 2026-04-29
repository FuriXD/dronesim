class MapImporter {
  constructor(grid, renderer) {
    this.grid = grid;
    this.renderer = renderer;
    this.map = null;
    this.modal = document.getElementById('map-modal');
    this.btnOpen = document.getElementById('btn-open-map');
    this.btnClose = document.getElementById('btn-close-map');
    this.btnImport = document.getElementById('btn-import-map');
    this.statusText = document.getElementById('map-status');
    this.searchInput = document.getElementById('map-search-input');
    this.btnSearch = document.getElementById('btn-map-search');

    this._bindEvents();
  }

  _bindEvents() {
    if (this.btnOpen) this.btnOpen.addEventListener('click', () => this.openMap());
    if (this.btnClose) this.btnClose.addEventListener('click', () => this.closeMap());
    if (this.btnImport) this.btnImport.addEventListener('click', () => this.importData());
    if (this.btnSearch) this.btnSearch.addEventListener('click', () => this.searchLocation());
    if (this.searchInput) this.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.searchLocation(); });
  }

  openMap() {
    this.modal.style.display = 'flex';
    
    if (!this.map) {
      // Initialize Leaflet map
      this.map = L.map('leaflet-map').setView([40.7128, -74.0060], 16); // Default: NYC
      
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        maxZoom: 19
      }).addTo(this.map);

      // Add a fixed bounding box overlay in the center to represent the grid size
      // A 400x350m box
      this.boxLayer = L.rectangle(this._getGridBounds(), {color: '#00ff88', weight: 2, fillOpacity: 0.1}).addTo(this.map);
      
      this.map.on('move', () => {
        this.boxLayer.setBounds(this._getGridBounds());
      });
    } else {
      this.map.invalidateSize();
    }
  }

  closeMap() {
    this.modal.style.display = 'none';
  }

  async searchLocation() {
    if (!this.searchInput) return;
    const query = this.searchInput.value.trim();
    if (!query) return;

    this.btnSearch.disabled = true;
    this.statusText.textContent = "Searching location...";

    try {
      // Check if query is coordinates (e.g. "40.7, -74.0")
      const coordsMatch = query.match(/^(-?\d+(\.\d+)?)[,\s]+(-?\d+(\.\d+)?)$/);
      if (coordsMatch) {
        const lat = parseFloat(coordsMatch[1]);
        const lon = parseFloat(coordsMatch[3]);
        this.map.setView([lat, lon], 16);
        this.statusText.textContent = "Moved to coordinates.";
      } else {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
        const data = await response.json();
        
        if (data && data.length > 0) {
          const lat = parseFloat(data[0].lat);
          const lon = parseFloat(data[0].lon);
          this.map.setView([lat, lon], 16);
          this.statusText.textContent = `Found: ${data[0].display_name}`;
        } else {
          this.statusText.textContent = "Location not found.";
        }
      }
    } catch (err) {
      console.error(err);
      this.statusText.textContent = "Error searching location.";
    } finally {
      this.btnSearch.disabled = false;
    }
  }

  _getGridBounds() {
    const center = this.map.getCenter();
    // Approx conversion: 1 deg lat = 111km, 1 deg lon = 111km * cos(lat)
    const latMeters = 350 / 2; // 35 rows * 10m
    const lonMeters = 400 / 2; // 40 cols * 10m
    
    const latDelta = latMeters / 111111;
    const lonDelta = lonMeters / (111111 * Math.cos(center.lat * Math.PI / 180));
    
    const southWest = L.latLng(center.lat - latDelta, center.lng - lonDelta);
    const northEast = L.latLng(center.lat + latDelta, center.lng + lonDelta);
    
    return L.latLngBounds(southWest, northEast);
  }

  async importData() {
    this.btnImport.disabled = true;
    this.statusText.textContent = "Fetching OpenStreetMap data...";
    
    const bounds = this._getGridBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    
    // Overpass QL to fetch buildings, water, and forests
    const query = `
      [out:json][timeout:25];
      (
        way["building"](${sw.lat},${sw.lng},${ne.lat},${ne.lng});
        way["natural"="water"](${sw.lat},${sw.lng},${ne.lat},${ne.lng});
        way["waterway"](${sw.lat},${sw.lng},${ne.lat},${ne.lng});
        way["natural"="wood"](${sw.lat},${sw.lng},${ne.lat},${ne.lng});
        way["landuse"="forest"](${sw.lat},${sw.lng},${ne.lat},${ne.lng});
      );
      out body;
      >;
      out skel qt;
    `;

    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: query
      });
      
      const data = await response.json();
      this.statusText.textContent = "Processing terrain data...";
      
      this._applyToGrid(data, bounds);
      
      this.statusText.textContent = "Import successful!";
      setTimeout(() => this.closeMap(), 1000);
      
    } catch (err) {
      console.error(err);
      this.statusText.textContent = "Error fetching map data.";
    } finally {
      this.btnImport.disabled = false;
    }
  }

  _applyToGrid(osmData, bounds) {
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    
    // Build a node dictionary
    const nodes = {};
    osmData.elements.forEach(el => {
      if (el.type === 'node') {
        nodes[el.id] = { lat: el.lat, lon: el.lon };
      }
    });

    // Clear existing grid (except start/target)
    for (let y = 0; y < this.grid.rows; y++) {
      for (let x = 0; x < this.grid.cols; x++) {
        if (this.grid.cells[y][x] !== CONFIG.CELL.START && this.grid.cells[y][x] !== CONFIG.CELL.TARGET) {
          this.grid.cells[y][x] = CONFIG.CELL.EMPTY;
        }
      }
    }

    // Process ways
    osmData.elements.forEach(el => {
      if (el.type === 'way' && el.nodes) {
        const polygon = el.nodes.map(nid => nodes[nid]).filter(n => n);
        if (polygon.length < 3) return; // Not a valid area

        let cellType = CONFIG.CELL.EMPTY;
        let height = 0;

        if (el.tags.building) {
          cellType = CONFIG.CELL.URBAN;
          height = el.tags.levels ? parseInt(el.tags.levels) * 3 : 5 + Math.random() * 5;
        } else if (el.tags.natural === 'water' || el.tags.waterway) {
          cellType = CONFIG.CELL.RIVER;
        } else if (el.tags.natural === 'wood' || el.tags.landuse === 'forest') {
          cellType = CONFIG.CELL.FOREST;
        }

        if (cellType !== CONFIG.CELL.EMPTY) {
          this._rasterizePolygon(polygon, bounds, cellType, height);
        }
      }
    });

    this.renderer.rebuildScene();
  }

  _rasterizePolygon(polygon, bounds, cellType, height) {
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();

    for (let y = 0; y < this.grid.rows; y++) {
      for (let x = 0; x < this.grid.cols; x++) {
        // Map grid x,y to lat,lon
        // y=0 is top (North), y=rows is bottom (South)
        // x=0 is left (West), x=cols is right (East)
        const cellLat = ne.lat - (y / this.grid.rows) * (ne.lat - sw.lat);
        const cellLon = sw.lng + (x / this.grid.cols) * (ne.lng - sw.lng);

        if (this._pointInPolygon({ lat: cellLat, lon: cellLon }, polygon)) {
          if (this.grid.cells[y][x] !== CONFIG.CELL.START && this.grid.cells[y][x] !== CONFIG.CELL.TARGET) {
            this.grid.cells[y][x] = cellType;
            if (cellType === CONFIG.CELL.URBAN) {
              if (!this.grid.obstacleHeights[y]) this.grid.obstacleHeights[y] = [];
              this.grid.obstacleHeights[y][x] = height;
            }
          }
        }
      }
    }
  }

  // Ray-casting algorithm for point in polygon
  _pointInPolygon(point, vs) {
    let x = point.lon, y = point.lat;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      let xi = vs[i].lon, yi = vs[i].lat;
      let xj = vs[j].lon, yj = vs[j].lat;
      let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
}
