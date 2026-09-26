import React, {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  MapContainer,
  TileLayer,
  Rectangle,
  Polygon,
  Polyline,
  Popup,
  Marker,
  useMap,
  useMapEvents,
} from "react-leaflet";

import "leaflet/dist/leaflet.css";

const DEFAULT_CENTER = [
  16.633,
  81.63,
];

const DEFAULT_ZOOM = 13;

const OSM_URL =
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

const SATELLITE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/" +
  "World_Imagery/MapServer/tile/{z}/{y}/{x}";

const LABEL_URL =
  "https://{s}.basemaps.cartocdn.com/light_only_labels/" +
  "{z}/{x}/{y}{r}.png";

const TRANSPORT_URL =
  "https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png";

const OVERPASS_ENDPOINTS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const MAX_BUILDINGS = 500;
const MAX_ROADS = 250;
const MAX_WATER = 150;


function LocationController({
  location,
}) {
  const map = useMap();

  useEffect(() => {
    if (!location) return;
    map.flyTo(
      [location.lat, location.lon],
      Math.max(map.getZoom(), location.zoom || 15),
      { duration: 1.2 }
    );
  }, [location, map]);

  return null;
}

function AreaSelector({
  selecting,
  onSelected,
}) {
  const [
    start,
    setStart,
  ] = useState(null);

  const [
    current,
    setCurrent,
  ] = useState(null);

  const startRef = useRef(null);
  const map =
    useMap();

  useMapEvents({
    mousedown(event) {
      if (!selecting) return;

      setStart(
        event.latlng
      );

      setCurrent(
        event.latlng
      );

      map.dragging.disable();
    },

    mousemove(event) {
      if (
        !selecting ||
        !start
      ) {
        return;
      }

      setCurrent(
        event.latlng
      );
    },

    mouseup(event) {
      if (
        !selecting ||
        !start
      ) {
        return;
      }

      const bounds = {
        north: Math.max(
          start.lat,
          event.latlng.lat
        ),

        south: Math.min(
          start.lat,
          event.latlng.lat
        ),

        east: Math.max(
          start.lng,
          event.latlng.lng
        ),

        west: Math.min(
          start.lng,
          event.latlng.lng
        ),
      };

      map.dragging.enable();

      setStart(null);
      setCurrent(null);

      if (
        Math.abs(
          bounds.north -
            bounds.south
        ) < 0.001 ||
        Math.abs(
          bounds.east -
            bounds.west
        ) < 0.001
      ) {
        return;
      }

      onSelected(
        bounds
      );
    },
  });

  useEffect(() => {
    if (!selecting) {
      startRef.current = null;
      setStart(null);
      setCurrent(null);
      map.dragging.enable();
      return;
    }

    // Mobile browsers can let Leaflet's touch-pan handler consume the
    // gesture before React/Leaflet touch events reach AreaSelector.
    // Use native capture listeners on the actual map container so the
    // selection gesture wins before Leaflet starts panning.
    map.dragging.disable();

    const container = map.getContainer();

    const getLatLng = (touch) => {
      const rect = container.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      return map.containerPointToLatLng([x, y]);
    };

    const handleTouchStart = (event) => {
      if (!event.touches || event.touches.length !== 1) return;

      event.preventDefault();
      event.stopPropagation();

      const latlng = getLatLng(event.touches[0]);
      startRef.current = latlng;
      setStart(latlng);
      setCurrent(latlng);
    };

    const handleTouchMove = (event) => {
      if (!startRef.current || !event.touches || event.touches.length !== 1) return;

      event.preventDefault();
      event.stopPropagation();

      const latlng = getLatLng(event.touches[0]);
      setCurrent(latlng);
    };

    const handleTouchEnd = (event) => {
      if (!startRef.current) return;

      event.preventDefault();
      event.stopPropagation();

      const touch = event.changedTouches?.[0];
      if (!touch) return;

      const end = getLatLng(touch);
      const begin = startRef.current;

      const bounds = {
        north: Math.max(begin.lat, end.lat),
        south: Math.min(begin.lat, end.lat),
        east: Math.max(begin.lng, end.lng),
        west: Math.min(begin.lng, end.lng),
      };

      startRef.current = null;
      setStart(null);
      setCurrent(null);

      if (
        Math.abs(bounds.north - bounds.south) < 0.001 ||
        Math.abs(bounds.east - bounds.west) < 0.001
      ) {
        return;
      }

      onSelected(bounds);
    };

    // capture=true is intentional: it prevents Leaflet's map drag handler
    // from taking the same finger gesture.
    container.addEventListener("touchstart", handleTouchStart, {
      passive: false,
      capture: true,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      passive: false,
      capture: true,
    });
    container.addEventListener("touchend", handleTouchEnd, {
      passive: false,
      capture: true,
    });

    return () => {
      container.removeEventListener("touchstart", handleTouchStart, true);
      container.removeEventListener("touchmove", handleTouchMove, true);
      container.removeEventListener("touchend", handleTouchEnd, true);
      map.dragging.enable();
    };
  }, [selecting, map, onSelected]);

  if (
    !start ||
    !current
  ) {
    return null;
  }

  const bounds = [
    [
      Math.min(
        start.lat,
        current.lat
      ),
      Math.min(
        start.lng,
        current.lng
      ),
    ],
    [
      Math.max(
        start.lat,
        current.lat
      ),
      Math.max(
        start.lng,
        current.lng
      ),
    ],
  ];

  return (
    <Rectangle
      bounds={bounds}
      pathOptions={{
        color: "#20d8f5",
        weight: 2,
        fillOpacity: 0.08,
        dashArray: "6 5",
      }}
    />
  );
}

/* =========================================================
   OVERPASS
========================================================= */

async function runOverpassQuery(query, endpoint, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        Accept: "application/json",
      },
      body: query,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Overpass error ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function queryFastestEndpoint(query) {
  const attempts = OVERPASS_ENDPOINTS.slice(0, 2).map((endpoint) =>
    runOverpassQuery(query, endpoint, 10000)
      .then((json) => ({ json, endpoint }))
  );

  try {
    return await Promise.any(attempts);
  } catch (error) {
    throw new Error("Map feature services are temporarily busy.");
  }
}

function cleanFeatureElements(elements = []) {
  return elements.filter((item) => {
    const geometry = item?.geometry;
    return Array.isArray(geometry) && geometry.length >= 2;
  });
}

async function loadOSMFeatures(bounds) {
  const { south, west, north, east } = bounds;

  /*
    Keep the request intentionally small and fast:
    - ways only (relations can make Overpass responses very large)
    - one combined request
    - first two public endpoints raced in parallel
    - 10 second client timeout
  */
  const query = `
    [out:json][timeout:9];
    (
      way["building"](${south},${west},${north},${east});
      way["highway"](${south},${west},${north},${east});
      way["natural"="water"](${south},${west},${north},${east});
      way["waterway"](${south},${west},${north},${east});
    );
    out tags geom;
  `;

  const { json } = await queryFastestEndpoint(query);
  const elements = Array.isArray(json?.elements) ? json.elements : [];

  return {
    buildings: cleanFeatureElements(
      elements.filter((item) => item.tags?.building)
    ).slice(0, MAX_BUILDINGS),
    roads: cleanFeatureElements(
      elements.filter((item) => item.tags?.highway)
    ).slice(0, MAX_ROADS),
    water: cleanFeatureElements(
      elements.filter(
        (item) => item.tags?.natural === "water" || item.tags?.waterway
      )
    ).slice(0, MAX_WATER),
    partial: false,
  };
}

/* =========================================================
   FEATURE LAYERS
========================================================= */

function FeatureLayers({
  buildings,
  roads,
  water,
}) {
  return (
    <>
      {water.map(
        (feature, index) => {
          const points =
            feature.geometry?.map(
              (point) => [
                point.lat,
                point.lon,
              ]
            );

          if (
            !points ||
            points.length <
              3
          ) {
            return null;
          }

          return (
            <Polygon
              key={`water-${index}`}
              positions={
                points
              }
              pathOptions={{
                color: "#1686b2",
                fillColor:
                  "#1686b2",
                fillOpacity: 0.35,
                weight: 1,
              }}
            />
          );
        }
      )}

      {buildings.map(
        (feature, index) => {
          const points =
            feature.geometry?.map(
              (point) => [
                point.lat,
                point.lon,
              ]
            );

          if (
            !points ||
            points.length <
              3
          ) {
            return null;
          }

          return (
            <Polygon
              key={`building-${index}`}
              positions={
                points
              }
              pathOptions={{
                color: "#d8a45b",
                fillColor:
                  "#d8a45b",
                fillOpacity: 0.18,
                weight: 1,
              }}
            >
              <Popup>
                <strong>
                  Building
                </strong>
                <br />
                {feature.tags
                  ?.name ||
                  "Unnamed building"}
              </Popup>
            </Polygon>
          );
        }
      )}

      {roads.map(
        (feature, index) => {
          const points =
            feature.geometry?.map(
              (point) => [
                point.lat,
                point.lon,
              ]
            );

          if (
            !points ||
            points.length <
              2
          ) {
            return null;
          }

          return (
            <Polyline
              key={`road-${index}`}
              positions={
                points
              }
              pathOptions={{
                color: "#eeeeee",
                weight: 2,
                opacity: 0.65,
              }}
            />
          );
        }
      )}
    </>
  );
}

/* =========================================================
   MAIN MAP
========================================================= */

export default function MapView({
  onAreaSelected,
}) {
  const [
    mapStyle,
    setMapStyle,
  ] = useState(
    "satellite"
  );

  const [
    selecting,
    setSelecting,
  ] = useState(false);

  const [
    selectedBounds,
    setSelectedBounds,
  ] = useState(null);

  const [
    features,
    setFeatures,
  ] = useState({
    buildings: [],
    roads: [],
    water: [],
  });

  const [
    loading,
    setLoading,
  ] = useState(false);

  const [
    error,
    setError,
  ] = useState("");

  const [
    partial,
    setPartial,
  ] = useState(false);

  const [
    searchText,
    setSearchText,
  ] = useState("");

  const [
    searchResults,
    setSearchResults,
  ] = useState([]);

  const [
    searching,
    setSearching,
  ] = useState(false);

  const [
    searchError,
    setSearchError,
  ] = useState("");

  const [
    location,
    setLocation,
  ] = useState(null);

  const requestId =
    useRef(0);

  const searchLocation = async () => {
    const query = searchText.trim();
    if (!query) return;

    setSearching(true);
    setSearchError("");
    setSearchResults([]);

    try {
      const params = new URLSearchParams({
        format: "jsonv2",
        q: query,
        limit: "5",
        countrycodes: "in",
        addressdetails: "1",
      });

      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?${params.toString()}`,
        { headers: { Accept: "application/json" } }
      );

      if (!response.ok) {
        throw new Error("Location search failed.");
      }

      const results = await response.json();

      if (!results.length) {
        setSearchError("Location not found. Try village, district, state or full name.");
        return;
      }

      setSearchResults(results);
      const first = results[0];
      setLocation({
        lat: Number(first.lat),
        lon: Number(first.lon),
        zoom: Number(first.type === "village" || first.type === "town" ? 15 : 12),
        label: first.display_name,
      });
    } catch (err) {
      console.error(err);
      setSearchError("Location search unavailable. Check internet connection.");
    } finally {
      setSearching(false);
    }
  };

  const chooseSearchResult = (result) => {
    const next = {
      lat: Number(result.lat),
      lon: Number(result.lon),
      zoom: Number(result.type === "village" || result.type === "town" ? 15 : 12),
      label: result.display_name,
    };
    setLocation(next);
    setSearchResults([]);
  };

  const handleAreaSelected =
    async (bounds) => {
      setSelectedBounds(bounds);
      setSelecting(false);
      setLoading(true);
      setError("");
      setPartial(false);

      const currentRequest = ++requestId.current;

      // Do not make terrain/elevation wait for OSM feature loading.
      // The selected area is accepted immediately; map features arrive in the background.
      setFeatures({ buildings: [], roads: [], water: [] });
      onAreaSelected?.({
        bounds,
        buildings: [],
        roads: [],
        water: [],
      });

      try {
        const data = await loadOSMFeatures(bounds);

        if (currentRequest !== requestId.current) return;

        setFeatures(data);
        setPartial(Boolean(data.partial));

        // Refresh the parent with the real feature data without restarting terrain.
        onAreaSelected?.({
          bounds,
          buildings: data.buildings,
          roads: data.roads,
          water: data.water,
        });
      } catch (err) {
        if (currentRequest !== requestId.current) return;
        console.warn("Background map feature load failed:", err);
        setError("Map features are temporarily unavailable; terrain can continue loading.");
      } finally {
        if (currentRequest === requestId.current) setLoading(false);
      }
    };

  return (
    <div
      style={{
        width: "100%",
        height: "108%",
        minHeight: "108%",
        position:
          "relative",
      }}
    >
      {/* LOCATION SEARCH */}
      <div
        style={{
          position: "absolute",
          top: 58,
          left: 12,
          zIndex: 2000,
          width: 320,
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") searchLocation();
            }}
            placeholder="Search India / AP / district / village..."
            style={{
              flex: 1,
              height: 38,
              padding: "0 10px",
              border: "1px solid #244a53",
              borderRadius: 5,
              outline: "none",
              background: "rgba(3,17,22,.95)",
              color: "#d8f7fb",
              fontSize: 11,
            }}
          />
          <button
            type="button"
            onClick={searchLocation}
            disabled={searching}
            style={{
              width: 72,
              border: "1px solid #20d8f5",
              borderRadius: 5,
              background: "rgba(3,17,22,.95)",
              color: "#20d8f5",
              fontSize: 10,
              fontWeight: 900,
            }}
          >
            {searching ? "..." : "SEARCH"}
          </button>
        </div>

        {searchResults.length > 0 && (
          <div
            style={{
              marginTop: 5,
              maxHeight: 190,
              overflowY: "auto",
              background: "rgba(3,17,22,.97)",
              border: "1px solid #244a53",
              borderRadius: 5,
            }}
          >
            {searchResults.map((result, index) => (
              <button
                key={`${result.place_id}-${index}`}
                type="button"
                onClick={() => chooseSearchResult(result)}
                style={{
                  width: "100%",
                  padding: "9px 10px",
                  textAlign: "left",
                  border: 0,
                  borderBottom: index === searchResults.length - 1 ? 0 : "1px solid #17363d",
                  background: "transparent",
                  color: "#bde8ee",
                  fontSize: 10,
                  lineHeight: 1.35,
                }}
              >
                {result.display_name}
              </button>
            ))}
          </div>
        )}

        {searchError && (
          <div
            style={{
              marginTop: 5,
              padding: "8px 10px",
              background: "rgba(3,17,22,.95)",
              border: "1px solid #6f3333",
              color: "#ff9999",
              borderRadius: 5,
              fontSize: 9,
            }}
          >
            {searchError}
          </div>
        )}
      </div>

      <MapContainer
        center={
          DEFAULT_CENTER
        }
        zoom={
          DEFAULT_ZOOM
        }
        zoomControl
        style={{
          width: "100%",
          height: "100%",
        }}
      >
        {mapStyle ===
          "satellite" && (
          <TileLayer
            url={
              SATELLITE_URL
            }
            attribution="Esri World Imagery"
          />
        )}

        {mapStyle ===
          "osm" && (
          <TileLayer
            url={
              OSM_URL
            }
            attribution="© OpenStreetMap contributors"
          />
        )}

        {mapStyle ===
          "transport" && (
          <TileLayer
            url={
              TRANSPORT_URL
            }
            attribution="© OpenStreetMap contributors"
          />
        )}

        {mapStyle ===
          "labels" && (
          <>
            <TileLayer
              url={
                SATELLITE_URL
              }
              attribution="Esri World Imagery"
            />

            <TileLayer
              url={
                LABEL_URL
              }
              attribution="Carto"
              opacity={0.9}
            />
          </>
        )}

        <LocationController location={location} />

        {location && (
          <Marker position={[location.lat, location.lon]}>
            <Popup>{location.label}</Popup>
          </Marker>
        )}

        <FeatureLayers
          buildings={
            features.buildings
          }
          roads={
            features.roads
          }
          water={
            features.water
          }
        />

        {selectedBounds && (
          <Rectangle
            bounds={[
              [
                selectedBounds.south,
                selectedBounds.west,
              ],
              [
                selectedBounds.north,
                selectedBounds.east,
              ],
            ]}
            pathOptions={{
              color: "#20d8f5",
              weight: 2,
              fillOpacity: 0.05,
              dashArray: "7 5",
            }}
          />
        )}

        <AreaSelector
          selecting={
            selecting
          }
          onSelected={
            handleAreaSelected
          }
        />
      </MapContainer>

      {/* SELECTED-AREA FEATURE SUMMARY */}
      {(selectedBounds || features.buildings.length || features.roads.length || features.water.length) && (
        <div
          style={{
            position: "absolute",
            left: 12,
            top: 112,
            zIndex: 2000,
            minWidth: 205,
            padding: "9px 11px",
            border: "1px solid rgba(32,216,245,.45)",
            borderRadius: 6,
            background: "rgba(3,17,22,.92)",
            color: "#bde8ee",
            fontSize: 10,
            lineHeight: 1.65,
            boxShadow: "0 6px 18px rgba(0,0,0,.28)",
          }}
        >
          <div style={{ color: "#20d8f5", fontWeight: 900, letterSpacing: "1px", marginBottom: 3 }}>
            SELECTED AREA FEATURES
          </div>
          <div>Buildings mapped: <strong style={{ color: "#ffd166" }}>{features.buildings.length}</strong></div>
          <div>Road segments: <strong>{features.roads.length}</strong></div>
          <div>Water features: <strong>{features.water.length}</strong></div>
          <div style={{ marginTop: 3, color: "#719da5", fontSize: 8.5 }}>
            Building count uses mapped OSM footprints; no 3D building blocks are generated.
          </div>
        </div>
      )}

      {/* MAP CONTROLS */}

      <div
        style={{
          position:
            "absolute",
          top: 12,
          right: 12,
          zIndex: 2000,
          display: "flex",
          flexDirection:
            "column",
          gap: 7,
        }}
      >
        {[
          [
            "satellite",
            "SATELLITE",
          ],
          [
            "osm",
            "OSM",
          ],
          [
            "labels",
            "LABELS",
          ],
          [
            "transport",
            "TRANSPORT",
          ],
        ].map(
          ([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() =>
                setMapStyle(
                  value
                )
              }
              style={{
                minWidth: 100,
                height: 34,
                border:
                  mapStyle ===
                  value
                    ? "1px solid #20d8f5"
                    : "1px solid #244a53",
                background:
                  "rgba(3,17,22,.9)",
                color:
                  mapStyle ===
                  value
                    ? "#20d8f5"
                    : "#9bc8d0",
                borderRadius: 5,
                fontSize: 9,
                fontWeight: 800,
                letterSpacing:
                  1,
              }}
            >
              {label}
            </button>
          )
        )}
      </div>

      <div
        style={{
          position:
            "absolute",
          left: 12,
          top: 218,
          zIndex: 2000,
          display: "flex",
          flexDirection:
            "column",
          gap: 7,
        }}
      >
        <button
          type="button"
          onClick={() =>
            setSelecting(
              (value) =>
                !value
            )
          }
          style={{
            minWidth: 160,
            height: 40,
            border:
              selecting
                ? "1px solid #ffcc22"
                : "1px solid #20d8f5",
            background:
              "rgba(3,17,22,.94)",
            color:
              selecting
                ? "#ffcc22"
                : "#20d8f5",
            borderRadius: 5,
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: 1,
          }}
        >
          {selecting
            ? "DRAG AREA..."
            : selectedBounds
              ? "SELECT AREA AGAIN"
              : "SELECT AREA"}
        </button>

        {selectedBounds && !loading && (
          <div
            style={{
              padding: "7px 10px",
              background: "rgba(3,17,22,.92)",
              border: "1px solid rgba(32,216,245,.35)",
              color: "#8ecbd5",
              borderRadius: 5,
              fontSize: 9,
            }}
          >
            Area selected ✓
          </div>
        )}

        {loading && (
          <div
            style={{
              padding:
                "8px 10px",
              background:
                "rgba(3,17,22,.92)",
              border:
                "1px solid #244a53",
              color:
                "#8ecbd5",
              borderRadius: 5,
              fontSize: 9,
            }}
          >
            Loading map
            features...
          </div>
        )}

        {partial && (
          <div
            style={{
              padding:
                "8px 10px",
              background:
                "rgba(3,17,22,.92)",
              border:
                "1px solid #806b2b",
              color:
                "#e6ca69",
              borderRadius: 5,
              fontSize: 9,
            }}
          >
            Some map layers
            unavailable.
          </div>
        )}

        {error && (
          <div
            style={{
              maxWidth: 240,
              padding:
                "8px 10px",
              background:
                "rgba(3,17,22,.94)",
              border:
                "1px solid #6f3333",
              color:
                "#ff9999",
              borderRadius: 5,
              fontSize: 9,
            }}
          >
            {error}
          </div>
        )}

      </div>
    </div>
  );
}