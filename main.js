// Inicializa el mapa (centrado cerca de tus puntos, por ejemplo Bogotá)
const map = L.map('map').setView([4.65, -74.08], 13);

// Capa base
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Cargar y mostrar los puntos desde points.tsv
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

      // Crear marcador
      L.marker([lat, lon])
        .addTo(map)
        .bindPopup(`<b>Punto ${id}</b><br>(${lat.toFixed(5)}, ${lon.toFixed(5)})`);
    });

    console.log(`${lines.length - 1} puntos cargados desde points.tsv`);
  })
  .catch(err => console.error('Error al cargar puntos.tsv:', err));

