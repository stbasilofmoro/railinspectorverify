/* ============================================================================
   app.js — RailInspectorVerify
   ----------------------------------------------------------------------------
   Pipeline:
     1. Geocode the address   (Nominatim, falling back to Photon)
     2. Find nearby track     (FRA National Rail Network + OpenStreetMap)
     3. Classify              (is this parcel actually rail-served?)
     4. Resolve the operator  (railroads.js decides the inspection policy)

   The distinction that matters: a Class I mainline running past the fence
   line does not make a property rail-served. An industrial lead, spur, or
   siding reaching the parcel does. FRA's NET field encodes exactly that, so
   it carries more weight here than raw proximity to any rail.

   Search radius is user-controlled. Geocoders return a building centroid, and
   a large industrial parcel can put its spur several hundred metres from that
   point — a fixed radius reports real customers as not rail-served. The map
   shows what was found and how far away, so the operator judges rather than
   trusting a hidden threshold.

   No API keys, no backend. Every endpoint below is public and CORS-enabled.
   ========================================================================== */

(function () {
  'use strict';

  /* ---- Search radius ----------------------------------------------------- */
  var RADIUS_DEFAULT = 800;   // metres
  var RADIUS_MIN = 100;
  var RADIUS_MAX = 3000;

  /* Confidence bands, by distance to the nearest industrial track. */
  var BAND_CONFIRMED = 250;
  var BAND_LIKELY = 800;

  var CONTACT = 'basil@tiedisposal.com';
  var WEB3FORMS_KEY = '32318a8e-0759-45ab-bd8d-e7247f79a0c4';

  var FRA_URL = 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/' +
    'services/NTAD_North_American_Rail_Network_Lines/FeatureServer/0/query';
  var OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

  /* FRA NET codes. Only I and O represent industrial track that actually
     serves a facility; M is mainline, A/R/X/T/Z are not usable freight rail. */
  var NET_LABEL = {
    M: 'Mainline', I: 'Major industrial lead', O: 'Industrial lead / spur',
    S: 'Passing siding', Y: 'Yard track', F: 'Rail ferry',
    X: 'Out of service', A: 'Abandoned', R: 'Removed', T: 'Trail',
    Z: 'Transit or museum operation'
  };
  var NET_INDUSTRIAL = ['I', 'O'];
  var NET_DEAD = ['A', 'R', 'X', 'T', 'Z'];

  /* Industrial track is the thing that matters, so it gets the bright stroke. */
  var TRACK_COLOR = {
    industrial: '#22D3EE',
    mainline: '#8B5CF6',
    other: '#55607F'
  };

  /* ---- DOM --------------------------------------------------------------- */
  var $ = function (s) { return document.querySelector(s); };
  var form = $('#lookup');
  var input = $('#address');
  var submitBtn = $('#lookup-btn');
  var out = $('#result');
  var mapWrap = $('#mapwrap');
  var mapEl = $('#map');
  var slider = $('#radius');
  var radiusOut = $('#radius-value');
  var radiusNote = $('#radius-note');
  var raffle = $('#raffle');
  var raffleForm = $('#raffle-form');
  var raffleStatus = $('#raffle-status');

  /* ---- State ------------------------------------------------------------- */
  var state = {
    place: null,
    radius: RADIUS_DEFAULT,
    map: null,
    trackLayer: null,
    circle: null,
    marker: null,
    seq: 0
  };

  /* ---- Geometry ---------------------------------------------------------- */
  /* Local planar approximation. Over a few kilometres the error is negligible
     and it avoids a geodesy dependency for what is a proximity test. */
  function toXY(lat, lon, lat0) {
    return {
      x: lon * (111412.8 * Math.cos(lat0 * Math.PI / 180)),
      y: lat * 111132.9
    };
  }

  function distToSegment(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /* Shortest distance in metres from a point to a polyline of [lon,lat] pairs. */
  function distToPath(lat, lon, coords) {
    if (!coords || !coords.length) return Infinity;
    var p = toXY(lat, lon, lat);
    if (coords.length === 1) {
      var only = toXY(coords[0][1], coords[0][0], lat);
      return Math.hypot(p.x - only.x, p.y - only.y);
    }
    var min = Infinity;
    for (var i = 0; i < coords.length - 1; i++) {
      var d = distToSegment(
        p,
        toXY(coords[i][1], coords[i][0], lat),
        toXY(coords[i + 1][1], coords[i + 1][0], lat)
      );
      if (d < min) min = d;
    }
    return min;
  }

  function minPathDistance(lat, lon, paths) {
    var d = Infinity;
    for (var i = 0; i < paths.length; i++) {
      var dd = distToPath(lat, lon, paths[i]);
      if (dd < d) d = dd;
    }
    return d;
  }

  function bbox(lat, lon, metres) {
    var dLat = metres / 111132.9;
    var dLon = metres / (111412.8 * Math.cos(lat * Math.PI / 180));
    return { xmin: lon - dLon, ymin: lat - dLat, xmax: lon + dLon, ymax: lat + dLat };
  }

  /* ---- Step 1: geocoding ------------------------------------------------- */
  function geocodeNominatim(q) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1' +
      '&addressdetails=1&countrycodes=us&q=' + encodeURIComponent(q);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('Nominatim returned ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.length) return null;
        return {
          lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon),
          label: j[0].display_name, source: 'Nominatim'
        };
      });
  }

  function geocodePhoton(q) {
    var url = 'https://photon.komoot.io/api/?limit=1&lang=en&q=' + encodeURIComponent(q);
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('Photon returned ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.features || !j.features.length) return null;
        var f = j.features[0], p = f.properties || {};
        var parts = [p.name, p.housenumber, p.street, p.city, p.state, p.postcode].filter(Boolean);
        return {
          lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
          label: parts.join(', ') || q, source: 'Photon'
        };
      });
  }

  function geocode(q) {
    return geocodeNominatim(q)
      .catch(function () { return null; })
      .then(function (hit) {
        return hit || geocodePhoton(q).catch(function () { return null; });
      });
  }

  /* ---- Step 2a: FRA National Rail Network -------------------------------- */
  function queryFRA(lat, lon, radius) {
    var b = bbox(lat, lon, radius);
    var params = new URLSearchParams({
      geometry: JSON.stringify({
        xmin: b.xmin, ymin: b.ymin, xmax: b.xmax, ymax: b.ymax,
        spatialReference: { wkid: 4326 }
      }),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'RROWNER1,RROWNER2,RROWNER3,TRKRGHTS1,TRKRGHTS2,SUBDIV,NET',
      returnGeometry: 'true',
      resultRecordCount: '400',
      f: 'json'
    });

    return fetch(FRA_URL + '?' + params.toString())
      .then(function (r) {
        if (!r.ok) throw new Error('FRA returned ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var rows = [];
        ((j && j.features) || []).forEach(function (f) {
          var a = f.attributes || {};
          var paths = (f.geometry && f.geometry.paths) || [];
          var d = minPathDistance(lat, lon, paths);
          if (!isFinite(d) || d > radius) return;

          var net = (a.NET || '').toUpperCase();
          if (NET_DEAD.indexOf(net) !== -1) return;

          rows.push({
            src: 'FRA',
            mark: a.RROWNER1 || '',
            extraMarks: [a.RROWNER2, a.RROWNER3].filter(Boolean),
            rights: [a.TRKRGHTS1, a.TRKRGHTS2].filter(Boolean),
            subdiv: a.SUBDIV || '',
            net: net,
            netLabel: NET_LABEL[net] || 'Track',
            industrial: NET_INDUSTRIAL.indexOf(net) !== -1,
            mainline: net === 'M',
            distance: Math.round(d),
            paths: paths
          });
        });
        return rows;
      })
      .catch(function (e) { console.warn('FRA lookup failed:', e); return []; });
  }

  /* ---- Step 2b: OpenStreetMap via Overpass ------------------------------- */
  function queryOSM(lat, lon, radius) {
    var q = '[out:json][timeout:25];' +
      'way(around:' + radius + ',' + lat + ',' + lon + ')' +
      '["railway"~"^(rail|spur|siding|narrow_gauge)$"];out tags geom;';

    return fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q)
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Overpass returned ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var rows = [];
        ((j && j.elements) || []).forEach(function (el) {
          var t = el.tags || {};
          if (t.railway === 'abandoned' || t.railway === 'disused') return;
          if (t.disused === 'yes' || t.abandoned === 'yes') return;

          var coords = (el.geometry || []).map(function (g) { return [g.lon, g.lat]; });
          var d = distToPath(lat, lon, coords);
          if (!isFinite(d) || d > radius) return;

          var svc = (t.service || '').toLowerCase();
          var usage = (t.usage || '').toLowerCase();

          rows.push({
            src: 'OSM',
            operator: t.operator || '',
            name: t.name || '',
            railway: t.railway || '',
            service: svc,
            usage: usage,
            industrial: t.railway === 'spur' || t.railway === 'siding' ||
              svc === 'spur' || svc === 'siding' || usage === 'industrial',
            mainline: usage === 'main' || usage === 'branch',
            distance: Math.round(d),
            paths: [coords]
          });
        });
        return rows;
      })
      .catch(function (e) { console.warn('Overpass lookup failed:', e); return []; });
  }

  /* ---- Step 3: classification -------------------------------------------- */
  function classify(fra, osm) {
    var all = fra.concat(osm);
    if (!all.length) return { status: 'none', evidence: [], carrier: null, all: [] };

    all.sort(function (a, b) { return a.distance - b.distance; });

    var industrial = all.filter(function (r) { return r.industrial; });
    var nearestInd = industrial.length ? industrial[0] : null;

    var status;
    if (!nearestInd) status = 'near_track_only';
    else if (nearestInd.distance <= BAND_CONFIRMED) status = 'served';
    else if (nearestInd.distance <= BAND_LIKELY) status = 'likely';
    else status = 'possible';

    var basis = nearestInd || all[0];
    var carrier = operatorOf(basis);
    if (!carrier) {
      for (var i = 0; i < all.length; i++) {
        var c = operatorOf(all[i]);
        if (c) { carrier = c; basis = all[i]; break; }
      }
    }

    return {
      status: status, carrier: carrier, basis: basis,
      nearestIndustrial: nearestInd, nearest: all[0],
      evidence: all.slice(0, 10), all: all
    };
  }

  function operatorOf(row) {
    if (!row) return null;
    if (row.src === 'FRA') {
      if (RailPolicy.isPassenger(row.mark, '')) {
        var alt = row.extraMarks.concat(row.rights);
        for (var i = 0; i < alt.length; i++) {
          if (!RailPolicy.isPassenger(alt[i], '')) return RailPolicy.resolve(alt[i], '');
        }
      }
      return row.mark ? RailPolicy.resolve(row.mark, '') : null;
    }
    if (!row.operator) return null;
    if (RailPolicy.isPassenger('', row.operator)) return null;
    return RailPolicy.resolve('', row.operator);
  }

  /* ---- Rendering helpers ------------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---- Map --------------------------------------------------------------- */
  function trackStyle(row) {
    var color = row.industrial ? TRACK_COLOR.industrial
      : row.mainline ? TRACK_COLOR.mainline : TRACK_COLOR.other;
    return {
      color: color,
      weight: row.industrial ? 4 : 2.5,
      opacity: row.industrial ? 0.95 : 0.55,
      dashArray: row.industrial ? null : '5,6'
    };
  }

  function trackLabel(row) {
    if (row.src === 'FRA') {
      return '<b>' + esc(row.mark || 'Unknown owner') + '</b><br>' +
        esc(row.netLabel) + '<br>' + row.distance + ' m away' +
        (row.subdiv ? '<br>' + esc(row.subdiv) + ' Sub' : '');
    }
    return '<b>' + esc(row.operator || 'Untagged track') + '</b><br>' +
      esc(row.service || row.usage || row.railway) + '<br>' + row.distance + ' m away';
  }

  function ensureMap() {
    if (state.map) return state.map;
    state.map = L.map(mapEl, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO &middot; Track: FRA NARN',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(state.map);
    state.trackLayer = L.layerGroup().addTo(state.map);

    /* Clicking moves the search point. A geocoder lands on a building centroid
       or street frontage; on a large parcel that can sit a long way from the
       spur, so dropping the pin on the actual siding matters when you are
       checking a site you already know. */
    state.map.on('click', function (e) {
      state.place = {
        lat: e.latlng.lat, lon: e.latlng.lng,
        label: 'Dropped pin — ' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5),
        source: 'Map pin'
      };
      runSearch(false);
    });
    return state.map;
  }

  function drawMap(place, result, fit) {
    var map = ensureMap();
    state.trackLayer.clearLayers();
    if (state.circle) map.removeLayer(state.circle);
    if (state.marker) map.removeLayer(state.marker);

    state.circle = L.circle([place.lat, place.lon], {
      radius: state.radius,
      color: '#22D3EE', weight: 1, opacity: 0.5,
      fillColor: '#22D3EE', fillOpacity: 0.05
    }).addTo(map);

    state.marker = L.marker([place.lat, place.lon], {
      icon: L.divIcon({ className: 'pin', html: '<span></span>', iconSize: [18, 18] }),
      keyboard: false
    }).addTo(map);

    /* Draw non-industrial first so industrial track sits on top. */
    result.all.slice().sort(function (a, b) {
      return (a.industrial ? 1 : 0) - (b.industrial ? 1 : 0);
    }).forEach(function (row) {
      row.paths.forEach(function (path) {
        if (!path || path.length < 2) return;
        L.polyline(path.map(function (c) { return [c[1], c[0]]; }), trackStyle(row))
          .bindPopup(trackLabel(row))
          .addTo(state.trackLayer);
      });
    });

    if (fit) map.fitBounds(state.circle.getBounds(), { padding: [24, 24] });
    else map.setView([place.lat, place.lon], map.getZoom());

    setTimeout(function () { map.invalidateSize(); }, 60);
  }

  /* ---- Result rendering -------------------------------------------------- */
  function evidenceRows(ev) {
    if (!ev.length) return '';
    var rows = ev.map(function (r) {
      var finding, cls;
      if (r.src === 'FRA') {
        finding = esc(r.mark || 'Unnamed operator') +
          (r.subdiv ? ' &mdash; ' + esc(r.subdiv) + ' Sub' : '');
        cls = r.net ? 'NET=' + r.net : 'TRACK';
      } else {
        finding = esc(r.operator || r.name || 'Untagged track') +
          (r.railway ? ' &mdash; railway=' + esc(r.railway) : '');
        cls = (r.service || r.usage || r.railway || 'rail').toUpperCase();
      }
      return '<tr' + (r.industrial ? ' class="is-ind"' : '') + '><td>' + esc(r.src) +
        '</td><td>' + finding + '</td><td>' + r.distance +
        ' m</td><td><span class="net">' + esc(cls) + '</span></td></tr>';
    }).join('');

    return '<div class="panel"><p class="comp-label">Evidence &middot; why this answer</p>' +
      '<div class="scroll"><table class="ev"><thead><tr>' +
      '<th>Source</th><th>Finding</th><th>Distance</th><th>Class</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="fineprint">Highlighted rows are industrial track — the kind that ' +
      'actually serves a facility. Mainline and yard track are listed for context.</p></div>';
  }

  function carrierBlock(carrier, basis) {
    if (!carrier) return '';
    var sub = [carrier.classification];
    if (basis && basis.subdiv) sub.push(esc(basis.subdiv) + ' SUBDIVISION');
    var flag = carrier.reviewNote ? '<span class="rr-flag">Policy under review</span>' : '';
    var markText = (carrier.marks && carrier.marks.length)
      ? carrier.marks[0] : carrier.short.slice(0, 4).toUpperCase();

    return '<div class="rr"><span class="rr-mark">' + esc(markText) + '</span>' +
      '<div><p class="rr-name">' + esc(carrier.name) + '</p>' +
      '<p class="rr-sub">' + esc(sub.join(' · ')) + '</p></div>' + flag + '</div>' +
      (carrier.reviewNote ? '<p class="fineprint">' + esc(carrier.reviewNote) + '</p>' : '');
  }

  function render(place, result) {
    var aspectKey, aspectWord, headline, detail, extra = '';
    var ni = result.nearestIndustrial;

    if (result.status === 'none') {
      aspectKey = 'dark'; aspectWord = 'DARK';
      headline = 'No track found within ' + state.radius + ' m';
      detail = 'Nothing in either source at this radius. Widen the search with the ' +
        'slider, or click the map to drop the pin directly on the siding.';
    } else if (result.status === 'near_track_only') {
      aspectKey = 'dark'; aspectWord = 'DARK';
      headline = 'Not rail-served';
      detail = 'Track was found nearby, but none of it is an industrial lead, spur, ' +
        'or siding. A mainline passing close by does not make a property rail-served.';
      extra = '<p class="fineprint">Nearest track is ' + result.nearest.distance +
        ' m away. If you know there is a spur here, widen the radius or click the ' +
        'map to move the search point onto it.</p>';
    } else if (!result.carrier) {
      aspectKey = 'approach'; aspectWord = 'APPROACH';
      headline = 'Rail-served, operator unknown';
      detail = 'An industrial lead reaches this area, but neither source records ' +
        'which railroad owns it. Contact the railroad directly.';
    } else {
      var asp = RailPolicy.ASPECTS[result.carrier.policy];
      aspectKey = asp.key; aspectWord = asp.aspect;
      headline = asp.headline; detail = asp.detail;

      if (result.status === 'likely') {
        extra = '<p class="fineprint">Nearest industrial track is ' + ni.distance +
          ' m from the search point — a plausible spur for a large parcel, but ' +
          'worth confirming on the ground.</p>';
      } else if (result.status === 'possible') {
        extra = '<p class="fineprint">Nearest industrial track is ' + ni.distance +
          ' m away — far enough that it may serve a neighbouring property rather ' +
          'than this one. Click the map to drop the pin on the siding and check.</p>';
      }
    }

    var servedWord = result.status === 'served' ? 'Rail-served'
      : result.status === 'likely' ? 'Likely rail-served'
      : result.status === 'possible' ? 'Possibly rail-served'
      : 'Not rail-served';

    out.innerHTML =
      '<article class="verdict-card signal s-' + aspectKey + '">' +
        '<div class="verdict-head"><div class="lamp"></div><div>' +
          '<p class="aspect">' + esc(aspectWord) + '</p>' +
          '<h2 class="verdict-title">' + esc(headline) + '</h2>' +
        '</div></div>' +
        '<p class="verdict-detail">' + detail + '</p>' + extra +
        '<div class="matched"><span class="matched-k">' + esc(servedWord) + '</span>' +
        '<span class="matched-v">' + esc(place.label) + '</span></div>' +
      '</article>' +
      (result.carrier ? '<div class="panel"><p class="comp-label">Serving railroad</p>' +
        carrierBlock(result.carrier, result.basis) + '</div>' : '') +
      evidenceRows(result.evidence) +
      '<p class="fineprint">Located by ' + esc(place.source) + ' &middot; ' +
      place.lat.toFixed(5) + ', ' + place.lon.toFixed(5) + ' &middot; searched ' +
      state.radius + ' m &middot; FRA National Rail Network and OpenStreetMap. ' +
      'This is a screening tool — confirm with the railroad before acting.</p>';

    out.hidden = false;
    raffle.hidden = false;
  }

  function showMessage(title, body) {
    out.innerHTML = '<article class="verdict-card signal s-dark">' +
      '<div class="verdict-head"><div class="lamp"></div><div>' +
      '<p class="aspect">DARK</p><h2 class="verdict-title">' + esc(title) +
      '</h2></div></div><p class="verdict-detail">' + esc(body) + '</p></article>';
    out.hidden = false;
  }

  function setBusy(on) {
    submitBtn.disabled = on;
    submitBtn.textContent = on ? 'Checking…' : 'Check this address';
  }

  function setRadiusNote() {
    radiusNote.textContent = state.radius <= 300
      ? 'Tight — only track almost touching the parcel.'
      : state.radius <= 900 ? 'Typical for an industrial parcel.'
      : state.radius <= 2000 ? 'Wide — may pick up neighbouring facilities.'
      : 'Very wide — expect track that serves other properties.';
  }

  /* ---- Search ------------------------------------------------------------ */
  function runSearch(fit) {
    if (!state.place) return Promise.resolve();
    var place = state.place;
    var token = ++state.seq;

    mapWrap.hidden = false;
    out.hidden = false;
    out.innerHTML = '<div class="loading"><span class="pulse"></span>' +
      'Searching ' + state.radius + ' m around this point…</div>';

    return Promise.all([
      queryFRA(place.lat, place.lon, state.radius),
      queryOSM(place.lat, place.lon, state.radius)
    ]).then(function (res) {
      if (token !== state.seq) return;   // a newer search superseded this one
      var result = classify(res[0], res[1]);
      render(place, result);
      drawMap(place, result, fit);
    }).catch(function (err) {
      if (token !== state.seq) return;
      showMessage('Lookup failed', 'Could not reach the map services: ' +
        err.message + '. Check your connection and try again.');
    });
  }

  /* ---- Events ------------------------------------------------------------ */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q) { input.focus(); return; }

    setBusy(true);
    out.hidden = false;
    out.innerHTML = '<div class="loading"><span class="pulse"></span>Locating address…</div>';

    geocode(q).then(function (place) {
      if (!place) {
        setBusy(false);
        showMessage('Address not found',
          'Neither Nominatim nor Photon could place that address. Try adding the ' +
          'city and state, or use a nearby street number.');
        return;
      }
      state.place = place;
      return runSearch(true).then(function () { setBusy(false); });
    }).catch(function (err) {
      setBusy(false);
      showMessage('Lookup failed', 'Something went wrong: ' + err.message);
    });
  });

  var sliderTimer = null;
  slider.addEventListener('input', function () {
    state.radius = parseInt(slider.value, 10);
    radiusOut.textContent = state.radius >= 1000
      ? (state.radius / 1000).toFixed(1) + ' km' : state.radius + ' m';
    setRadiusNote();
    if (state.circle) state.circle.setRadius(state.radius);
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(function () { runSearch(true); }, 350);
  });

  /* ---- Raffle entry (Web3Forms, browser-side only) ----------------------- */
  raffleForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = raffleForm.querySelector('button[type=submit]');
    var data = new FormData(raffleForm);
    data.append('access_key', WEB3FORMS_KEY);
    data.append('subject', 'Switch 2 raffle entry — RailInspectorVerify');
    data.append('from_name', 'RailInspectorVerify');

    var payload = {};
    data.forEach(function (v, k) { payload[k] = v; });

    btn.disabled = true;
    btn.textContent = 'Sending…';
    raffleStatus.textContent = '';
    raffleStatus.className = 'form-status';

    fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.success) throw new Error(j.message || 'Submission rejected');
        raffleForm.hidden = true;
        raffleStatus.className = 'form-status ok';
        raffleStatus.textContent =
          'You are entered. We will email the winner at the address you gave.';
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Enter the drawing';
        raffleStatus.className = 'form-status err';
        raffleStatus.textContent = 'That did not send: ' + err.message +
          '. You can also email ' + CONTACT + ' directly.';
      });
  });

  /* ---- Init -------------------------------------------------------------- */
  slider.min = RADIUS_MIN;
  slider.max = RADIUS_MAX;
  slider.step = 50;
  slider.value = RADIUS_DEFAULT;
  radiusOut.textContent = RADIUS_DEFAULT + ' m';
  setRadiusNote();
})();
