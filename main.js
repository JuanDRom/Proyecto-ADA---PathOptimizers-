// Inicializa el mapa (centrado cerca de tus puntos, por ejemplo Bogotá)
const map = L.map('map').setView([4.65, -74.08], 13);

// Capa base
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// ==============================
//     CAPA DE PUNTOS DINÁMICOS
// ==============================
const pointsLayer = L.layerGroup().addTo(map);

// Manejo del input file para cargar POINTS.TSV
document.getElementById('fileInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  pointsLayer.clearLayers();

  const text = await file.text();
  const lines = text.trim().split('\n');

  console.log(`📂 Archivo "${file.name}" leído con ${lines.length - 1} puntos`);

  for (const line of lines.slice(1)) {
    const [x, y, id] = line.split('\t').map(s => s.trim());
    if (!x || !y) continue;

    const lon = parseFloat(x);
    const lat = parseFloat(y);

    try {
      const res = await fetch(`https://router.project-osrm.org/nearest/v1/driving/${lon},${lat}`);
      const json = await res.json();
      const snapped = json.waypoints[0].location;

      const marker = L.marker([snapped[1], snapped[0]])
        .bindPopup(`<b>Punto ${id}</b><br>(${snapped[1].toFixed(5)}, ${snapped[0].toFixed(5)})<br><i>Ajustado a calle</i>`);

      pointsLayer.addLayer(marker);

    } catch (err) {
      console.error(`Error al ajustar punto ${id}:`, err);
      const marker = L.marker([lat, lon])
        .bindPopup(`<b>Punto ${id}</b><br>(${lat.toFixed(5)}, ${lon.toFixed(5)})<br><i>Original</i>`);
      pointsLayer.addLayer(marker);
    }
  }

  const allMarkers = pointsLayer.getLayers().map(m => m.getLatLng());
  if (allMarkers.length) {
    const bounds = L.latLngBounds(allMarkers);
    map.fitBounds(bounds.pad(0.2));
  }

  console.log(`${lines.length - 1} puntos procesados y ajustados`);
});

// ==============================
//       OSM: VÍAS + ESQUINAS
// ==============================

const osmWaysLayer = L.layerGroup().addTo(map);
const junctionsLayer = L.layerGroup().addTo(map);

fetch('resources/chapinero.osm')
  .then(res => res.text())
  .then(osmText => {
    const parser = new DOMParser();
    const xml = parser.parseFromString(osmText, 'application/xml');

    // --- NODOS ---
    const nodes = new Map();
    xml.querySelectorAll('node').forEach(n => {
      const id = n.getAttribute('id');
      const lat = parseFloat(n.getAttribute('lat'));
      const lon = parseFloat(n.getAttribute('lon'));
      if (id && !Number.isNaN(lat) && !Number.isNaN(lon)) {
        nodes.set(id, { lat, lon });
      }
    });

    // --- WAYS ---
    const ways = [];
    xml.querySelectorAll('way').forEach(w => {
      const nds = Array.from(w.querySelectorAll('nd')).map(nd => nd.getAttribute('ref'));
      if (nds.length) ways.push(nds);
    });

    // Dibujar vías
    ways.forEach(nds => {
      const latlngs = nds.map(ref => nodes.get(ref))
        .filter(Boolean)
        .map(p => [p.lat, p.lon]);

      if (latlngs.length > 1) {
        L.polyline(latlngs, { color: '#3388ff', weight: 2, opacity: 0.6 })
          .addTo(osmWaysLayer);
      }
    });

    // --- ADJACENCIA ---
    const adjacency = new Map();
    ways.forEach(nds => {
      for (let i = 0; i < nds.length - 1; i++) {
        const a = nds[i];
        const b = nds[i + 1];

        if (!adjacency.has(a)) adjacency.set(a, new Set());
        if (!adjacency.has(b)) adjacency.set(b, new Set());

        adjacency.get(a).add(b);
        adjacency.get(b).add(a);
      }
    });

    // Ángulo en grados entre segmentos a-b-c
    function angleDegBetween(aId, bId, cId) {
      const A = nodes.get(aId);
      const B = nodes.get(bId);
      const C = nodes.get(cId);
      if (!A || !B || !C) return 180;

      const v1 = [A.lat - B.lat, A.lon - B.lon];
      const v2 = [C.lat - B.lat, C.lon - B.lon];

      const dot = v1[0] * v2[0] + v1[1] * v2[1];
      const n1 = Math.hypot(v1[0], v1[1]);
      const n2 = Math.hypot(v2[0], v2[1]);
      if (n1 === 0 || n2 === 0) return 180;

      let cos = dot / (n1 * n2);
      cos = Math.max(-1, Math.min(1, cos));
      return Math.acos(cos) * 180 / Math.PI;
    }

    const ANGLE_THRESHOLD_DEG = 160;
    const cornerRefs = [];

    adjacency.forEach((neighbors, id) => {
      const deg = neighbors.size;

      if (deg >= 3) {
        cornerRefs.push(id);
      } else if (deg === 2) {
        const [n1, n2] = Array.from(neighbors);
        const ang = angleDegBetween(n1, id, n2);
        if (ang < ANGLE_THRESHOLD_DEG) cornerRefs.push(id);
      }
    });

    // Dibujar esquinas
    cornerRefs.forEach(ref => {
      const p = nodes.get(ref);
      if (!p) return;

      const marker = L.circleMarker([p.lat, p.lon], {
        radius: 5,
        color: 'red',
        fillColor: '#f03',
        fillOpacity: 0.8
      }).bindPopup(`<b>Esquina</b><br>node ${ref}`);

      junctionsLayer.addLayer(marker);
    });

    console.log(`OSM: nodos=${nodes.size}, ways=${ways.length}, esquinas=${cornerRefs.length}`);

    // --- GRAFO PARA EXPORTAR ---
    const graph = {
      nodes: Array.from(nodes.entries()).map(([id, p]) => ({ id, lat: p.lat, lon: p.lon })),
      edges: []
    };

    const seenEdges = new Set();
    adjacency.forEach((neighbors, id) => {
      neighbors.forEach(nbr => {
        const a = id < nbr ? id : nbr;
        const b = id < nbr ? nbr : id;
        const key = `${a}-${b}`;

        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          graph.edges.push([a, b]);
        }
      });
    });

    // Control para exportar JSON
    const exportControl = L.control({ position: 'topright' });
    exportControl.onAdd = function () {
      const div = L.DomUtil.create('div', 'export-graph-control');
      div.style.background = 'white';
      div.style.padding = '6px';
      div.style.boxShadow = '0 1px 4px rgba(0,0,0,0.3)';

      const btn = L.DomUtil.create('button', '', div);
      btn.textContent = 'Exportar grafo JSON';
      btn.style.cursor = 'pointer';

      btn.onclick = () => {
        const blob = new Blob([JSON.stringify(graph)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'graph_chapinero.json';
        a.click();

        URL.revokeObjectURL(url);
      };

      return div;
    };
    exportControl.addTo(map);

  })
  .catch(err => console.error('Error al cargar/parsear chapinero.osm:', err));

// ==============================
//     CONTROL DE CAPAS
// ==============================
const overlays = {
  'Puntos cargados (TSV)': pointsLayer,
  'Vías OSM (chapinero.osm)': osmWaysLayer,
  'Esquinas / Intersecciones': junctionsLayer
};

L.control.layers(null, overlays, { collapsed: false }).addTo(map);

