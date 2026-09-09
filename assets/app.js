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

   No API keys, no backend. Every endpoint below is public and CORS-enabled.
   ========================================================================== */

(function () {
  'use strict';

  /* ---- Tunable thresholds ------------------------------------------------ */
  var SERVED_M = 200;    // industrial track this close => rail-served
  var SEARCH_M = 400;    // outer search radius
  var CONTACT = 'basil@tiedisposal.com';
  var WEB3FORMS_KEY = '32318a8e-0759-45ab-bd8d-e7247f79a0c4';

  var FRA_URL = 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/' +
    'services/NTAD_North_American_Rail_Network_Lines/FeatureServer/0/query';
  var OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

  /* FRA NET codes. Only I and O represent industrial track that actually
     serves a facility; M is mainline, and A/R/X/T/Z are not usable freight rail. */
  var NET_LABEL = {
    M: 'Mainline', I: 'Major industrial lead', O: 'Industrial lead / spur',
    S: 'Passing siding', Y: 'Yard track', F: 'Rail ferry',
    X: 'Out of service', A: 'Abandoned', R: 'Removed', T: 'Trail',
    Z: 'Transit or museum operation'
  };
  var NET_INDUSTRIAL = ['I', 'O'];
  var NET_DEAD = ['A', 'R', 'X', 'T', 'Z'];

  /* ---- DOM --------------------------------------------------------------- */
  var $ = function (s) { return document.querySelector(s); };
  var form = $('#lookup');
  var input = $('#address');
  var submitBtn = $('#lookup-btn');
  var out = $('#result');
  var raffle = $('#raffle');
  var raffleForm = $('#raffle-form');
  var raffleStatus = $('#raffle-status');

  /* ---- Geometry ---------------------------------------------------------- */
  /* Local planar approximation. At a 400 m radius the error is negligible and
     it avoids pulling in a geodesy library for what is a proximity test. */
  function toXY(lat, lon, lat0) {
    var mPerDegLat = 111132.9;
    var mPerDegLon = 111412.8 * Math.cos(lat0 * Math.PI / 180);
    return { x: lon * mPerDegLon, y: lat * mPerDegLat };
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
    if (!coords || coords.length === 0) return Infinity;
    var p = toXY(lat, lon, lat);
    if (coords.length === 1) {
      var only = toXY(coords[0][1], coords[0][0], lat);
      return Math.hypot(p.x - only.x, p.y - only.y);
    }
    var min = Infinity;
    for (var i = 0; i < coords.length - 1; i++) {
      var a = toXY(coords[i][1], coords[i][0], lat);
      var b = toXY(coords[i + 1][1], coords[i + 1][0], lat);
      var d = distToSegment(p, a, b);
      if (d < min) min = d;
    }
    return min;
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
          lat: parseFloat(j[0].lat),
          lon: parseFloat(j[0].lon),
          label: j[0].display_name,
          source: 'Nominatim'
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
        var parts = [p.name, p.housenumber, p.street, p.city, p.state, p.postcode]
          .filter(Boolean);
        return {
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          label: parts.join(', ') || q,
          source: 'Photon'
        };
      });
  }

  function geocode(q) {
    return geocodeNominatim(q)
      .catch(function () { return null; })
      .then(function (hit) {
        if (hit) return hit;
        return geocodePhoton(q).catch(function () { return null; });
      });
  }

  /* ---- Step 2a: FRA National Rail Network -------------------------------- */
  function queryFRA(lat, lon) {
    var b = bbox(lat, lon, SEARCH_M);
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
      resultRecordCount: '80',
      f: 'json'
    });

    return fetch(FRA_URL + '?' + params.toString())
      .then(function (r) {
        if (!r.ok) throw new Error('FRA returned ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var feats = (j && j.features) || [];
        var rows = [];
        feats.forEach(function (f) {
          var a = f.attributes || {};
          var paths = (f.geometry && f.geometry.paths) || [];
          var d = Infinity;
          paths.forEach(function (path) {
            var dd = distToPath(lat, lon, path);
            if (dd < d) d = dd;
          });
          if (!isFinite(d) || d > SEARCH_M) return;
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
            yard: net === 'Y',
            distance: Math.round(d)
          });
        });
        return rows;
      })
      .catch(function (e) {
        console.warn('FRA lookup failed:', e);
        return [];
      });
  }

  /* ---- Step 2b: OpenStreetMap via Overpass ------------------------------- */
  function queryOSM(lat, lon) {
    var q = '[out:json][timeout:25];' +
      'way(around:' + SEARCH_M + ',' + lat + ',' + lon + ')' +
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
        var els = (j && j.elements) || [];
        var rows = [];
        els.forEach(function (el) {
          var t = el.tags || {};
          if (t.railway === 'abandoned' || t.railway === 'disused') return;
          if (t.disused === 'yes' || t.abandoned === 'yes') return;

          var coords = (el.geometry || []).map(function (g) { return [g.lon, g.lat]; });
          var d = distToPath(lat, lon, coords);
          if (!isFinite(d) || d > SEARCH_M) return;

          var svc = (t.service || '').toLowerCase();
          var usage = (t.usage || '').toLowerCase();
          var industrial = t.railway === 'spur' || t.railway === 'siding' ||
            svc === 'spur' || svc === 'siding' || usage === 'industrial';

          rows.push({
            src: 'OSM',
            operator: t.operator || '',
            name: t.name || '',
            railway: t.railway || '',
            service: svc,
            usage: usage,
            industrial: industrial,
            yard: svc === 'yard',
            distance: Math.round(d)
          });
        });
        return rows;
      })
      .catch(function (e) {
        console.warn('Overpass lookup failed:', e);
        return [];
      });
  }

  /* ---- Step 3: classification -------------------------------------------- */
  function classify(fra, osm) {
    var all = fra.concat(osm);
    if (!all.length) {
      return { status: 'none', evidence: [], carrier: null, nearest: null };
    }

    all.sort(function (a, b) { return a.distance - b.distance; });

    var industrial = all.filter(function (r) { return r.industrial; });
    var nearestInd = industrial.length ? industrial[0] : null;
    var nearest = all[0];

    var status;
    if (nearestInd && nearestInd.distance <= SERVED_M) status = 'served';
    else if (nearestInd) status = 'likely';
    else status = 'near_track_only';

    /* Prefer the owner of the nearest industrial track — that is the railroad
       that would actually deliver cars. Fall back to the nearest track's
       owner when there is no industrial lead at all. */
    var basis = nearestInd || nearest;
    var carrier = operatorOf(basis);

    /* An industrial spur is often untagged in OSM while FRA records the owner.
       If the basis row has no operator, borrow the nearest FRA row that does. */
    if (!carrier) {
      for (var i = 0; i < all.length; i++) {
        var c = operatorOf(all[i]);
        if (c) { carrier = c; basis = all[i]; break; }
      }
    }

    return {
      status: status,
      carrier: carrier,
      basis: basis,
      nearest: nearest,
      nearestIndustrial: nearestInd,
      evidence: all.slice(0, 8)
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

  /* ---- Rendering --------------------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

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
      return '<tr><td>' + esc(r.src) + '</td><td>' + finding +
        '</td><td>' + r.distance + ' m</td><td><span class="net">' +
        esc(cls) + '</span></td></tr>';
    }).join('');

    return '<div class="panel">' +
      '<p class="comp-label">Evidence &middot; why this answer</p>' +
      '<div class="scroll"><table class="ev"><thead><tr>' +
      '<th>Source</th><th>Finding</th><th>Distance</th><th>Class</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  function carrierBlock(carrier, basis) {
    if (!carrier) return '';
    var sub = [carrier.classification];
    if (basis && basis.subdiv) sub.push(esc(basis.subdiv) + ' SUBDIVISION');
    var flag = carrier.reviewNote
      ? '<span class="rr-flag">Policy under review</span>' : '';
    var markText = carrier.marks && carrier.marks.length
      ? carrier.marks[0] : carrier.short.slice(0, 4).toUpperCase();

    return '<div class="rr">' +
      '<span class="rr-mark">' + esc(markText) + '</span>' +
      '<div><p class="rr-name">' + esc(carrier.name) + '</p>' +
      '<p class="rr-sub">' + esc(sub.join(' · ')) + '</p></div>' +
      flag + '</div>' +
      (carrier.reviewNote
        ? '<p class="fineprint">' + esc(carrier.reviewNote) + '</p>' : '');
  }

  function render(place, result) {
    var aspectKey, headline, detail, extra = '';

    if (result.status === 'none') {
      var a = RailPolicy.ASPECTS.none;
      aspectKey = a.key; headline = a.headline; detail = a.detail;
    } else if (result.status === 'near_track_only') {
      aspectKey = 'dark';
      headline = 'Not rail-served';
      detail = 'Track was found nearby, but no industrial lead, spur, or siding ' +
        'reaches this address. A mainline passing close by does not make a ' +
        'property rail-served.';
    } else if (!result.carrier) {
      aspectKey = 'approach';
      headline = 'Rail-served, operator unknown';
      detail = 'An industrial lead reaches this address, but neither source ' +
        'records which railroad owns it. Contact the railroad directly.';
    } else {
      var asp = RailPolicy.ASPECTS[result.carrier.policy];
      aspectKey = asp.key; headline = asp.headline; detail = asp.detail;
      if (result.status === 'likely') {
        extra = '<p class="fineprint">The nearest industrial track is ' +
          result.nearestIndustrial.distance + ' m away — close, but beyond the ' +
          SERVED_M + ' m mark this tool treats as a confirmed connection. ' +
          'Worth verifying on the ground.</p>';
      }
    }

    var served = result.status === 'served' ? 'Rail-served'
      : result.status === 'likely' ? 'Possibly rail-served'
      : 'Not rail-served';

    out.innerHTML =
      '<article class="verdict-card signal s-' + aspectKey + '">' +
        '<div class="verdict-head">' +
          '<div class="lamp"></div>' +
          '<div>' +
            '<p class="aspect">' + esc(RailPolicy.ASPECTS[
              aspectKey === 'stop' ? 'required'
              : aspectKey === 'clear' ? 'not_required'
              : aspectKey === 'approach' ? 'unclear' : 'none'
            ].aspect) + '</p>' +
            '<h2 class="verdict-title">' + esc(headline) + '</h2>' +
          '</div>' +
        '</div>' +
        '<p class="verdict-detail">' + detail + '</p>' + extra +
        '<div class="matched"><span class="matched-k">' + esc(served) + '</span>' +
        '<span class="matched-v">' + esc(place.label) + '</span></div>' +
      '</article>' +
      (result.carrier ? '<div class="panel">' +
        '<p class="comp-label">Serving railroad</p>' +
        carrierBlock(result.carrier, result.basis) + '</div>' : '') +
      evidenceRows(result.evidence) +
      '<p class="fineprint">Geocoded by ' + esc(place.source) +
      ' &middot; ' + place.lat.toFixed(5) + ', ' + place.lon.toFixed(5) +
      ' &middot; Track data from the FRA National Rail Network and OpenStreetMap. ' +
      'This is a screening tool — confirm with the railroad before acting.</p>';

    out.hidden = false;
    raffle.hidden = false;
  }

  function showMessage(title, body) {
    out.innerHTML = '<article class="verdict-card signal s-dark">' +
      '<div class="verdict-head"><div class="lamp"></div><div>' +
      '<p class="aspect">DARK</p>' +
      '<h2 class="verdict-title">' + esc(title) + '</h2></div></div>' +
      '<p class="verdict-detail">' + esc(body) + '</p></article>';
    out.hidden = false;
  }

  function setBusy(on) {
    submitBtn.disabled = on;
    submitBtn.textContent = on ? 'Checking…' : 'Check this address';
  }

  /* ---- Lookup flow ------------------------------------------------------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q) { input.focus(); return; }

    setBusy(true);
    out.hidden = false;
    out.innerHTML = '<div class="loading"><span class="pulse"></span>' +
      'Locating address and searching the rail network…</div>';

    geocode(q).then(function (place) {
      if (!place) {
        setBusy(false);
        showMessage('Address not found',
          'Neither Nominatim nor Photon could place that address. Try adding ' +
          'the city and state, or use a nearby street number.');
        return;
      }
      return Promise.all([
        queryFRA(place.lat, place.lon),
        queryOSM(place.lat, place.lon)
      ]).then(function (res) {
        setBusy(false);
        render(place, classify(res[0], res[1]));
      });
    }).catch(function (err) {
      setBusy(false);
      showMessage('Lookup failed',
        'Something went wrong reaching the map services: ' + err.message +
        '. Check your connection and try again.');
    });
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
        if (j.success) {
          raffleForm.hidden = true;
          raffleStatus.className = 'form-status ok';
          raffleStatus.textContent =
            'You are entered. We will email the winner at the address you gave.';
        } else {
          throw new Error(j.message || 'Submission rejected');
        }
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Enter the drawing';
        raffleStatus.className = 'form-status err';
        raffleStatus.textContent = 'That did not send: ' + err.message +
          '. You can also email ' + CONTACT + ' directly.';
      });
  });
})();
