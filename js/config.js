/**
 * Site + map configuration. Everything state-specific (thresholds, copy
 * hooks, default map view) lives here so the rest of the JS can stay
 * state-agnostic -- reusing this site for another state's USPPD/AirDNA
 * export means: regenerate data/listings.json (scripts/generate_map_data.py)
 * and edit this one file.
 */
const CONFIG = {
  dataUrl: "data/listings.json",
  stateAbbr: "UT",
  stateName: "Utah",

  // Default $ threshold the map opens with. User-adjustable via the slider;
  // this is only the starting point, not a hardcoded rule.
  defaultThreshold: 90000,
  thresholdMin: 30000,
  thresholdMax: 200000,
  thresholdStep: 5000,

  // "Inspect area" radius, km. A ~5mi (~8km) first-pass scale as
  // the default; adjustable up to 20km.
  defaultRadiusKm: 8,
  radiusMinKm: 2,
  radiusMaxKm: 20,
  radiusStepKm: 1,

  // Fixed reference revenue level shown alongside the live threshold in the
  // Inspect area summary, so "$90k+ / $100k+" both stay visible regardless
  // of where the analyst has moved the main threshold slider.
  secondaryReferenceThreshold: 100000,

  // Dual-handle range filters on the map sidebar. Each defaults wide open
  // (the slider's own min/max), so "default is all" -- nothing is excluded
  // until the analyst narrows it. `unboundedAtMax: true` means the slider's
  // visual ceiling is a practical cap, not the data's true max (a handful of
  // outliers -- e.g. a 15-bedroom event lodge -- sit above it); leaving the
  // max handle untouched still includes every one of them, and the top tick
  // reads "N+" rather than silently truncating the population.
  ranges: {
    bedrooms: { min: 0, max: 8, step: 1, unboundedAtMax: true, unit: "bd" },
    accommodates: { min: 1, max: 16, step: 1, unboundedAtMax: true, unit: "sleeps" },
    adr: { min: 0, max: 1000, step: 25, unboundedAtMax: true, unit: "currency" },
    occupancy: { min: 0, max: 100, step: 5, unboundedAtMax: false, unit: "pct" },
  },

  colors: {
    above: "#1fa35c",
    aboveStroke: "#0d5c33",
    aboveHalo: "rgba(31,163,92,0.16)",
    below: "#8b98a6",
    belowStroke: "#6b7684",
    upside: "#d99132",
    upsideStroke: "#8a5a10",
    selection: "#075646",
    regionStroke: "#0f6e93",
    regionFill: "rgba(15,110,147,0.07)",
  },

  propertyTypeOrder: ["House", "Cabin", "Condo", "Apartment", "Townhouse", "Other"],

  locationTypeOrder: ["Destination/Resort", "Large City (Urban)", "Large City (Suburban)", "Mid-Size City", "Small City/Rural"],

  // Esri's hosted basemaps (ArcGIS Online REST tile services) -- work
  // anonymously with no API key at normal traffic levels, unlike CartoDB's
  // anonymous basemaps, which now watermark "API key required" on tiles.
  basemaps: {
    light: {
      label: "Light",
      layers: [
        { url: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", maxZoom: 16 },
        { url: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", maxZoom: 16 },
      ],
      attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
    },
    terrain: {
      label: "Terrain",
      layers: [
        { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", maxZoom: 18 },
      ],
      attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
    },
  },
};
