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

const OVERPASS_URL =
  "https://overpass-api.de/api/interpreter";

const MAX_BUILDINGS = 500;
const MAX_ROADS = 250;
const MAX_WATER = 150;

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
      setStart(null);
      setCurrent(null);
      map.dragging.enable();
    }
  }, [
    selecting,
    map,
  ]);

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

async function runOverpassQuery(
  query
) {
  const response =
    await fetch(
      OVERPASS_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "text/plain",
        },
        body: query,
      }
    );

  if (!response.ok) {
    throw new Error(
      `Overpass error ${response.status}`
    );
  }

  return response.json();
}

async function loadOSMFeatures(
  bounds
) {
  const south =
    bounds.south;

  const west =
    bounds.west;

  const north =
    bounds.north;

  const east =
    bounds.east;

  const buildingQuery = `
    [out:json][timeout:25];
    (
      way["building"](${south},${west},${north},${east});
      relation["building"](${south},${west},${north},${east});
    );
    out tags geom;
  `;

  const roadQuery = `
    [out:json][timeout:25];
    (
      way["highway"](${south},${west},${north},${east});
    );
    out tags geom;
  `;

  const waterQuery = `
    [out:json][timeout:25];
    (
      way["natural"="water"](${south},${west},${north},${east});
      way["waterway"](${south},${west},${north},${east});
      relation["natural"="water"](${south},${west},${north},${east});
    );
    out tags geom;
  `;

  const results =
    await Promise.allSettled([
      runOverpassQuery(
        buildingQuery
      ),

      runOverpassQuery(
        roadQuery
      ),

      runOverpassQuery(
        waterQuery
      ),
    ]);

  const buildingResult =
    results[0];

  const roadResult =
    results[1];

  const waterResult =
    results[2];

  const buildings =
    buildingResult.status ===
    "fulfilled"
      ? buildingResult.value.elements
          .filter(
            (item) =>
              Array.isArray(
                item.geometry
              )
          )
          .slice(
            0,
            MAX_BUILDINGS
          )
      : [];

  const roads =
    roadResult.status ===
    "fulfilled"
      ? roadResult.value.elements
          .filter(
            (item) =>
              Array.isArray(
                item.geometry
              )
          )
          .slice(
            0,
            MAX_ROADS
          )
      : [];

  const water =
    waterResult.status ===
    "fulfilled"
      ? waterResult.value.elements
          .filter(
            (item) =>
              Array.isArray(
                item.geometry
              )
          )
          .slice(
            0,
            MAX_WATER
          )
      : [];

  const failed =
    results.filter(
      (result) =>
        result.status ===
        "rejected"
    ).length;

  return {
    buildings,
    roads,
    water,
    partial:
      failed > 0,
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

  const requestId =
    useRef(0);

  const handleAreaSelected =
    async (bounds) => {
      setSelectedBounds(
        bounds
      );

      setSelecting(false);
      setLoading(true);
      setError("");
      setPartial(false);

      const currentRequest =
        ++requestId.current;

      try {
        const data =
          await loadOSMFeatures(
            bounds
          );

        /*
          Ignore stale Overpass response.
        */
        if (
          currentRequest !==
          requestId.current
        ) {
          return;
        }

        setFeatures(
          data
        );

        onAreaSelected?.({
          bounds,
          buildings:
            data.buildings,
          roads:
            data.roads,
          water:
            data.water,
        });

        setPartial(
          data.partial
        );
      } catch (err) {
        console.error(err);

        setFeatures({
          buildings: [],
          roads: [],
          water: [],
        });

        setError(
          "Map feature service unavailable. Terrain DEM can still be loaded."
        );

        onAreaSelected?.({
          bounds,
          buildings: [],
          roads: [],
          water: [],
        });
      } finally {
        if (
          currentRequest ===
          requestId.current
        ) {
          setLoading(false);
        }
      }
    };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position:
          "relative",
      }}
    >
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
          bottom: 12,
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
            : "SELECT AREA"}
        </button>

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

        {selectedBounds && (
          <div
            style={{
              padding:
                "8px 10px",
              background:
                "rgba(3,17,22,.92)",
              border:
                "1px solid #244a53",
              color:
                "#91c5ce",
              borderRadius: 5,
              fontSize: 9,
            }}
          >
            Buildings:{" "}
            {
              features
                .buildings
                .length
            }
            <br />
            Roads:{" "}
            {
              features.roads
                .length
            }
            <br />
            Water:{" "}
            {
              features.water
                .length
            }
          </div>
        )}
      </div>
    </div>
  );
}