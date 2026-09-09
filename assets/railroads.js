/* ============================================================================
   railroads.js — Inspection policy reference
   ----------------------------------------------------------------------------
   THIS IS THE FILE TO EDIT WHEN A RAILROAD CHANGES ITS POLICY.

   Everything the app claims about inspection requirements comes from the
   CARRIERS table below. Nothing is hard-coded anywhere else. To move a
   railroad between verdicts, change its `policy` value and redeploy.

   policy values:
     "required"     -> STOP    (red)   independent inspection required
     "not_required" -> CLEAR   (green) railroad accepts its own inspection
     "unclear"      -> APPROACH (amber) confirm directly with the railroad

   `marks` are AAR reporting marks as they appear in the FRA National Rail
   Network dataset (fields RROWNER1-3, TRKRGHTS1-2). Subsidiary and
   predecessor marks are included because FRA track records frequently still
   carry the historical owner.

   `aliases` are lowercase substrings matched against OpenStreetMap
   `operator=*` tags, which use full company names rather than marks.
   ========================================================================== */

(function (global) {
  'use strict';

  var POLICY = {
    REQUIRED: 'required',
    NOT_REQUIRED: 'not_required',
    UNCLEAR: 'unclear'
  };

  /* Presentation for each policy value. Aspect names mirror wayside signals. */
  var ASPECTS = {
    required: {
      aspect: 'STOP',
      key: 'stop',
      headline: 'Independent inspection required',
      detail: 'This railroad requires a third-party inspection before crossties are removed or disposed of.'
    },
    not_required: {
      aspect: 'CLEAR',
      key: 'clear',
      headline: 'No independent inspection',
      detail: 'This railroad accepts its own internal inspection. No third-party inspector is required.'
    },
    unclear: {
      aspect: 'APPROACH',
      key: 'approach',
      headline: 'Confirm with the railroad',
      detail: 'Short lines and regionals set their own tie-disposal policy. Contact the railroad directly before proceeding.'
    },
    none: {
      aspect: 'DARK',
      key: 'dark',
      headline: 'No rail service found',
      detail: 'No industrial lead, spur, or siding was found near this address.'
    }
  };

  var CARRIERS = [
    {
      id: 'csx',
      name: 'CSX Transportation',
      short: 'CSX',
      classification: 'Class I',
      policy: POLICY.REQUIRED,
      marks: ['CSXT', 'CSX', 'BO', 'CO', 'SCL', 'LN', 'SBD', 'CRR', 'WM', 'RFP'],
      aliases: ['csx']
    },
    {
      id: 'up',
      name: 'Union Pacific Railroad',
      short: 'Union Pacific',
      classification: 'Class I',
      policy: POLICY.REQUIRED,
      marks: ['UP', 'UPRR', 'UPY', 'SP', 'SSW', 'DRGW', 'MP', 'CNW', 'MKT', 'WP', 'SPCSL'],
      aliases: ['union pacific']
    },
    {
      id: 'bnsf',
      name: 'BNSF Railway',
      short: 'BNSF',
      classification: 'Class I',
      policy: POLICY.REQUIRED,
      marks: ['BNSF', 'BN', 'ATSF', 'SLSF', 'SPS', 'GN', 'NP', 'CBQ', 'FWD'],
      aliases: ['bnsf', 'burlington northern']
    },
    {
      id: 'cpkc',
      name: 'Canadian Pacific Kansas City',
      short: 'CPKC',
      classification: 'Class I',
      policy: POLICY.REQUIRED,
      marks: ['CPKC', 'CP', 'CPRS', 'KCS', 'KCSM', 'SOO', 'DME', 'ICE', 'MILW', 'TFM'],
      aliases: ['canadian pacific', 'kansas city southern', 'cpkc', 'soo line']
    },
    {
      id: 'ns',
      name: 'Norfolk Southern Railway',
      short: 'Norfolk Southern',
      classification: 'Class I',
      policy: POLICY.NOT_REQUIRED,
      /* Flagged in the UI. Union Pacific and Norfolk Southern have announced a
         merger; if NS adopts UP's policy this becomes POLICY.REQUIRED. Change
         the line above and delete `reviewNote` when that is confirmed. */
      reviewNote: 'Policy under review pending the Union Pacific merger.',
      marks: ['NS', 'NW', 'SOU', 'CG', 'NKP', 'WAB', 'IT', 'AGS', 'CNTP'],
      aliases: ['norfolk southern']
    },
    {
      id: 'cn',
      name: 'Canadian National Railway',
      short: 'CN',
      classification: 'Class I',
      policy: POLICY.NOT_REQUIRED,
      marks: ['CN', 'CNR', 'IC', 'ICG', 'GTW', 'GT', 'WC', 'EJE', 'DWP', 'BLE', 'DMIR', 'CCP'],
      aliases: ['canadian national', 'illinois central', 'grand trunk', 'wisconsin central', 'elgin, joliet']
    }
  ];

  /* Passenger and transit operators. Present on the network but not freight
     carriers, so a tie-disposal inspection question does not apply to them
     directly — the app reports them separately rather than as a verdict. */
  var PASSENGER_MARKS = [
    'AMTK', 'METX', 'NIRC', 'MARC', 'SEPA', 'SEPTA', 'NJTR', 'MBTA', 'CDOT',
    'MNCW', 'LIRR', 'CTRAIL', 'VRE', 'CALTRAIN', 'PCJPB', 'SCAX', 'NCTD',
    'TRE', 'DART', 'RTD', 'UTA', 'SUNRAIL', 'TRIRAIL', 'ACE', 'WES'
  ];
  var PASSENGER_ALIASES = [
    'amtrak', 'metra', 'metrolink', 'septa', 'nj transit', 'new jersey transit',
    'mbta', 'metro-north', 'long island rail', 'caltrain', 'sounder',
    'commuter', 'transit authority', 'sunrail', 'tri-rail', 'via rail'
  ];

  /* Jointly-operated terminal railroads whose parent policy is ambiguous. */
  var JOINT_MARKS = ['CRSA', 'CR', 'CSAO', 'TRRA', 'BRC', 'IHB', 'PTRA', 'KCT'];

  function norm(v) {
    return (v == null ? '' : String(v)).trim();
  }

  /* Match an FRA reporting mark to a carrier. Exact, case-insensitive. */
  function byMark(mark) {
    var m = norm(mark).toUpperCase();
    if (!m) return null;
    for (var i = 0; i < CARRIERS.length; i++) {
      if (CARRIERS[i].marks.indexOf(m) !== -1) return CARRIERS[i];
    }
    return null;
  }

  /* Match an OSM operator string to a carrier. Substring, case-insensitive. */
  function byName(name) {
    var n = norm(name).toLowerCase();
    if (!n) return null;
    for (var i = 0; i < CARRIERS.length; i++) {
      var a = CARRIERS[i].aliases;
      for (var j = 0; j < a.length; j++) {
        if (n.indexOf(a[j]) !== -1) return CARRIERS[i];
      }
    }
    return null;
  }

  function isPassenger(mark, name) {
    var m = norm(mark).toUpperCase();
    if (m && PASSENGER_MARKS.indexOf(m) !== -1) return true;
    var n = norm(name).toLowerCase();
    if (!n) return false;
    for (var i = 0; i < PASSENGER_ALIASES.length; i++) {
      if (n.indexOf(PASSENGER_ALIASES[i]) !== -1) return true;
    }
    return false;
  }

  function isJoint(mark) {
    return JOINT_MARKS.indexOf(norm(mark).toUpperCase()) !== -1;
  }

  /* Resolve any operator token (FRA mark or OSM name) to a carrier record.
     Anything not on the Class I list is treated as a short line, which is a
     real answer — APPROACH — not a failure to identify. */
  function resolve(mark, name) {
    var hit = byMark(mark) || byName(name);
    if (hit) return hit;

    var label = norm(name) || norm(mark);
    if (!label) return null;

    return {
      id: 'shortline:' + label.toLowerCase(),
      name: label,
      short: label,
      classification: isJoint(mark) ? 'Terminal / jointly operated' : 'Short line or regional',
      policy: POLICY.UNCLEAR,
      shortline: true,
      marks: mark ? [norm(mark).toUpperCase()] : [],
      aliases: []
    };
  }

  global.RailPolicy = {
    POLICY: POLICY,
    ASPECTS: ASPECTS,
    CARRIERS: CARRIERS,
    resolve: resolve,
    byMark: byMark,
    byName: byName,
    isPassenger: isPassenger,
    isJoint: isJoint
  };
})(window);
