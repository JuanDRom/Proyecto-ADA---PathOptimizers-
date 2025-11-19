// Inicializa el mapa (centrado cerca de tus puntos, por ejemplo Bogotá)
const map = L.map('map').setView([4.65, -74.08], 13);

// Capa base
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Capa de puntos cargados
const pointsLayer = L.layerGroup().addTo(map);

// Escucha el archivo cargado desde el input en index.html
document.getElementById('fileInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  // Limpiar puntos anteriores
  pointsLayer.clearLayers();

  // Leer el archivo como texto
  const text = await file.text();
  const lines = text.trim().split('\n');

  console.log(`📂 Archivo "${file.name}" leído con ${lines.length - 1} puntos`);

  // Procesar cada línea (formato: x	y	id)
  for (const line of lines.slice(1)) {
    const [x, y, id] = line.split('\t').map(s => s.trim());
    if (!x || !y) continue;

    const lon = parseFloat(x);
    const lat = parseFloat(y);

    try {
      // 🔹 Ajuste opcional a la calle más cercana (usando OSRM)
      const res = await fetch(`https://router.project-osrm.org/nearest/v1/driving/${lon},${lat}`);
      const json = await res.json();
      const snapped = json.waypoints[0].location;
      const newLon = snapped[0];
      const newLat = snapped[1];

      const marker = L.marker([newLat, newLon])
        .bindPopup(`<b>Punto ${id}</b><br>(${newLat.toFixed(5)}, ${newLon.toFixed(5)})<br><i>Ajustado a calle</i>`);
      pointsLayer.addLayer(marker);
    } catch (err) {
      console.error(`Error al ajustar punto ${id}:`, err);
      // Si falla el ajuste, usar la posición original
      const marker = L.marker([lat, lon])
        .bindPopup(`<b>Punto ${id}</b><br>(${lat.toFixed(5)}, ${lon.toFixed(5)})<br><i>Original</i>`);
      pointsLayer.addLayer(marker);
    }
  }

  // Ajustar el zoom a los puntos cargados
  const allMarkers = pointsLayer.getLayers().map(m => m.getLatLng());
  if (allMarkers.length) {
    const bounds = L.latLngBounds(allMarkers);
    map.fitBounds(bounds.pad(0.2));
  }

  console.log(`${lines.length - 1} puntos procesados y ajustados`);
});



    


// Capas para los datos OSM
const osmWaysLayer = L.layerGroup().addTo(map);
const junctionsLayer = L.layerGroup().addTo(map);

// Estado inicial
window.latestGraph = null;

function setMeshStatus(name) {
  try {
    const el = document.getElementById('meshName');
    if (el) el.textContent = name || '(ninguna)';
  } catch (e) { /* ignore */ }
}

function clearMesh() {
  osmWaysLayer.clearLayers();
  junctionsLayer.clearLayers();
  window.latestGraph = null;
  setMeshStatus('(ninguna)');
  console.log('Malla limpiada (capas removidas)');
}

// Exponer clearMesh para uso desde consola si es necesario
window.clearMesh = clearMesh;

// Función para parsear y mostrar OSM (a partir de texto XML)
function parseAndDisplayOSM(osmText, name = 'malla') {
  console.log('parseAndDisplayOSM invoked for', name);
  try {
    const parser = new DOMParser();
    const xml = parser.parseFromString(osmText, 'application/xml');

    // Map de nodos: id -> {lat, lon}
    const nodes = new Map();
    xml.querySelectorAll('node').forEach(n => {
      const id = n.getAttribute('id');
      const lat = parseFloat(n.getAttribute('lat'));
      const lon = parseFloat(n.getAttribute('lon'));
      if (id && !Number.isNaN(lat) && !Number.isNaN(lon)) {
        nodes.set(id, { lat, lon });
      }
    });

    // Extraer ways como arrays de refs
    const ways = [];
    xml.querySelectorAll('way').forEach(w => {
      const nds = Array.from(w.querySelectorAll('nd')).map(nd => nd.getAttribute('ref'));
      if (nds.length) ways.push(nds);
    });

    // Limpiar capa anterior y dibujar ways como polilíneas
    osmWaysLayer.clearLayers();
    ways.forEach(nds => {
      const latlngs = nds.map(ref => {
        const p = nodes.get(ref);
        return p ? [p.lat, p.lon] : null;
      }).filter(Boolean);

      if (latlngs.length > 1) {
        L.polyline(latlngs, { color: '#3388ff', weight: 2, opacity: 0.6 }).addTo(osmWaysLayer);
      }
    });

    // Construir grafo de adyacencia a partir de pares consecutivos en cada way
    const adjacency = new Map(); // id -> Set(neighborId)
    ways.forEach(nds => {
      for (let i = 0; i < nds.length - 1; i++) {
        const a = nds[i];
        const b = nds[i + 1];
        if (!a || !b) continue;

        if (!adjacency.has(a)) adjacency.set(a, new Set());
        if (!adjacency.has(b)) adjacency.set(b, new Set());
        adjacency.get(a).add(b);
        adjacency.get(b).add(a);
      }
    });

    // Función para calcular ángulo (en grados) entre los vecinos de un nodo b: a - b - c
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
      const rad = Math.acos(cos);
      return rad * 180 / Math.PI;
    }

    const ANGLE_THRESHOLD_DEG = 160;
    const cornerRefs = [];
    adjacency.forEach((neighbors, id) => {
      const deg = neighbors.size;
      if (deg >= 3) {
        cornerRefs.push(id);
      } else if (deg === 2) {
        const it = Array.from(neighbors);
        const ang = angleDegBetween(it[0], id, it[1]);
        if (ang < ANGLE_THRESHOLD_DEG) cornerRefs.push(id);
      }
    });

    junctionsLayer.clearLayers();
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

    console.log(`${name}: nodos=${nodes.size}, ways=${ways.length}, esquinas=${cornerRefs.length}`);
    setMeshStatus(name);

    // Preparar estructura JSON del grafo para exportar o para uso posterior
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

    // Añadir control para exportar grafo (si no existe ya)
    if (!document.querySelector('.export-graph-control')) {
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
          a.download = `${name}_graph.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        };
        return div;
      };
      exportControl.addTo(map);
    }

    // Guardar grafo en window por si otros scripts lo necesitan
    window.latestGraph = graph;
    console.log('latestGraph actualizado en window.latestGraph');
  } catch (err) {
    console.error('Error parseando OSM:', err);
  }
}

// Listener del input de malla en la página
const meshInput = document.getElementById('meshInput');
if (meshInput) {
  meshInput.addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      // Limpiar antes de cargar nueva malla
      clearMesh();
      parseAndDisplayOSM(text, f.name);
    } catch (err) {
      console.error('Error leyendo archivo de malla:', err);
    }
  });
}

// Listener para el botón Limpiar malla
const clearBtn = document.getElementById('clearMeshBtn');
if (clearBtn) clearBtn.addEventListener('click', () => clearMesh());

// Control de capas (puntos, vías OSM y esquinas)
const overlays = {
  'Puntos (points.tsv)': pointsLayer,
  'Vías OSM (malla)': osmWaysLayer,
  'Esquinas / Intersecciones': junctionsLayer
};

L.control.layers(null, overlays, { collapsed: false }).addTo(map);

