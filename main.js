// Inicializa el mapa (centrado cerca de tus puntos, por ejemplo Bogotá)
const map = L.map('map').setView([4.65, -74.08], 13);

// Capa base
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Cargar y mostrar los puntos desde points.tsv
// Vamos a poner los marcadores de points.tsv en un layerGroup para controlarlos mejor
const pointsLayer = L.layerGroup().addTo(map);

fetch('points.tsv')
  .then(res => res.text())
  .then(data => {
    const lines = data.trim().split('\n');

    // Saltamos la cabecera (primera línea)
    lines.slice(1).forEach(line => {
      const [x, y, id] = line.split('\t').map(s => s.trim());
      if (!x || !y) return;

      const lon = parseFloat(x);
      const lat = parseFloat(y);

      // Crear marcador y añadir al layerGroup
      const m = L.marker([lat, lon])
        .bindPopup(`<b>Punto ${id}</b><br>(${lat.toFixed(5)}, ${lon.toFixed(5)})`);

      pointsLayer.addLayer(m);
    });

    console.log(`${lines.length - 1} puntos cargados desde points.tsv`);
  })
  .catch(err => console.error('Error al cargar points.tsv:', err));

// Capas para los datos OSM
const osmWaysLayer = L.layerGroup().addTo(map);
const junctionsLayer = L.layerGroup().addTo(map);

// Cargar y parsear el fichero OSM para obtener nodos y ways
fetch('resources/chapinero.osm')
  .then(res => res.text())
  .then(osmText => {
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

    // Dibujar ways como polilíneas
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
      // Clamp numeric errors
      cos = Math.max(-1, Math.min(1, cos));
      const rad = Math.acos(cos);
      return rad * 180 / Math.PI;
    }

    // Umbral de ángulo (grados). Si el nodo tiene grado 2 pero el ángulo entre los dos segmentos
    // es menor que this threshold, lo consideramos una esquina (giro pronunciado).
    const ANGLE_THRESHOLD_DEG = 160; // 160°: debajo de esto marcamos como esquina

    // Determinar esquinas: grado >= 3 OR (grado == 2 y ángulo < ANGLE_THRESHOLD_DEG)
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

    // Preparar estructura JSON del grafo para exportar o para uso posterior
    const graph = {
      nodes: Array.from(nodes.entries()).map(([id, p]) => ({ id, lat: p.lat, lon: p.lon })),
      edges: []
    };
    // Añadir aristas únicas
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

    // Añadir control en el mapa para descargar el grafo como JSON
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
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      };
      return div;
    };
    exportControl.addTo(map);
  })
  .catch(err => console.error('Error al cargar/parsar resources/chapinero.osm:', err));

// Control de capas (puntos, vías OSM y esquinas)
const overlays = {
  'Puntos (points.tsv)': pointsLayer,
  'Vías OSM (chapinero.osm)': osmWaysLayer,
  'Esquinas / Intersecciones': junctionsLayer
};

L.control.layers(null, overlays, { collapsed: false }).addTo(map);

