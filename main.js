// Inicializa el mapa (centrado cerca de tus puntos, por ejemplo Bogotá)
const map = L.map('map').setView([4.65, -74.08], 13);

// Capa base
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Capas del mapa
const pointsLayer = L.layerGroup().addTo(map);
const osmWaysLayer = L.layerGroup().addTo(map);
const junctionsLayer = L.layerGroup().addTo(map);
const routeLayer1 = L.layerGroup().addTo(map); // Brute Force
const routeLayer2 = L.layerGroup().addTo(map); // Nearest Neighbor
const routeLayer3 = L.layerGroup().addTo(map); // 2-Opt
const integratedPointsLayer = L.layerGroup().addTo(map);

// Variables globales para el grafo OSM
let nodes = new Map();
let adjacency = new Map();
let osmLoaded = false;
let integratedPoints = [];
let nextNodeId = 1000000;

// Cache de distancias entre puntos
let distanceCache = new Map();

//--------------------------------------------------------- 
// FUNCIONES DE UTILIDAD
//---------------------------------------------------------
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function perpendicularDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    
    if (lengthSq === 0) {
        const dist = haversine(px, py, ax, ay);
        return { distance: dist, projection: null };
    }
    
    let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    
    const projLat = ax + t * dx;
    const projLon = ay + t * dy;
    const distance = haversine(px, py, projLat, projLon);
    
    return {
        distance,
        projection: { lat: projLat, lon: projLon },
        t
    };
}

function findClosestEdge(lat, lon) {
    let bestEdge = null;
    let minDist = Infinity;
    let bestProjection = null;
    
    adjacency.forEach((neighbors, nodeAId) => {
        const nodeA = nodes.get(nodeAId);
        if (!nodeA) return;
        
        neighbors.forEach(nodeBId => {
            const nodeB = nodes.get(nodeBId);
            if (!nodeB) return;
            
            const result = perpendicularDistance(
                lat, lon,
                nodeA.lat, nodeA.lon,
                nodeB.lat, nodeB.lon
            );
            
            if (result.distance < minDist && result.projection) {
                minDist = result.distance;
                bestEdge = { nodeAId, nodeBId };
                bestProjection = result.projection;
            }
        });
    });
    
    return { edge: bestEdge, projection: bestProjection, distance: minDist };
}

function integratePointIntoNetwork(lat, lon, pointId) {
    console.log(`🔍 Integrando punto ${pointId} (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
    
    const result = findClosestEdge(lat, lon);
    
    if (!result.edge || !result.projection) {
        console.error(`❌ No se pudo integrar el punto ${pointId}`);
        return null;
    }
    
    const { nodeAId, nodeBId } = result.edge;
    const { lat: projLat, lon: projLon } = result.projection;
    
    const newNodeId = `integrated_${nextNodeId++}`;
    nodes.set(newNodeId, { lat: projLat, lon: projLon });
    
    if (adjacency.has(nodeAId)) {
        adjacency.get(nodeAId).delete(nodeBId);
    }
    if (adjacency.has(nodeBId)) {
        adjacency.get(nodeBId).delete(nodeAId);
    }
    
    if (!adjacency.has(newNodeId)) adjacency.set(newNodeId, new Set());
    adjacency.get(nodeAId).add(newNodeId);
    adjacency.get(newNodeId).add(nodeAId);
    adjacency.get(nodeBId).add(newNodeId);
    adjacency.get(newNodeId).add(nodeBId);
    
    const marker = L.marker([projLat, projLon], {
        icon: L.icon({
            iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowSize: [41, 41]
        })
    }).bindPopup(`<b>Punto ${pointId}</b><br>Integrado en red<br>(${projLat.toFixed(5)}, ${projLon.toFixed(5)})<br>Distancia: ${result.distance.toFixed(2)}m`);
    
    integratedPointsLayer.addLayer(marker);
    
    console.log(`✅ Punto ${pointId} integrado como ${newNodeId}`);
    
    return { nodeId: newNodeId, lat: projLat, lon: projLon, originalId: pointId };
}

function dijkstra(startId, endId) {
    const dist = {};
    const prev = {};
    const pq = new Map();
    
    nodes.forEach((_, id) => dist[id] = Infinity);
    dist[startId] = 0;
    pq.set(startId, 0);
    
    while (pq.size > 0) {
        let current = null;
        let bestDist = Infinity;
        pq.forEach((d, id) => {
            if (d < bestDist) {
                bestDist = d;
                current = id;
            }
        });
        pq.delete(current);
        
        if (current === endId) break;
        
        const neighbors = adjacency.get(current);
        if (!neighbors) continue;
        
        neighbors.forEach(nid => {
            const p1 = nodes.get(current);
            const p2 = nodes.get(nid);
            const w = haversine(p1.lat, p1.lon, p2.lat, p2.lon);
            const alt = dist[current] + w;
            if (alt < dist[nid]) {
                dist[nid] = alt;
                prev[nid] = current;
                pq.set(nid, alt);
            }
        });
    }
    
    const path = [];
    let u = endId;
    if (!prev[u] && u !== startId) {
        return { path: [], dist: Infinity };
    }
    while (u !== undefined) {
        path.unshift(u);
        u = prev[u];
    }
    return { path, dist: dist[endId] };
}

// Calcula distancia entre dos puntos (con cache)
function getDistance(idxA, idxB, points) {
    const key = `${Math.min(idxA, idxB)}-${Math.max(idxA, idxB)}`;
    if (distanceCache.has(key)) {
        return distanceCache.get(key);
    }
    
    const a = points[idxA].nodeId;
    const b = points[idxB].nodeId;
    const result = dijkstra(a, b);
    distanceCache.set(key, result.dist);
    return result.dist;
}

function permutations(arr) {
    if (arr.length <= 1) return [arr];
    const result = [];
    arr.forEach((v, i) => {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        permutations(rest).forEach(p => result.push([v, ...p]));
    });
    return result;
}

//---------------------------------------------------------
// ALGORITMO 1: FUERZA BRUTA
//---------------------------------------------------------
function bruteForceTSP(points) {
    const n = points.length;
    const idx = [...Array(n).keys()];
    const perms = permutations(idx);
    
    let best = null;
    let bestDist = Infinity;
    
    for (const perm of perms) {
        let valid = true;
        let total = 0;
        
        for (let i = 0; i < perm.length - 1; i++) {
            const dist = getDistance(perm[i], perm[i + 1], points);
            if (dist === Infinity) {
                valid = false;
                break;
            }
            total += dist;
        }
        
        if (valid && total < bestDist) {
            bestDist = total;
            best = perm;
        }
    }
    
    return { tour: best, distance: bestDist };
}

//---------------------------------------------------------
// ALGORITMO 2: NEAREST NEIGHBOR (VECINO MÁS CERCANO)
//---------------------------------------------------------
function nearestNeighborTSP(points) {
    const n = points.length;
    const visited = new Set();
    const tour = [];
    
    // Empezar desde el primer punto
    let current = 0;
    tour.push(current);
    visited.add(current);
    let totalDist = 0;
    
    while (visited.size < n) {
        let nearest = -1;
        let minDist = Infinity;
        
        // Encontrar el vecino más cercano no visitado
        for (let i = 0; i < n; i++) {
            if (!visited.has(i)) {
                const dist = getDistance(current, i, points);
                if (dist < minDist) {
                    minDist = dist;
                    nearest = i;
                }
            }
        }
        
        if (nearest === -1) break;
        
        tour.push(nearest);
        visited.add(nearest);
        totalDist += minDist;
        current = nearest;
    }
    
    return { tour, distance: totalDist };
}

//---------------------------------------------------------
// ALGORITMO 3: 2-OPT (MEJORA LOCAL)
//---------------------------------------------------------
function twoOptTSP(points) {
    const n = points.length;
    
    // Empezar con tour del vecino más cercano
    let tour = nearestNeighborTSP(points).tour;
    let improved = true;
    
    function calculateTourDistance(t) {
        let total = 0;
        for (let i = 0; i < t.length - 1; i++) {
            total += getDistance(t[i], t[i + 1], points);
        }
        return total;
    }
    
    let bestDist = calculateTourDistance(tour);
    
    // Aplicar 2-opt
    while (improved) {
        improved = false;
        
        for (let i = 0; i < n - 1; i++) {
            for (let j = i + 2; j < n; j++) {
                // Evitar edges adyacentes
                if (j === i + 1) continue;
                
                // Calcular cambio en distancia
                const current = getDistance(tour[i], tour[i + 1], points) + 
                               getDistance(tour[j], tour[(j + 1) % n], points);
                const swapped = getDistance(tour[i], tour[j], points) + 
                               getDistance(tour[i + 1], tour[(j + 1) % n], points);
                
                if (swapped < current) {
                    // Realizar 2-opt swap
                    const newTour = [...tour.slice(0, i + 1)];
                    for (let k = j; k > i; k--) {
                        newTour.push(tour[k]);
                    }
                    newTour.push(...tour.slice(j + 1));
                    
                    tour = newTour;
                    bestDist = calculateTourDistance(tour);
                    improved = true;
                    break;
                }
            }
            if (improved) break;
        }
    }
    
    return { tour, distance: bestDist };
}

//---------------------------------------------------------
// DIBUJAR RUTA
//---------------------------------------------------------
function drawRoute(tour, points, layer, color, algorithmName) {
    layer.clearLayers();
    
    for (let i = 0; i < tour.length - 1; i++) {
        const a = points[tour[i]].nodeId;
        const b = points[tour[i + 1]].nodeId;
        const r = dijkstra(a, b);
        
        if (r.path.length > 0) {
            const coords = r.path.map(id => {
                const p = nodes.get(id);
                return [p.lat, p.lon];
            });
            L.polyline(coords, { 
                color: color, 
                weight: 4, 
                opacity: 0.7 
            }).bindPopup(`${algorithmName}`).addTo(layer);
        }
    }
    
    // Numerar puntos
    tour.forEach((idx, order) => {
        const pt = points[idx];
        L.marker([pt.lat, pt.lon], {
            icon: L.divIcon({
                className: 'number-icon',
                html: `<div style="background:${color};color:white;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:11px;border:2px solid white;">${order + 1}</div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            })
        }).addTo(layer);
    });
}

//---------------------------------------------------------
// EJECUTAR TODOS LOS ALGORITMOS
//---------------------------------------------------------
async function runAllAlgorithms() {
    if (!osmLoaded) {
        alert("⚠️ Espera a que se cargue el mapa OSM");
        return;
    }
    
    const N = parseInt(document.getElementById('numPoints').value);
    
    if (integratedPoints.length < N) {
        alert(`⚠️ Solo hay ${integratedPoints.length} puntos. Necesitas al menos ${N}.`);
        return;
    }
    
    if (N < 2) {
        alert("⚠️ Necesitas al menos 2 puntos");
        return;
    }
    
    // Limpiar capas y cache
    routeLayer1.clearLayers();
    routeLayer2.clearLayers();
    routeLayer3.clearLayers();
    distanceCache.clear();
    
    const selected = integratedPoints.slice(0, N);
    
    // Pre-calcular todas las distancias
    console.log("📊 Pre-calculando matriz de distancias...");
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            getDistance(i, j, selected);
        }
    }
    
    const results = [];
    
    // 1. Brute Force
    console.log("🔎 Ejecutando Brute Force...");
    const t1Start = performance.now();
    const bf = bruteForceTSP(selected);
    const t1End = performance.now();
    const time1 = (t1End - t1Start).toFixed(2);
    
    if (bf.tour) {
        drawRoute(bf.tour, selected, routeLayer1, '#FF0000', 'Brute Force');
        results.push({
            name: 'Brute Force',
            time: time1,
            distance: (bf.distance / 1000).toFixed(3)
        });
        console.log(`✅ Brute Force: ${time1}ms, ${(bf.distance/1000).toFixed(2)} km`);
    }
    
    // 2. Nearest Neighbor
    console.log("🎯 Ejecutando Nearest Neighbor...");
    const t2Start = performance.now();
    const nn = nearestNeighborTSP(selected);
    const t2End = performance.now();
    const time2 = (t2End - t2Start).toFixed(2);
    
    if (nn.tour) {
        drawRoute(nn.tour, selected, routeLayer2, '#00AA00', 'Nearest Neighbor');
        results.push({
            name: 'Nearest Neighbor',
            time: time2,
            distance: (nn.distance / 1000).toFixed(3)
        });
        console.log(`✅ Nearest Neighbor: ${time2}ms, ${(nn.distance/1000).toFixed(2)} km`);
    }
    
    // 3. 2-Opt
    console.log("🔄 Ejecutando 2-Opt...");
    const t3Start = performance.now();
    const twoOpt = twoOptTSP(selected);
    const t3End = performance.now();
    const time3 = (t3End - t3Start).toFixed(2);
    
    if (twoOpt.tour) {
        drawRoute(twoOpt.tour, selected, routeLayer3, '#0000FF', '2-Opt');
        results.push({
            name: '2-Opt',
            time: time3,
            distance: (twoOpt.distance / 1000).toFixed(3)
        });
        console.log(`✅ 2-Opt: ${time3}ms, ${(twoOpt.distance/1000).toFixed(2)} km`);
    }
    
    // Mostrar resultados en UI
    displayResults(results);
}

function displayResults(results) {
    const container = document.getElementById('resultsContainer');
    container.innerHTML = '<h3 style="margin:0 0 10px 0;">📊 Resultados</h3>';
    
    results.forEach(r => {
        const div = document.createElement('div');
        div.style.marginBottom = '8px';
        div.style.padding = '8px';
        div.style.background = '#f0f0f0';
        div.style.borderRadius = '4px';
        div.innerHTML = `
            <strong>${r.name}</strong><br>
            ⏱️ Tiempo: ${r.time} ms<br>
            📏 Distancia: ${r.distance} km
        `;
        container.appendChild(div);
    });
}

//---------------------------------------------------------
// EXPORTAR RESULTADOS
//---------------------------------------------------------
function exportResults() {
    const routes = [
        { name: 'Brute Force', layer: routeLayer1, color: '#FF0000' },
        { name: 'Nearest Neighbor', layer: routeLayer2, color: '#00AA00' },
        { name: '2-Opt', layer: routeLayer3, color: '#0000FF' }
    ];
    
    const geojson = {
        type: "FeatureCollection",
        features: []
    };
    
    routes.forEach(route => {
        route.layer.eachLayer(layer => {
            if (layer instanceof L.Polyline && !(layer instanceof L.Marker)) {
                const coords = layer.getLatLngs().map(ll => [ll.lng, ll.lat]);
                geojson.features.push({
                    type: "Feature",
                    properties: {
                        algorithm: route.name,
                        color: route.color
                    },
                    geometry: {
                        type: "LineString",
                        coordinates: coords
                    }
                });
            }
        });
    });
    
    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tsp_routes.geojson';
    a.click();
    URL.revokeObjectURL(url);
    
    console.log("✅ Resultados exportados como GeoJSON");
}

//---------------------------------------------------------
// CARGAR PUNTOS
//---------------------------------------------------------
document.getElementById('fileInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!osmLoaded) {
        alert("⚠️ Espera a que se cargue el mapa OSM primero");
        return;
    }
    
    pointsLayer.clearLayers();
    integratedPointsLayer.clearLayers();
    integratedPoints = [];
    
    const text = await file.text();
    const lines = text.trim().split('\n');
    
    console.log(`📂 Cargando ${lines.length - 1} puntos...`);
    
    for (const line of lines.slice(1)) {
        const [x, y, id] = line.split('\t').map(s => s.trim());
        if (!x || !y) continue;
        
        const lon = parseFloat(x);
        const lat = parseFloat(y);
        
        const originalMarker = L.marker([lat, lon], {
            icon: L.icon({
                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            })
        }).bindPopup(`<b>Punto ${id}</b><br>Original<br>(${lat.toFixed(5)}, ${lon.toFixed(5)})`);
        pointsLayer.addLayer(originalMarker);
        
        const integrated = integratePointIntoNetwork(lat, lon, id);
        if (integrated) {
            integratedPoints.push(integrated);
        }
        
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    const allMarkers = [...pointsLayer.getLayers(), ...integratedPointsLayer.getLayers()].map(m => m.getLatLng());
    if (allMarkers.length) {
        const bounds = L.latLngBounds(allMarkers);
        map.fitBounds(bounds.pad(0.2));
    }
    
    console.log(`✅ ${integratedPoints.length} puntos cargados`);
});

//---------------------------------------------------------
// CARGAR OSM
//---------------------------------------------------------
fetch('resources/chapinero.osm')
    .then(res => res.text())
    .then(osmText => {
        const parser = new DOMParser();
        const xml = parser.parseFromString(osmText, 'application/xml');
        
        nodes = new Map();
        adjacency = new Map();
        
        xml.querySelectorAll('node').forEach(n => {
            const id = n.getAttribute('id');
            const lat = parseFloat(n.getAttribute('lat'));
            const lon = parseFloat(n.getAttribute('lon'));
            if (id && !Number.isNaN(lat) && !Number.isNaN(lon)) {
                nodes.set(id, { lat, lon });
            }
        });
        
        const ways = [];
        xml.querySelectorAll('way').forEach(w => {
            const nds = Array.from(w.querySelectorAll('nd')).map(nd => nd.getAttribute('ref'));
            if (nds.length) ways.push(nds);
        });
        
        ways.forEach(nds => {
            const latlngs = nds.map(ref => {
                const p = nodes.get(ref);
                return p ? [p.lat, p.lon] : null;
            }).filter(Boolean);
            if (latlngs.length > 1) {
                L.polyline(latlngs, { color: '#3388ff', weight: 2, opacity: 0.6 }).addTo(osmWaysLayer);
            }
        });
        
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
        
        osmLoaded = true;
        console.log(`✅ OSM cargado: ${nodes.size} nodos, ${ways.length} vías`);
    })
    .catch(err => console.error('❌ Error:', err));

// Event listeners - esperar a que el DOM cargue
window.addEventListener('DOMContentLoaded', () => {
    const runBtn = document.getElementById('runAlgorithms');
    const exportBtn = document.getElementById('exportBtn');
    
    if (runBtn) runBtn.addEventListener('click', runAllAlgorithms);
    if (exportBtn) exportBtn.addEventListener('click', exportResults);
});

