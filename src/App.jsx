import React, { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import "./App.css";
import MapView from "./MapView";

/* =======================================================
   LOKA 3D — corrected terrain renderer
   ======================================================= */

const GRID_SIZE = 96;
const TERRAIN_SIZE = 70;

/*
  This is deliberately stronger than the old 2.4 value.
  The old terrain was visually almost flat.
  7.0 gives visible relief while smoothing prevents spikes.
*/
const MAX_TERRAIN_HEIGHT = 8.4;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function normalizeValues(values) {
  if (!values?.length) return [];

  let min = Infinity;
  let max = -Infinity;

  for (const value of values) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    min = Math.min(min, n);
    max = Math.max(max, n);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return values.map(() => 0);
  }

  const range = max - min || 1;

  return values.map((value) => {
    const n = Number(value);
    return Number.isFinite(n)
      ? clamp((n - min) / range, 0, 1)
      : 0;
  });
}

/* =======================================================
   HEIGHT SMOOTHING
   ======================================================= */

function smoothHeightMap(values, size, passes = 3) {
  if (!values?.length) return [];

  let current = [...values];

  for (let pass = 0; pass < passes; pass++) {
    const next = new Array(current.length).fill(0);

    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        let total = 0;
        let weightTotal = 0;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const rr = row + dy;
            const cc = col + dx;

            if (
              rr < 0 ||
              rr >= size ||
              cc < 0 ||
              cc >= size
            ) {
              continue;
            }

            const distance = Math.abs(dx) + Math.abs(dy);

            let weight = 1;
            if (distance === 1) weight = 2;
            if (distance === 0) weight = 4;

            total += current[rr * size + cc] * weight;
            weightTotal += weight;
          }
        }

        next[row * size + col] =
          weightTotal > 0 ? total / weightTotal : current[row * size + col];
      }
    }

    current = next;
  }

  return current;
}

/* =======================================================
   SLOPE
   ======================================================= */

function calculateSlopeMap(values, size) {
  if (!values?.length) return [];

  const slopes = new Array(values.length).fill(0);

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const index = row * size + col;

      const left =
        values[row * size + Math.max(0, col - 1)];

      const right =
        values[row * size + Math.min(size - 1, col + 1)];

      const up =
        values[Math.max(0, row - 1) * size + col];

      const down =
        values[Math.min(size - 1, row + 1) * size + col];

      const dx = (right - left) * 0.5;
      const dy = (down - up) * 0.5;

      slopes[index] = Math.sqrt(dx * dx + dy * dy);
    }
  }

  return normalizeValues(slopes);
}

function percentile(values, p) {
  if (!values?.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(
    clamp(p, 0, 1) * (sorted.length - 1)
  );

  return sorted[index];
}

function getAnalysisSummary(heightData, highlight) {
  if (!heightData?.length || !highlight) {
    return null;
  }

  const values = smoothHeightMap(
    normalizeValues(heightData),
    GRID_SIZE,
    3
  ).map((value) => {
    const shaped = Math.pow(
      clamp(value, 0, 1),
      0.86
    );

    return clamp(
      0.025 + shaped * 0.95,
      0.025,
      0.975
    );
  });

  const slopes = calculateSlopeMap(values, GRID_SIZE);
  const { components } = buildAnalysisCellMask(
    values,
    slopes,
    highlight
  );

  if (!components?.length) {
    return null;
  }

  const component = components[0];
  const cellCols = GRID_SIZE - 1;

  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;

  const selectedHeights = [];

  for (const cellIndex of component) {
    const row = Math.floor(cellIndex / cellCols);
    const col = cellIndex % cellCols;

    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);

    const i00 = row * GRID_SIZE + col;
    const i10 = i00 + 1;
    const i01 = (row + 1) * GRID_SIZE + col;
    const i11 = i01 + 1;

    selectedHeights.push(
      values[i00],
      values[i10],
      values[i01],
      values[i11]
    );
  }

  const minHeight = Math.min(...selectedHeights);
  const maxHeight = Math.max(...selectedHeights);
  const depth = (maxHeight - minHeight) * MAX_TERRAIN_HEIGHT;

  const width = ((maxCol - minCol + 1) / (GRID_SIZE - 1)) * TERRAIN_SIZE;
  const heightSpan = ((maxRow - minRow + 1) / (GRID_SIZE - 1)) * TERRAIN_SIZE;
  const length = Math.max(width, heightSpan);

  const label =
    highlight === "highest"
      ? "Highest zone"
      : highlight === "lowest"
        ? "Lowest zone"
        : "Steepest zone";

  return {
    label,
    length,
    depth,
    minHeight: minHeight * MAX_TERRAIN_HEIGHT,
    maxHeight: maxHeight * MAX_TERRAIN_HEIGHT,
  };
}

/* =======================================================
   TERRAIN POSITION HELPERS
   ======================================================= */

function terrainPosition(row, col, height) {
  const x =
    (col / (GRID_SIZE - 1) - 0.5) *
    TERRAIN_SIZE;

  const z =
    (0.5 - row / (GRID_SIZE - 1)) *
    TERRAIN_SIZE;

  return [x, height * MAX_TERRAIN_HEIGHT, z];
}

/* =======================================================
   ANALYSIS REGION OVERLAY

   The analysis is region-based rather than a single extreme
   vertex. We first select the strongest ~12% of the metric,
   group neighboring cells, discard tiny islands, and render
   the remaining connected regions as a strong surface overlay.
   ======================================================= */

function getAnalysisConfig(highlight) {
  if (highlight === "highest") {
    return {
      metricName: "height",
      thresholdPercentile: 0.93,
      color: [1.0, 0.72, 0.04],
      cssColor: "#ffd23f",
    };
  }

  if (highlight === "lowest") {
    return {
      metricName: "height",
      thresholdPercentile: 0.07,
      color: [0.04, 0.58, 1.0],
      cssColor: "#1597ff",
    };
  }

  return {
    metricName: "slope",
    thresholdPercentile: 0.91,
    color: [1.0, 0.12, 0.05],
    cssColor: "#ff321f",
  };
}

function buildAnalysisCellMask(values, slopes, highlight) {
  const metric =
    highlight === "steepest" ? slopes : values;

  if (!metric?.length) {
    return {
      mask: [],
      components: [],
    };
  }

  const config = getAnalysisConfig(highlight);
  const threshold = percentile(
    metric,
    config.thresholdPercentile
  );

  const cellRows = GRID_SIZE - 1;
  const cellCols = GRID_SIZE - 1;
  const cellCount = cellRows * cellCols;
  const mask = new Uint8Array(cellCount);

  for (let row = 0; row < cellRows; row++) {
    for (let col = 0; col < cellCols; col++) {
      const i00 = row * GRID_SIZE + col;
      const i10 = i00 + 1;
      const i01 = (row + 1) * GRID_SIZE + col;
      const i11 = i01 + 1;

      const cellMetric =
        (
          metric[i00] +
          metric[i10] +
          metric[i01] +
          metric[i11]
        ) / 4;

      const selected =
        highlight === "lowest"
          ? cellMetric <= threshold
          : cellMetric >= threshold;

      if (selected) {
        mask[row * cellCols + col] = 1;
      }
    }
  }

  /*
    Connected-component cleanup.
    Tiny isolated cells are ignored so the highlight represents
    terrain regions rather than noisy individual pixels.
  */
  const visited = new Uint8Array(cellCount);
  const components = [];

  for (let row = 0; row < cellRows; row++) {
    for (let col = 0; col < cellCols; col++) {
      const startIndex = row * cellCols + col;

      if (!mask[startIndex] || visited[startIndex]) {
        continue;
      }

      const queue = [startIndex];
      visited[startIndex] = 1;
      const cells = [];

      while (queue.length) {
        const current = queue.pop();
        cells.push(current);

        const cr = Math.floor(current / cellCols);
        const cc = current % cellCols;

        const neighbors = [
          [cr - 1, cc],
          [cr + 1, cc],
          [cr, cc - 1],
          [cr, cc + 1],
        ];

        for (const [nr, nc] of neighbors) {
          if (
            nr < 0 ||
            nr >= cellRows ||
            nc < 0 ||
            nc >= cellCols
          ) {
            continue;
          }

          const ni = nr * cellCols + nc;

          if (mask[ni] && !visited[ni]) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }

      components.push(cells);
    }
  }

  /*
    Keep the largest few meaningful regions. This avoids a single
    giant scattered mask while still allowing "areas" plural.
  */
  components.sort((a, b) => b.length - a.length);

  const minimumCells = Math.max(
    4,
    Math.max(6, Math.floor(cellCount * 0.002))
  );

  const meaningful =
    components
      .filter((component) => component.length >= minimumCells)
      .slice(0, 4);

  /*
    If the percentile creates only tiny islands, fall back to the
    largest component so the analysis never appears empty.
  */
  if (!meaningful.length && components.length) {
    meaningful.push(components[0]);
  }

  return {
    mask,
    components: meaningful,
  };
}

function createAnalysisOverlay(
  values,
  slopes,
  highlight
) {
  if (!highlight || !values?.length) return null;

  const { components, color, cssColor } =
    (() => {
      const config = getAnalysisConfig(highlight);
      const result = buildAnalysisCellMask(
        values,
        slopes,
        highlight
      );

      return {
        ...config,
        components: result.components,
      };
    })();

  if (!components.length) return null;

  const cellCols = GRID_SIZE - 1;
  const vertices = [];
  const addTriangle = (a, b, c) => {
    vertices.push(...a, ...b, ...c);
  };

  /*
    Slightly lift the overlay above the real surface. The offset is
    small enough to remain visually attached to the terrain.
  */
  const SURFACE_OFFSET = 0.045;

  const selectedCellSet = new Set(
    components.flat()
  );

  for (const cellIndex of selectedCellSet) {
    const row = Math.floor(cellIndex / cellCols);
    const col = cellIndex % cellCols;

    const i00 = row * GRID_SIZE + col;
    const i10 = row * GRID_SIZE + col + 1;
    const i01 = (row + 1) * GRID_SIZE + col;
    const i11 = (row + 1) * GRID_SIZE + col + 1;

    const p00 = terrainPosition(
      row,
      col,
      values[i00] + SURFACE_OFFSET
    );
    const p10 = terrainPosition(
      row,
      col + 1,
      values[i10] + SURFACE_OFFSET
    );
    const p01 = terrainPosition(
      row + 1,
      col,
      values[i01] + SURFACE_OFFSET
    );
    const p11 = terrainPosition(
      row + 1,
      col + 1,
      values[i11] + SURFACE_OFFSET
    );

    addTriangle(p00, p10, p11);
    addTriangle(p00, p11, p01);
  }

  if (!vertices.length) return null;

  /*
    Calculate a representative point from all selected cells.
    This point is used by the survey pin and is therefore tied to
    the highlighted region rather than an unrelated global pixel.
  */
  let weightedX = 0;
  let weightedZ = 0;
  let weightedY = 0;
  let weightTotal = 0;

  for (const cellIndex of selectedCellSet) {
    const row = Math.floor(cellIndex / cellCols);
    const col = cellIndex % cellCols;

    const centerRow = row + 0.5;
    const centerCol = col + 0.5;

    const i00 = row * GRID_SIZE + col;
    const i10 = i00 + 1;
    const i01 = (row + 1) * GRID_SIZE + col;
    const i11 = i01 + 1;

    const metric =
      highlight === "steepest"
        ? slopes
        : values;

    const cellMetric =
      (
        metric[i00] +
        metric[i10] +
        metric[i01] +
        metric[i11]
      ) / 4;

    const weight =
      highlight === "lowest"
        ? Math.max(0.05, 1.05 - cellMetric)
        : Math.max(0.05, cellMetric);

    const x =
      (centerCol / (GRID_SIZE - 1) - 0.5) *
      TERRAIN_SIZE;

    const z =
      (0.5 - centerRow / (GRID_SIZE - 1)) *
      TERRAIN_SIZE;

    const y =
      (
        values[i00] +
        values[i10] +
        values[i01] +
        values[i11]
      ) /
      4 *
      MAX_TERRAIN_HEIGHT;

    weightedX += x * weight;
    weightedZ += z * weight;
    weightedY += y * weight;
    weightTotal += weight;
  }

  const anchor =
    weightTotal > 0
      ? {
          x: weightedX / weightTotal,
          y: weightedY / weightTotal,
          z: weightedZ / weightTotal,
        }
      : {
          x: 0,
          y: 0,
          z: 0,
        };

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      vertices,
      3
    )
  );
  geometry.computeVertexNormals();

  return {
    geometry,
    color,
    cssColor,
    anchor,
  };
}

/* =======================================================
   TERRAIN BUNDLE
   ======================================================= */

function createTerrainBundle(heightData, highlight) {
  const normalized = normalizeValues(heightData);

  /*
    Strong smoothing prevents pixel noise from becoming
    spikes, but we preserve enough variation for visible
    3D relief.
  */
  const smoothed = smoothHeightMap(
    normalized,
    GRID_SIZE,
    4
  );

  /*
    Contrast curve:
    - avoids a completely flat middle
    - prevents extreme peaks
    - keeps the usable terrain range broad
  */
  const terrainValues = smoothed.map((value) => {
    const shaped = Math.pow(
      clamp(value, 0, 1),
      0.86
    );

    return clamp(
      0.025 + shaped * 0.95,
      0.025,
      0.975
    );
  });

  const slopes = calculateSlopeMap(
    terrainValues,
    GRID_SIZE
  );

  const geometry = new THREE.PlaneGeometry(
    TERRAIN_SIZE,
    TERRAIN_SIZE,
    GRID_SIZE - 1,
    GRID_SIZE - 1
  );

  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position;

  for (let i = 0; i < position.count; i++) {
    position.setY(
      i,
      terrainValues[i] * MAX_TERRAIN_HEIGHT
    );
  }

  geometry.computeVertexNormals();

  const overlay =
    createAnalysisOverlay(
      terrainValues,
      slopes,
      highlight
    );

  return {
    geometry,
    overlayGeometry:
      overlay?.geometry ?? null,
    overlayColor:
      overlay?.color ?? null,
    overlayAnchor:
      overlay?.anchor ?? null,
    overlayCssColor:
      overlay?.cssColor ?? null,
    values: terrainValues,
    slopes,
  };
}

/* =======================================================
   ANALYSIS PIN
   ======================================================= */

function AnalysisPin({
  anchor,
  type,
}) {
  if (!anchor) return null;

  const color =
    type === "highest"
      ? "#ffd23f"
      : type === "lowest"
        ? "#1597ff"
        : "#ff321f";

  return (
    <group
      position={[
        anchor.x,
        anchor.y,
        anchor.z,
      ]}
    >
      {/* Ground ring marks the actual analysis region center. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.09, 0]}
      >
        <ringGeometry
          args={[0.75, 1.05, 32]}
        />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Thin survey pole. */}
      <mesh position={[0, 2.2, 0]}>
        <cylinderGeometry
          args={[0.045, 0.045, 4.4, 8]}
        />
        <meshBasicMaterial
          color={color}
        />
      </mesh>

      {/* Clear survey marker. */}
      <mesh position={[0, 4.55, 0]}>
        <coneGeometry
          args={[0.3, 0.65, 16]}
        />
        <meshBasicMaterial
          color={color}
        />
      </mesh>

      <mesh position={[0, 4.95, 0]}>
        <sphereGeometry
          args={[0.13, 12, 12]}
        />
        <meshBasicMaterial
          color="#ffffff"
        />
      </mesh>
    </group>
  );
}

/* =======================================================
   TERRAIN SKIRT
   Gives the terrain a physical edge/sidewall so the relief reads
   as a 3D landform instead of a floating paper surface.
   ======================================================= */
function TerrainSkirt({ values }) {
  const geometry = useMemo(() => {
    if (!values?.length) return null;

    const segments = GRID_SIZE - 1;
    const depth = 2.8;
    const vertices = [];
    const pushQuad = (a,b,c,d) => {
      vertices.push(...a,...b,...c, ...a,...c,...d);
    };

    const pos = (row,col,yOffset=0) => {
      const x = (col / (GRID_SIZE - 1) - 0.5) * TERRAIN_SIZE;
      const z = (0.5 - row / (GRID_SIZE - 1)) * TERRAIN_SIZE;
      const y = values[row * GRID_SIZE + col] * MAX_TERRAIN_HEIGHT + yOffset;
      return [x,y,z];
    };

    for (let col=0; col<segments; col++) {
      const t0=pos(0,col), t1=pos(0,col+1);
      pushQuad(t0,t1,[t1[0],t1[1]-depth,t1[2]],[t0[0],t0[1]-depth,t0[2]]);
      const b0=pos(segments,col), b1=pos(segments,col+1);
      pushQuad(b1,b0,[b0[0],b0[1]-depth,b0[2]],[b1[0],b1[1]-depth,b1[2]]);
    }
    for (let row=0; row<segments; row++) {
      const l0=pos(row,0), l1=pos(row+1,0);
      pushQuad(l1,l0,[l0[0],l0[1]-depth,l0[2]],[l1[0],l1[1]-depth,l1[2]]);
      const r0=pos(row,segments), r1=pos(row+1,segments);
      pushQuad(r0,r1,[r1[0],r1[1]-depth,r1[2]],[r0[0],r0[1]-depth,r0[2]]);
    }

    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
    g.computeVertexNormals();
    return g;
  },[values]);

  if(!geometry) return null;
  return (
    <mesh geometry={geometry} receiveShadow renderOrder={1}>
      <meshStandardMaterial color="#4b6658" roughness={1} metalness={0} side={THREE.DoubleSide} />
    </mesh>
  );
}

/* =======================================================
   TERRAIN
   ======================================================= */

function Terrain({
  heightData,
  highlight,
  flythrough,
  satelliteImage,
}) {
  const { camera } = useThree();

  const bundle = useMemo(
    () =>
      createTerrainBundle(
        heightData,
        highlight
      ),
    [heightData, highlight]
  );

  const texture = useMemo(() => {
    if (!satelliteImage) return null;

    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");

    const loaded = loader.load(
      satelliteImage,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
      },
      undefined,
      () => {
        /*
          Local uploaded/demo images normally work.
          External map imagery can fail because of CORS;
          the terrain still renders without the texture.
        */
      }
    );

    loaded.wrapS = THREE.ClampToEdgeWrapping;
    loaded.wrapT = THREE.ClampToEdgeWrapping;

    return loaded;
  }, [satelliteImage]);

  const target = useRef(
    new THREE.Vector3()
  );

  const desiredCamera = useRef(
    new THREE.Vector3()
  );

  const lookAhead = useRef(
    new THREE.Vector3()
  );

  const flyStartTime = useRef(null);

  const edgeGeometry = useMemo(
    () => new THREE.EdgesGeometry(bundle.geometry, 18),
    [bundle.geometry]
  );

  /*
    Wide, stable survey camera.  Keep the camera well above the
    terrain instead of trying to hug the surface.
  */
  useEffect(() => {
    camera.position.set(42, 26, 42);
    camera.lookAt(0, 2.5, 0);
  }, [camera]);

  useEffect(() => {
    return () => {
      bundle.geometry.dispose();

      if (bundle.overlayGeometry) {
        bundle.overlayGeometry.dispose();
      }

      edgeGeometry.dispose();

      if (texture) {
        texture.dispose();
      }
    };
  }, [bundle, texture, edgeGeometry]);

  const sampleHeight = (x, z) => {
    // Bilinear sampling keeps the flythrough smooth instead of
    // jumping from one terrain vertex to the next.
    const fx = clamp(
      ((x / TERRAIN_SIZE) + 0.5) * (GRID_SIZE - 1),
      0,
      GRID_SIZE - 1
    );
    const fz = clamp(
      (0.5 - z / TERRAIN_SIZE) * (GRID_SIZE - 1),
      0,
      GRID_SIZE - 1
    );

    const c0 = Math.floor(fx);
    const r0 = Math.floor(fz);
    const c1 = Math.min(GRID_SIZE - 1, c0 + 1);
    const r1 = Math.min(GRID_SIZE - 1, r0 + 1);
    const tx = fx - c0;
    const tz = fz - r0;

    const h00 = bundle.values[r0 * GRID_SIZE + c0] ?? 0.2;
    const h10 = bundle.values[r0 * GRID_SIZE + c1] ?? h00;
    const h01 = bundle.values[r1 * GRID_SIZE + c0] ?? h00;
    const h11 = bundle.values[r1 * GRID_SIZE + c1] ?? h00;

    const top = h00 + (h10 - h00) * tx;
    const bottom = h01 + (h11 - h01) * tx;
    return top + (bottom - top) * tz;
  };

  useEffect(() => {
    if (!flythrough) {
      flyStartTime.current = null;
      return;
    }

    flyStartTime.current = null;
    camera.position.set(0, 23, 40);
    camera.lookAt(0, 3.5, 8);
  }, [flythrough, camera, bundle.values]);

  useFrame((state, delta) => {
    if (!flythrough) return;

    if (flyStartTime.current === null) {
      flyStartTime.current = state.clock.elapsedTime;
    }

    // Cinematic survey loop: broad turns, a closer terrain pass, and
    // continuous terrain-following. The camera never uses a fixed Y.
    const elapsed = state.clock.elapsedTime - flyStartTime.current;
    const t = elapsed * 0.42;
    const radiusX = 34;
    const radiusZ = 30;

    const x = Math.sin(t) * radiusX;
    const z = Math.cos(t * 0.86) * radiusZ;

    const nextT = t + 0.055;
    const nextX = Math.sin(nextT) * radiusX;
    const nextZ = Math.cos(nextT * 0.86) * radiusZ;

    const terrainY = sampleHeight(x, z) * MAX_TERRAIN_HEIGHT;
    const nextTerrainY = sampleHeight(nextX, nextZ) * MAX_TERRAIN_HEIGHT;

    // Slightly vary the clearance so the flythrough feels like an
    // actual aerial survey rather than a flat circular orbit.
    const clearance = 12.0 + Math.sin(t * 0.48) * 1.8;
    const desiredY = terrainY + clearance;
    desiredCamera.current.set(x, desiredY, z);

    const smoothing = 1 - Math.pow(0.0008, Math.max(delta, 0.016));
    camera.position.lerp(desiredCamera.current, Math.min(smoothing, 0.16));

    lookAhead.current.set(
      nextX,
      nextTerrainY + 2.8,
      nextZ
    );

    camera.lookAt(lookAhead.current);
  });

  return (
    <>
      {/* Main textured terrain surface */}
      <mesh
        geometry={bundle.geometry}
        receiveShadow
        castShadow
      >
        <meshStandardMaterial
          map={texture}
          color={texture ? "#ffffff" : "#78966d"}
          roughness={0.74}
          metalness={0.06}
          side={THREE.DoubleSide}
        />
      </mesh>

      <TerrainSkirt values={bundle.values} />

      {/* Actual highest/lowest/steepest terrain regions */}
      {bundle.overlayGeometry &&
        bundle.overlayColor && (
          <mesh
            geometry={bundle.overlayGeometry}
            renderOrder={5}
          >
            <meshBasicMaterial
              color={bundle.overlayColor}
              transparent
              opacity={0.88}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        )}

      {/* Region-centered survey marker. */}
      {highlight && (
        <AnalysisPin
          anchor={bundle.overlayAnchor}
          type={highlight}
        />
      )}

      {/* Subtle relief grid: makes the 3D elevation easier to read without adding heavy geometry. */}
      <mesh geometry={bundle.geometry} renderOrder={2}>
        <meshBasicMaterial
          color="#b9d8c2"
          wireframe
          transparent
          opacity={0.055}
          depthWrite={false}
        />
      </mesh>

      {/* Terrain boundary gives the surface a physical 3D edge. */}
      <lineSegments geometry={edgeGeometry} renderOrder={4}>
        <lineBasicMaterial
          color="#6d9a91"
          transparent
          opacity={0.38}
        />
      </lineSegments>
    </>
  );
}

/* =======================================================
   MAP FEATURES IN 3D
   ======================================================= */

function MapFeatures3D({
  bounds,
  buildings = [],
  roads = [],
  water = [],
  heightData,
}) {
  const normalized = useMemo(
    () => normalizeValues(heightData || []),
    [heightData]
  );

  if (!bounds || !normalized.length) {
    return null;
  }

  const south = bounds.south;
  const north = bounds.north;
  const west = bounds.west;
  const east = bounds.east;

  const toTerrain = (lat, lon) => {
    const x =
      ((lon - west) /
        Math.max(east - west, 0.000001) -
        0.5) *
      TERRAIN_SIZE;

    const z =
      (0.5 -
        (lat - south) /
          Math.max(
            north - south,
            0.000001
          )) *
      TERRAIN_SIZE;

    const col = clamp(
      Math.round(
        ((x / TERRAIN_SIZE) + 0.5) *
          (GRID_SIZE - 1)
      ),
      0,
      GRID_SIZE - 1
    );

    const row = clamp(
      Math.round(
        (0.5 - z / TERRAIN_SIZE) *
          (GRID_SIZE - 1)
      ),
      0,
      GRID_SIZE - 1
    );

    const index =
      row * GRID_SIZE + col;

    return {
      x,
      z,
      y:
        (normalized[index] || 0) *
        MAX_TERRAIN_HEIGHT,
    };
  };

  return (
    <group>
      {/* WATER */}
      {water.slice(0, 40).map(
        (feature, index) => {
          const coords =
            feature.coordinates;

          if (
            !Array.isArray(coords) ||
            !coords.length
          ) {
            return null;
          }

          const points = coords
            .map((p) => {
              if (
                !Array.isArray(p) ||
                p.length < 2
              ) {
                return null;
              }

              return toTerrain(
                p[1],
                p[0]
              );
            })
            .filter(Boolean);

          if (points.length < 3) {
            return null;
          }

          const shape =
            new THREE.Shape();

          points.forEach((p, i) => {
            if (i === 0) {
              shape.moveTo(p.x, p.z);
            } else {
              shape.lineTo(p.x, p.z);
            }
          });

          shape.closePath();

          return (
            <mesh
              key={`water-${index}`}
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, 0.08, 0]}
            >
              <shapeGeometry args={[shape]} />
              <meshStandardMaterial
                color="#1b82a8"
                transparent
                opacity={0.55}
              />
            </mesh>
          );
        }
      )}

      {/* BUILDINGS */}
      {buildings.slice(0, 60).map(
        (feature, index) => {
          const coords =
            feature.coordinates;

          if (
            !Array.isArray(coords) ||
            coords.length < 3
          ) {
            return null;
          }

          const points = coords
            .map((p) => {
              if (
                !Array.isArray(p) ||
                p.length < 2
              ) {
                return null;
              }

              return toTerrain(
                p[1],
                p[0]
              );
            })
            .filter(Boolean);

          if (points.length < 3) {
            return null;
          }

          const xs =
            points.map((p) => p.x);
          const zs =
            points.map((p) => p.z);

          const minX =
            Math.min(...xs);
          const maxX =
            Math.max(...xs);
          const minZ =
            Math.min(...zs);
          const maxZ =
            Math.max(...zs);

          const width = Math.max(
            0.25,
            maxX - minX
          );

          const depth = Math.max(
            0.25,
            maxZ - minZ
          );

          const centerX =
            (minX + maxX) / 2;

          const centerZ =
            (minZ + maxZ) / 2;

          const center =
            toTerrain(
              feature.latMin ?? south,
              feature.lonMin ?? west
            );

          const levels =
            Number(
              feature.tags?.["building:levels"]
            );

          const rawHeight =
            Number(
              feature.tags?.height
            );

          let buildingHeight = 0.5;

          if (
            Number.isFinite(rawHeight)
          ) {
            buildingHeight =
              clamp(
                rawHeight / 8,
                0.25,
                2.8
              );
          } else if (
            Number.isFinite(levels)
          ) {
            buildingHeight =
              clamp(
                levels * 0.18,
                0.3,
                2.5
              );
          }

          return (
            <mesh
              key={`building-${index}`}
              position={[
                centerX,
                center.y +
                  buildingHeight / 2 +
                  0.08,
                centerZ,
              ]}
              castShadow
            >
              <boxGeometry
                args={[
                  width,
                  buildingHeight,
                  depth,
                ]}
              />
              <meshStandardMaterial
                color="#b6b7ad"
                roughness={0.9}
              />
            </mesh>
          );
        }
      )}

      {/* ROADS */}
      {roads.slice(0, 60).map(
        (feature, index) => {
          const coords =
            feature.coordinates;

          if (!Array.isArray(coords)) {
            return null;
          }

          const points = coords
            .map((p) => {
              if (
                !Array.isArray(p) ||
                p.length < 2
              ) {
                return null;
              }

              const t =
                toTerrain(
                  p[1],
                  p[0]
                );

              return [
                t.x,
                t.y + 0.12,
                t.z,
              ];
            })
            .filter(Boolean);

          if (points.length < 2) {
            return null;
          }

          return (
            <Line
              key={`road-${index}`}
              points={points}
              color="#e8e4d7"
              lineWidth={1.1}
            />
          );
        }
      )}
    </group>
  );
}

/* =======================================================
   VIRTUAL SCENE — BLUEPRINT OVERLAY
   Visual-only layer. It reuses the existing terrain geometry and
   does not alter height values, analysis, or flythrough logic.
   ======================================================= */
function BlueprintScene({ heightData }) {
  const bundle = useMemo(
    () => createTerrainBundle(heightData, null),
    [heightData]
  );

  const edgeGeometry = useMemo(
    () => new THREE.EdgesGeometry(bundle.geometry, 12),
    [bundle.geometry]
  );

  const contourGeometries = useMemo(() => {
    const levels = 9;
    const groups = [];

    for (let level = 1; level < levels; level++) {
      const threshold = level / levels;
      const vertices = [];

      for (let row = 0; row < GRID_SIZE - 1; row += 2) {
        let previous = null;

        for (let col = 0; col < GRID_SIZE; col += 1) {
          const value = bundle.values[row * GRID_SIZE + col] ?? 0;
          const x = (col / (GRID_SIZE - 1) - 0.5) * TERRAIN_SIZE;
          const z = (0.5 - row / (GRID_SIZE - 1)) * TERRAIN_SIZE;
          const y = value * MAX_TERRAIN_HEIGHT + 0.08;

          if (Math.abs(value - threshold) < 0.018) {
            const point = [x, y, z];
            if (previous) vertices.push(...previous, ...point);
            previous = point;
          } else {
            previous = null;
          }
        }
      }

      const geometry = new THREE.BufferGeometry();
      if (vertices.length) {
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(vertices, 3)
        );
      }
      groups.push(geometry);
    }

    return groups;
  }, [bundle.values]);

  useEffect(() => {
    return () => {
      bundle.geometry.dispose();
      edgeGeometry.dispose();
      contourGeometries.forEach((geometry) => geometry.dispose());
    };
  }, [bundle.geometry, edgeGeometry, contourGeometries]);

  return (
    <group>
      {/* Cyan blueprint surface — same terrain geometry, alternate material only. */}
      <mesh geometry={bundle.geometry} renderOrder={10}>
        <meshBasicMaterial
          color="#42d9ff"
          wireframe
          transparent
          opacity={0.34}
          depthWrite={false}
        />
      </mesh>

      {/* Strong outer technical edges. */}
      <lineSegments geometry={edgeGeometry} renderOrder={11}>
        <lineBasicMaterial
          color="#8ff3ff"
          transparent
          opacity={0.82}
        />
      </lineSegments>

      {/* Relative elevation bands. */}
      {contourGeometries.map((geometry, index) => (
        geometry.attributes.position?.count ? (
          <lineSegments key={index} geometry={geometry} renderOrder={12}>
            <lineBasicMaterial
              color="#38bdf8"
              transparent
              opacity={0.32}
            />
          </lineSegments>
        ) : null
      ))}

      {/* Technical floor grid. */}
      <Grid
        args={[TERRAIN_SIZE, TERRAIN_SIZE]}
        position={[0, -0.08, 0]}
        cellSize={2.5}
        sectionSize={10}
        fadeDistance={100}
        fadeStrength={0.35}
        cellColor="#237f9b"
        sectionColor="#53d9ef"
        cellThickness={0.45}
        sectionThickness={0.8}
      />
    </group>
  );
}


/* =======================================================
   FLOOD SIMULATION — PHASE 2
   Relative single-view terrain only: water depth is simulated
   in scene units, not physical metres.
   ======================================================= */
function RainField({ active, intensity = 1 }) {
  const points = useMemo(() => {
    const count = 700;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * TERRAIN_SIZE;
      arr[i * 3 + 1] = 10 + Math.random() * 24;
      arr[i * 3 + 2] = (Math.random() - 0.5) * TERRAIN_SIZE;
    }
    return arr;
  }, []);

  const ref = useRef();

  useFrame((state, delta) => {
    if (!active || !ref.current) return;
    const pos = ref.current.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i + 1] -= delta * (10 + intensity * 9);
      if (pos[i + 1] < 1.5) {
        pos[i + 1] = 18 + Math.random() * 15;
      }
    }
    ref.current.geometry.attributes.position.needsUpdate = true;
  });

  if (!active) return null;

  return (
    <points ref={ref} renderOrder={30}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={points.length / 3}
          array={points}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        color="#9edfff"
        size={0.16}
        transparent
        opacity={0.68}
        sizeAttenuation
      />
    </points>
  );
}

function FloodWater({ heightData, active, simulationTime, intensity = 1 }) {
  const flowRef = useRef();
  const poolRef = useRef();

  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(
      TERRAIN_SIZE / (GRID_SIZE - 1),
      TERRAIN_SIZE / (GRID_SIZE - 1)
    );
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, []);

  const waterModel = useMemo(() => {
    if (!heightData?.length) return null;

    const values = smoothHeightMap(normalizeValues(heightData), GRID_SIZE, 2);
    const total = GRID_SIZE * GRID_SIZE;
    const downstream = new Int32Array(total);
    downstream.fill(-1);
    const accumulation = new Float32Array(total);
    accumulation.fill(1);

    const neighbours = (r, c) => {
      const out = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 1 && nr < GRID_SIZE - 1 && nc >= 1 && nc < GRID_SIZE - 1) {
            out.push(nr * GRID_SIZE + nc);
          }
        }
      }
      return out;
    };

    const order = Array.from({ length: total }, (_, i) => i);
    order.sort((a, b) => values[b] - values[a]);

    for (const idx of order) {
      const row = Math.floor(idx / GRID_SIZE);
      const col = idx % GRID_SIZE;
      if (row < 1 || row >= GRID_SIZE - 1 || col < 1 || col >= GRID_SIZE - 1) continue;

      let best = -1;
      let bestHeight = values[idx];
      for (const n of neighbours(row, col)) {
        if (values[n] < bestHeight - 0.0015) {
          bestHeight = values[n];
          best = n;
        }
      }
      downstream[idx] = best;
    }

    for (const idx of order) {
      const next = downstream[idx];
      if (next >= 0) accumulation[next] += accumulation[idx];
    }

    let maxAccum = 1;
    for (let i = 0; i < total; i++) maxAccum = Math.max(maxAccum, accumulation[i]);

    const lowCut = percentile(values, 0.42);
    const deepCut = percentile(values, 0.25);
    const cells = [];

    for (let row = 0; row < GRID_SIZE - 1; row++) {
      for (let col = 0; col < GRID_SIZE - 1; col++) {
        const i = row * GRID_SIZE + col;
        const i2 = i + GRID_SIZE + 1;
        const avg = (values[i] + values[i + 1] + values[i + GRID_SIZE] + values[i2]) / 4;
        const acc = Math.max(
          accumulation[i],
          accumulation[i + 1],
          accumulation[i + GRID_SIZE],
          accumulation[i2]
        );
        const accNorm = clamp(Math.log1p(acc) / Math.log1p(maxAccum), 0, 1);
        const lowNorm = clamp((lowCut - avg) / Math.max(0.001, lowCut), 0, 1);
        const deepNorm = clamp((deepCut - avg) / Math.max(0.001, deepCut), 0, 1);

        // Broad basin score: low elevation + strong upstream accumulation.
        // This deliberately favours visible collected-water areas over thin channels.
        const basinScore = clamp(
          accNorm * 0.50 + lowNorm * 0.34 + deepNorm * 0.16,
          0,
          1
        );

        cells.push({ row, col, avg, accNorm, basinScore, deepNorm });
      }
    }

    return { values, cells };
  }, [heightData]);

  const cellCount = (GRID_SIZE - 1) * (GRID_SIZE - 1);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((state) => {
    if (!waterModel || !flowRef.current || !poolRef.current) return;

    const rainProgress = clamp(
      (simulationTime - 2.5) / (10.0 / Math.max(0.75, intensity)),
      0,
      1
    );
    const spread = clamp(rainProgress * 1.22, 0, 1);
    let flowIndex = 0;
    let poolIndex = 0;

    for (const cell of waterModel.cells) {
      const { row, col, avg, accNorm, basinScore, deepNorm } = cell;
      const x = ((col + 0.5) / (GRID_SIZE - 1) - 0.5) * TERRAIN_SIZE;
      const z = (0.5 - (row + 0.5) / (GRID_SIZE - 1)) * TERRAIN_SIZE;
      const terrainY = avg * MAX_TERRAIN_HEIGHT;

      // FLOW SHEET: shallow water follows accumulation channels.
      const flowActivation = clamp((accNorm - (0.12 - spread * 0.08)) / 0.62, 0, 1);
      const channelDepth = Math.pow(accNorm, 1.55) * 0.13 * spread * flowActivation;
      const flowDepth = clamp(channelDepth, 0, 0.15);
      const flowVisible = active && flowDepth > 0.006;
      const flowWave = 1 + Math.sin(state.clock.elapsedTime * 1.8 + row * 0.13 + col * 0.09) * 0.014;
      const flowFootprint = flowVisible
        ? (0.72 + clamp(flowDepth / 0.15, 0, 1) * 0.28) * flowWave
        : 0;

      dummy.position.set(x, terrainY + flowDepth + 0.035, z);
      dummy.scale.set(flowFootprint, flowFootprint, flowFootprint);
      dummy.updateMatrix();
      flowRef.current.setMatrixAt(flowIndex++, dummy.matrix);

      // POOL: deliberately wider and more opaque-looking than the moving sheet.
      // Low/deep cells start collecting later, then grow as rain continues.
      const poolActivation = clamp(
        (basinScore - (0.20 - spread * 0.18)) / 0.62,
        0,
        1
      );
      const poolDepth = clamp(
        (0.035 + Math.pow(poolActivation, 1.25) * 0.30 + deepNorm * 0.09) * spread,
        0,
        0.34
      );
      const poolVisible = active && poolDepth > 0.018;
      const poolWave = 1 + Math.sin(state.clock.elapsedTime * 0.75 + row * 0.06 + col * 0.05) * 0.012;
      const poolFootprint = poolVisible
        ? (0.92 + poolActivation * 0.42) * poolWave
        : 0;

      // Give collected water a slight local spread beyond one cell so pools read as
      // actual bodies of water rather than isolated blue squares.
      dummy.position.set(x, terrainY + poolDepth + 0.055, z);
      dummy.scale.set(poolFootprint, poolFootprint, poolFootprint);
      dummy.updateMatrix();
      poolRef.current.setMatrixAt(poolIndex++, dummy.matrix);
    }

    flowRef.current.count = flowIndex;
    poolRef.current.count = poolIndex;
    flowRef.current.instanceMatrix.needsUpdate = true;
    poolRef.current.instanceMatrix.needsUpdate = true;

    flowRef.current.material.opacity = active ? 0.34 : 0;
    poolRef.current.material.opacity = active ? 0.64 : 0;
  });

  useEffect(() => () => geometry.dispose(), [geometry]);

  if (!waterModel) return null;

  return (
    <>
      <instancedMesh
        ref={flowRef}
        args={[geometry, undefined, cellCount]}
        renderOrder={20}
        frustumCulled={false}
      >
        <meshStandardMaterial
          color="#147fd4"
          transparent
          opacity={0.34}
          roughness={0.10}
          metalness={0.05}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </instancedMesh>

      <instancedMesh
        ref={poolRef}
        args={[geometry, undefined, cellCount]}
        renderOrder={21}
        frustumCulled={false}
      >
        <meshStandardMaterial
          color="#0878c9"
          transparent
          opacity={0.64}
          roughness={0.04}
          metalness={0.08}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </instancedMesh>
    </>
  );
}

function FloodFlowParticles({ heightData, active, simulationTime, intensity = 1 }) {
  const ref = useRef();

  const values = useMemo(() => {
    if (!heightData?.length) return [];
    return smoothHeightMap(normalizeValues(heightData), GRID_SIZE, 2);
  }, [heightData]);

  /*
    Build deterministic downhill paths once from the terrain itself.
    Instead of random particles trying to guess a direction every frame,
    each water path walks to the lowest neighbouring cell. This gives a
    stable drainage network: ridge -> channel -> depression.
  */
  const streamNetwork = useMemo(() => {
    if (!values.length) return [];

    const paths = [];
    const stepCells = Math.max(5, Math.floor(GRID_SIZE / 12));
    const maxPath = 34;

    const toWorld = (row, col) => ({
      x: (col / (GRID_SIZE - 1) - 0.5) * TERRAIN_SIZE,
      z: (0.5 - row / (GRID_SIZE - 1)) * TERRAIN_SIZE,
    });

    const getNeighbours = (row, col) => {
      const result = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = row + dr;
          const nc = col + dc;
          if (
            nr >= 1 && nr < GRID_SIZE - 1 &&
            nc >= 1 && nc < GRID_SIZE - 1
          ) {
            result.push([nr, nc]);
          }
        }
      }
      return result;
    };

    for (let row = 4; row < GRID_SIZE - 4; row += stepCells) {
      for (let col = 4; col < GRID_SIZE - 4; col += stepCells) {
        let r = row;
        let c = col;
        const points = [];
        const visited = new Set();

        for (let k = 0; k < maxPath; k++) {
          const key = r * GRID_SIZE + c;
          if (visited.has(key)) break;
          visited.add(key);

          const world = toWorld(r, c);
          points.push({
            x: world.x,
            z: world.z,
            h: values[key],
          });

          const neighbours = getNeighbours(r, c);
          let best = null;
          let bestH = values[key];

          for (const [nr, nc] of neighbours) {
            const nh = values[nr * GRID_SIZE + nc];
            if (nh < bestH - 0.0025) {
              bestH = nh;
              best = [nr, nc];
            }
          }

          if (!best) break;
          r = best[0];
          c = best[1];
        }

        // Keep only meaningful channels. Very short paths are just flat noise.
        if (points.length >= 7) {
          paths.push({
            points,
            phase: (row * 0.73 + col * 1.17) % 1,
          });
        }
      }
    }

    return paths;
  }, [values]);

  const segmentCount = Math.max(1, streamNetwork.length * 5);
  const positions = useMemo(
    () => new Float32Array(segmentCount * 6),
    [segmentCount]
  );

  useFrame((state) => {
    if (!active || !ref.current || !streamNetwork.length) return;

    const progress = clamp((simulationTime - 2.8) / 9.0, 0, 1);
    const pos = ref.current.geometry.attributes.position.array;
    let write = 0;

    for (const stream of streamNetwork) {
      const points = stream.points;
      if (points.length < 2) continue;

      // A moving packet travels from the source toward the depression.
      const travel = (state.clock.elapsedTime * (0.65 + intensity * 0.45) + stream.phase * 8) % Math.max(1, points.length - 1);
      const headIndex = Math.floor(travel);
      const local = travel - headIndex;

      // Each channel gets several short connected segments, creating a
      // visible stream rather than one long artificial line.
      const visibleSegments = Math.min(5, points.length - 1);

      for (let j = 0; j < visibleSegments; j++) {
        const idx = headIndex - j;
        const wrapped = ((idx % (points.length - 1)) + (points.length - 1)) % (points.length - 1);
        const a = points[wrapped];
        const b = points[wrapped + 1];
        const fade = 1 - j / visibleSegments;

        // Only show channels that have been reached by the simulated
        // water front. As time increases, progressively higher parts of
        // the drainage network become active.
        const floodFront = clamp(
          0.06 + Math.max(0, simulationTime - 2.5) * 0.0030 * Math.max(0.75, intensity),
          0.06,
          0.46
        );
        const reach = floodFront + 0.035 + progress * 0.18;
        if (progress <= 0.02 || fade < 0.16 || a.h > reach) continue;

        const ax = a.x;
        const az = a.z;
        const bx = THREE.MathUtils.lerp(a.x, b.x, local);
        const bz = THREE.MathUtils.lerp(a.z, b.z, local);
        const ah = a.h * MAX_TERRAIN_HEIGHT + 0.13;
        const bh = THREE.MathUtils.lerp(a.h, b.h, local) * MAX_TERRAIN_HEIGHT + 0.13;

        pos[write++] = ax;
        pos[write++] = ah;
        pos[write++] = az;
        pos[write++] = bx;
        pos[write++] = bh;
        pos[write++] = bz;
      }
    }

    // Clear unused segments so old trails never remain on screen.
    for (; write < pos.length; write++) pos[write] = 0;
    ref.current.geometry.attributes.position.needsUpdate = true;
  });

  if (!active || !streamNetwork.length) return null;

  return (
    <lineSegments ref={ref} renderOrder={27}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={positions.length / 3}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <lineBasicMaterial
        color="#8feaff"
        transparent
        opacity={0.82}
        linewidth={1}
        depthWrite={false}
      />
    </lineSegments>
  );
}

function FloodRiskOverlay({ heightData, active, simulationTime, intensity = 1 }) {
  const meshRef = useRef();
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(
      TERRAIN_SIZE / (GRID_SIZE - 1) * 0.94,
      TERRAIN_SIZE / (GRID_SIZE - 1) * 0.94
    );
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, []);

  const values = useMemo(() => {
    if (!heightData?.length) return [];
    return smoothHeightMap(normalizeValues(heightData), GRID_SIZE, 2);
  }, [heightData]);

  const cellCount = (GRID_SIZE - 1) * (GRID_SIZE - 1);
  const riskColors = useMemo(() => ({
    low: new THREE.Color('#38d9a9'),
    medium: new THREE.Color('#ffd166'),
    high: new THREE.Color('#ff5c5c'),
  }), []);

  useFrame((state) => {
    if (!meshRef.current || !values.length) return;

    const rainDelay = Math.max(0, simulationTime - 2.5);
    const floodFront = clamp(
      0.06 + rainDelay * 0.0028 * Math.max(0.75, intensity),
      0.06,
      0.46
    );
    const dummy = new THREE.Object3D();
    let index = 0;

    for (let row = 0; row < GRID_SIZE - 1; row++) {
      for (let col = 0; col < GRID_SIZE - 1; col++) {
        const i = row * GRID_SIZE + col;
        const avg = (
          values[i] + values[i + 1] + values[i + GRID_SIZE] + values[i + GRID_SIZE + 1]
        ) / 4;

        // Local slope: steep terrain tends to shed water, while flatter
        // low terrain is more likely to retain water.
        const left = values[i - 1] ?? avg;
        const right = values[i + 1] ?? avg;
        const up = values[i - GRID_SIZE] ?? avg;
        const down = values[i + GRID_SIZE] ?? avg;
        const slope = clamp(
          (Math.abs(right - left) + Math.abs(down - up)) * 2.6,
          0,
          1
        );

        const lowFactor = clamp((0.48 - avg) / 0.48, 0, 1);
        const accumulation = clamp((floodFront - avg) / 0.16, 0, 1);
        const retention = lowFactor * (1 - slope * 0.52);
        const risk = clamp(
          retention * 0.52 + accumulation * 0.48,
          0,
          1
        );

        const visibleRisk = active && simulationTime >= 2.5 ? risk : 0;
        const pulse = 0.96 + Math.sin(state.clock.elapsedTime * 1.4 + row * 0.08 + col * 0.05) * 0.02;
        const footprint = visibleRisk > 0.08
          ? clamp(0.58 + visibleRisk * 0.42, 0, 1) * pulse
          : 0;

        const x = ((col + 0.5) / (GRID_SIZE - 1) - 0.5) * TERRAIN_SIZE;
        const z = (0.5 - (row + 0.5) / (GRID_SIZE - 1)) * TERRAIN_SIZE;
        const y = avg * MAX_TERRAIN_HEIGHT + 0.16;

        dummy.position.set(x, y, z);
        dummy.scale.set(footprint, footprint, footprint);
        dummy.updateMatrix();
        meshRef.current.setMatrixAt(index, dummy.matrix);

        const color = risk >= 0.68
          ? riskColors.high
          : risk >= 0.38
            ? riskColors.medium
            : riskColors.low;
        meshRef.current.setColorAt(index, color);
        index++;
      }
    }

    meshRef.current.count = index;
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
    meshRef.current.material.opacity = active ? 0.24 : 0;
  });

  useEffect(() => () => geometry.dispose(), [geometry]);

  if (!values.length) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, undefined, cellCount]}
      renderOrder={18}
      frustumCulled={false}
    >
      <meshBasicMaterial
        vertexColors
        transparent
        opacity={0.24}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </instancedMesh>
  );
}

function FloodSimulationHUD({ active, floodTime }) {
  if (!active) return null;

  const progress = clamp((floodTime / 18.0) * 100, 0, 100);
  const stage =
    progress < 22
      ? "RAINFALL"
      : progress < 48
        ? "WATER GENERATION"
        : progress < 72
          ? "DOWNSLOPE FLOW"
          : "FLOOD ACCUMULATION";

  return (
    <div
      style={{
        position: "absolute",
        left: 18,
        bottom: 18,
        zIndex: 40,
        width: "min(430px, calc(100% - 36px))",
        padding: "11px 14px",
        border: "1px solid rgba(24, 217, 255, 0.45)",
        background: "rgba(2, 18, 27, 0.78)",
        backdropFilter: "blur(7px)",
        boxShadow: "0 0 22px rgba(24, 217, 255, 0.08)",
        pointerEvents: "none",
        color: "#76b8c9",
        fontSize: 10,
        letterSpacing: "1.4px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span>DISASTER SIMULATION</span>
        <strong style={{ color: "#18d9ff" }}>{stage}</strong>
      </div>
      <div style={{ height: 4, margin: "9px 0 8px", background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <div style={{ width: `${progress}%`, height: "100%", background: "#18d9ff", boxShadow: "0 0 10px rgba(24,217,255,0.65)", transition: "width 0.15s linear" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span>SIM TIME {floodTime.toFixed(1)}s</span>
        <span>RISK ANALYSIS ACTIVE</span>
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 9, alignItems: "center" }}>
        <span style={{ color: "#38d9a9" }}>● LOW</span>
        <span style={{ color: "#ffd166" }}>● MODERATE</span>
        <span style={{ color: "#ff5c5c" }}>● HIGH</span>
      </div>
    </div>
  );
}

/* =======================================================
   3D SCENE
   ======================================================= */

function Scene({
  heightData,
  highlight,
  flythrough,
  satelliteImage,
  selectedMapArea,
  virtualScene,
  floodSimulation,
  floodTime,
}) {
  return (
    <>
      <color
        attach="background"
        args={[virtualScene ? "#031622" : "#071014"]}
      />

      <ambientLight intensity={2.5} />

      <directionalLight
        position={[18, 32, 12]}
        intensity={3.2}
        castShadow
      />

      <directionalLight
        position={[-25, 18, -20]}
        intensity={1.45}
      />

      <hemisphereLight
        intensity={1.05}
      />

      <Terrain
        heightData={heightData}
        highlight={highlight}
        flythrough={flythrough}
        satelliteImage={satelliteImage}
      />

      {virtualScene && (
        <BlueprintScene heightData={heightData} />
      )}

      <RainField active={floodSimulation} intensity={1.35} />
      <FloodWater
        heightData={heightData}
        active={floodSimulation}
        simulationTime={floodTime}
        intensity={1.35}
      />
      <FloodFlowParticles
        heightData={heightData}
        active={floodSimulation}
        simulationTime={floodTime}
        intensity={1.35}
      />
      <FloodRiskOverlay
        heightData={heightData}
        active={floodSimulation}
        simulationTime={floodTime}
        intensity={1.35}
      />

      {selectedMapArea && (
        <MapFeatures3D
          bounds={selectedMapArea.bounds}
          buildings={selectedMapArea.buildings}
          roads={selectedMapArea.roads}
          water={selectedMapArea.water}
          heightData={heightData}
        />
      )}

      <Grid
        args={[
          TERRAIN_SIZE,
          TERRAIN_SIZE,
        ]}
        position={[
          0,
          -0.12,
          0,
        ]}
        cellSize={5}
        sectionSize={10}
        fadeDistance={90}
        fadeStrength={0.65}
      />

      {!flythrough && (
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          minDistance={20}
          maxDistance={120}
          maxPolarAngle={1.43}
          target={[0, 2, 0]}
        />
      )}
    </>
  );
}

/* =======================================================
   DEPTH MAP
   ======================================================= */

function DepthMap({ heightData }) {
  const src = useMemo(() => {
    if (!heightData?.length) return null;

    const canvas =
      document.createElement("canvas");

    canvas.width = GRID_SIZE;
    canvas.height = GRID_SIZE;

    const ctx =
      canvas.getContext("2d");

    const imageData =
      ctx.createImageData(
        GRID_SIZE,
        GRID_SIZE
      );

    for (
      let i = 0;
      i < heightData.length;
      i++
    ) {
      const v =
        clamp(heightData[i], 0, 1);

      let r;
      let g;
      let b;

      if (v < 0.25) {
        const t = v / 0.25;
        r = 5;
        g = 35 + t * 70;
        b = 90 + t * 90;
      } else if (v < 0.5) {
        const t =
          (v - 0.25) / 0.25;
        r = 10;
        g = 105 + t * 100;
        b = 180 - t * 100;
      } else if (v < 0.75) {
        const t =
          (v - 0.5) / 0.25;
        r = 10 + t * 210;
        g = 205 - t * 50;
        b = 80 - t * 70;
      } else {
        const t =
          (v - 0.75) / 0.25;
        r = 220 + t * 35;
        g = 155 + t * 100;
        b = 10 + t * 80;
      }

      imageData.data[i * 4] =
        Math.round(r);

      imageData.data[i * 4 + 1] =
        Math.round(g);

      imageData.data[i * 4 + 2] =
        Math.round(b);

      imageData.data[i * 4 + 3] = 255;
    }

    ctx.putImageData(
      imageData,
      0,
      0
    );

    return canvas.toDataURL(
      "image/png"
    );
  }, [heightData]);

  if (!src) {
    return (
      <div className="empty-state">
        <div>DEPTH MAP NOT AVAILABLE</div>
        <small>
          Upload and analyze a satellite optical image first.
        </small>
      </div>
    );
  }

  return (
    <div className="depth-preview">
      <img
        src={src}
        alt="Relative depth map"
      />
      <div className="depth-label">
        RELATIVE DEPTH
      </div>
    </div>
  );
}

/* =======================================================
   DEMO RGB
   ======================================================= */

function createDemoRGB() {
  const canvas =
    document.createElement("canvas");

  const width = 1000;
  const height = 650;

  canvas.width = width;
  canvas.height = height;

  const ctx =
    canvas.getContext("2d");

  const imageData =
    ctx.createImageData(
      width,
      height
    );

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const ny = y / height;

      const hill1 =
        Math.exp(
          -(
            Math.pow(
              (nx - 0.28) * 3.0,
              2
            ) +
            Math.pow(
              (ny - 0.43) * 2.8,
              2
            )
          )
        );

      const hill2 =
        Math.exp(
          -(
            Math.pow(
              (nx - 0.72) * 3.5,
              2
            ) +
            Math.pow(
              (ny - 0.34) * 3.0,
              2
            )
          )
        );

      const hill3 =
        Math.exp(
          -(
            Math.pow(
              (nx - 0.52) * 5.5,
              2
            ) +
            Math.pow(
              (ny - 0.72) * 4.5,
              2
            )
          )
        );

      const ridge =
        0.5 +
        0.5 *
          Math.sin(
            nx * 11 +
              Math.sin(ny * 6) * 2.2
          );

      const value =
        clamp(
          0.12 +
            hill1 * 0.48 +
            hill2 * 0.38 +
            hill3 * 0.26 +
            ridge * 0.09,
          0,
          1
        );

      const riverDistance =
        Math.abs(
          nx -
            (
              0.53 +
              Math.sin(ny * 9) *
                0.07
            )
        );

      const isWater =
        riverDistance < 0.018;

      let r;
      let g;
      let b;

      if (isWater) {
        r = 28;
        g = 110;
        b = 165;
      } else {
        /*
          Brighter hill regions make the demo's relative
          depth proxy visibly produce terrain relief.
        */
        r = 32 + value * 75;
        g = 62 + value * 112;
        b = 32 + value * 42;
      }

      const index =
        (y * width + x) * 4;

      imageData.data[index] =
        Math.round(r);

      imageData.data[index + 1] =
        Math.round(g);

      imageData.data[index + 2] =
        Math.round(b);

      imageData.data[index + 3] = 255;
    }
  }

  ctx.putImageData(
    imageData,
    0,
    0
  );

  /* roads */
  ctx.strokeStyle =
    "rgba(225,220,195,0.72)";
  ctx.lineWidth = 12;

  ctx.beginPath();
  ctx.moveTo(30, 560);
  ctx.bezierCurveTo(
    230,
    470,
    380,
    520,
    560,
    380
  );
  ctx.bezierCurveTo(
    710,
    270,
    820,
    290,
    970,
    130
  );
  ctx.stroke();

  ctx.strokeStyle =
    "rgba(210,205,180,0.48)";
  ctx.lineWidth = 7;

  ctx.beginPath();
  ctx.moveTo(80, 90);
  ctx.bezierCurveTo(
    280,
    210,
    430,
    170,
    700,
    540
  );
  ctx.stroke();

  /* buildings */
  const buildings = [
    [190, 370, 45, 32],
    [250, 390, 32, 42],
    [315, 350, 48, 35],
    [735, 390, 50, 38],
    [800, 355, 35, 50],
    [850, 410, 55, 34],
    [610, 170, 40, 32],
    [665, 145, 48, 38],
  ];

  for (const [x, y, w, h] of buildings) {
    ctx.fillStyle =
      "rgba(190,190,175,0.85)";
    ctx.fillRect(x, y, w, h);

    ctx.strokeStyle =
      "rgba(50,55,45,0.7)";
    ctx.strokeRect(x, y, w, h);
  }

  ctx.globalAlpha = 0.14;

  for (let i = 0; i < 250; i++) {
    const x = (i * 73) % width;
    const y = (i * 137) % height;

    ctx.fillStyle =
      i % 2 === 0
        ? "#ffffff"
        : "#182218";

    ctx.fillRect(x, y, 2, 2);
  }

  ctx.globalAlpha = 1;

  return canvas.toDataURL(
    "image/png"
  );
}

/* =======================================================
   IMAGE → RELATIVE DEPTH PROXY
   ======================================================= */

function generateHeightMap(src) {
  return new Promise(
    (resolve, reject) => {
      const img =
        new Image();

      if (
        src.startsWith("http://") ||
        src.startsWith("https://")
      ) {
        img.crossOrigin =
          "anonymous";
      }

      img.onload = () => {
        try {
          const canvas =
            document.createElement("canvas");

          canvas.width = GRID_SIZE;
          canvas.height = GRID_SIZE;

          const ctx =
            canvas.getContext(
              "2d",
              {
                willReadFrequently: true,
              }
            );

          ctx.drawImage(
            img,
            0,
            0,
            GRID_SIZE,
            GRID_SIZE
          );

          const pixels =
            ctx.getImageData(
              0,
              0,
              GRID_SIZE,
              GRID_SIZE
            ).data;

          const raw =
            new Array(
              GRID_SIZE * GRID_SIZE
            ).fill(0);

          for (
            let row = 0;
            row < GRID_SIZE;
            row++
          ) {
            for (
              let col = 0;
              col < GRID_SIZE;
              col++
            ) {
              const i =
                row * GRID_SIZE + col;

              const p = i * 4;

              const r =
                pixels[p] / 255;

              const g =
                pixels[p + 1] / 255;

              const b =
                pixels[p + 2] / 255;

              const luminance =
                0.299 * r +
                0.587 * g +
                0.114 * b;

              const left =
                col > 0
                  ? (
                      0.299 *
                        pixels[(i - 1) * 4] /
                        255 +
                      0.587 *
                        pixels[(i - 1) * 4 + 1] /
                        255 +
                      0.114 *
                        pixels[(i - 1) * 4 + 2] /
                        255
                    )
                  : luminance;

              const right =
                col < GRID_SIZE - 1
                  ? (
                      0.299 *
                        pixels[(i + 1) * 4] /
                        255 +
                      0.587 *
                        pixels[(i + 1) * 4 + 1] /
                        255 +
                      0.114 *
                        pixels[(i + 1) * 4 + 2] /
                        255
                    )
                  : luminance;

              const up =
                row > 0
                  ? (
                      0.299 *
                        pixels[(i - GRID_SIZE) * 4] /
                        255 +
                      0.587 *
                        pixels[(i - GRID_SIZE) * 4 + 1] /
                        255 +
                      0.114 *
                        pixels[(i - GRID_SIZE) * 4 + 2] /
                        255
                    )
                  : luminance;

              const down =
                row < GRID_SIZE - 1
                  ? (
                      0.299 *
                        pixels[(i + GRID_SIZE) * 4] /
                        255 +
                      0.587 *
                        pixels[(i + GRID_SIZE) * 4 + 1] /
                        255 +
                      0.114 *
                        pixels[(i + GRID_SIZE) * 4 + 2] /
                        255
                    )
                  : luminance;

              const gradient =
                Math.sqrt(
                  Math.pow(
                    right - left,
                    2
                  ) +
                  Math.pow(
                    down - up,
                    2
                  )
                );

              /*
                Browser-only relative depth proxy.
                Broad luminance gives relief;
                a small gradient term preserves terrain
                structure without creating spikes.
              */
              raw[i] =
                luminance * 0.88 +
                clamp(
                  gradient * 1.7,
                  0,
                  1
                ) * 0.12;
            }
          }

          const normalized = normalizeValues(raw);

          // Multi-scale terrain reconstruction. The broad pass captures
          // large landforms while the light-detail pass restores ridges,
          // valleys and boundaries lost by a single heavy blur.
          const broad = smoothHeightMap(
            normalized,
            GRID_SIZE,
            4
          );
          const detailBase = smoothHeightMap(
            normalized,
            GRID_SIZE,
            1
          );

          const fused = broad.map((base, i) => {
            const detail = detailBase[i] - broad[i];
            return clamp(base + detail * 0.62, 0, 1);
          });

          // A gentle local-contrast curve improves relief without turning
          // bright image artifacts into needle-like mountains.
          const finalValues = fused.map((value) => {
            const shaped = Math.pow(
              clamp(value, 0, 1),
              0.88
            );

            return clamp(
              0.018 + shaped * 0.964,
              0.018,
              0.982
            );
          });

          const min = Math.min(...finalValues);
          const max = Math.max(...finalValues);
          const avg =
            finalValues.reduce(
              (a, b) => a + b,
              0
            ) / finalValues.length;

          resolve({
            heights: finalValues,
            stats: {
              min: min * 100,
              max: max * 100,
              avg: avg * 100,
            },
          });
        } catch (error) {
          reject(error);
        }
      };

      img.onerror = () => {
        reject(
          new Error(
            "Unable to read image."
          )
        );
      };

      img.src = src;
    }
  );
}

/* =======================================================
   APP
   ======================================================= */

export default function App() {
  const [image, setImage] =
    useState(null);

  const [satelliteImage, setSatelliteImage] =
    useState(null);

  const [heightData, setHeightData] =
    useState(null);

  const [elevationData, setElevationData] =
    useState(null);

  const [terrainStats, setTerrainStats] =
    useState(null);

  const [mode, setMode] =
    useState("MAP");

  const [highlight, setHighlight] =
    useState(null);

  const [flythrough, setFlythrough] =
    useState(false);

  const [virtualScene, setVirtualScene] =
    useState(false);

  const [floodSimulation, setFloodSimulation] =
    useState(false);

  const [floodTime, setFloodTime] =
    useState(0);

  useEffect(() => {
    if (!floodSimulation) return;
    const timer = setInterval(() => {
      setFloodTime((value) => value + 0.1);
    }, 100);
    return () => clearInterval(timer);
  }, [floodSimulation]);

  const [processing, setProcessing] =
    useState(false);

  const [elevationLoading, setElevationLoading] =
    useState(false);

  const [answer, setAnswer] =
    useState(
      "Upload a satellite optical image or select an area from the map."
    );

  const [query, setQuery] =
    useState("");

  const [selectedMapArea, setSelectedMapArea] =
    useState(null);

  const imageUrlRef =
    useRef(null);

  const demoRgbRef =
    useRef(null);

  useEffect(() => {
    return () => {
      if (imageUrlRef.current) {
        URL.revokeObjectURL(
          imageUrlRef.current
        );
      }
    };
  }, []);

  /* ---------------------------------------------------
     DEMO RGB
  --------------------------------------------------- */

  const loadDemoRGB = () => {
    if (!demoRgbRef.current) {
      demoRgbRef.current =
        createDemoRGB();
    }

    setImage(
      demoRgbRef.current
    );

    setSatelliteImage(
      demoRgbRef.current
    );

    setHeightData(null);
    setElevationData(null);
    setTerrainStats(null);
    setSelectedMapArea(null);
    setHighlight(null);
    setFlythrough(false);
    setMode("IMAGE");

    setAnswer(
      "Demo satellite optical image loaded. Click ANALYZE TERRAIN."
    );
  };

  /* ---------------------------------------------------
     IMAGE UPLOAD
  --------------------------------------------------- */

  const handleImageUpload =
    (event) => {
      const file =
        event.target.files?.[0];

      if (!file) return;

      if (
        !file.type.startsWith("image/")
      ) {
        setAnswer(
          "Please select a valid satellite optical image."
        );
        return;
      }

      if (imageUrlRef.current) {
        URL.revokeObjectURL(
          imageUrlRef.current
        );
      }

      const url =
        URL.createObjectURL(file);

      imageUrlRef.current = url;

      setImage(url);
      setSatelliteImage(url);
      setSelectedMapArea(null);
      setHeightData(null);
      setElevationData(null);
      setTerrainStats(null);
      setHighlight(null);
      setFlythrough(false);
      setMode("IMAGE");

      setAnswer(
        "Satellite optical image loaded. Click ANALYZE TERRAIN."
      );

      event.target.value = "";
    };

  /* ---------------------------------------------------
     SATELLITE IMAGE
  --------------------------------------------------- */

  const createSatelliteImageUrl =
    (bounds) => {
      const bbox = [
        bounds.west,
        bounds.south,
        bounds.east,
        bounds.north,
      ].join(",");

      return (
        "https://server.arcgisonline.com/ArcGIS/" +
        "rest/services/World_Imagery/MapServer/export" +
        `?bbox=${bbox}` +
        "&bboxSR=4326" +
        "&size=1200,800" +
        "&imageSR=4326" +
        "&format=jpg" +
        "&f=image"
      );
    };

  /* ---------------------------------------------------
     MAP FALLBACK
  --------------------------------------------------- */

  const createFallbackTerrain =
    () => {
      const values =
        new Array(
          GRID_SIZE * GRID_SIZE
        );

      for (
        let row = 0;
        row < GRID_SIZE;
        row++
      ) {
        for (
          let col = 0;
          col < GRID_SIZE;
          col++
        ) {
          const x =
            col / (GRID_SIZE - 1);

          const y =
            row / (GRID_SIZE - 1);

          const hill =
            Math.exp(
              -(
                Math.pow(
                  x - 0.32,
                  2
                ) * 18 +
                Math.pow(
                  y - 0.40,
                  2
                ) * 16
              )
            );

          const ridge =
            Math.sin(x * 10) *
            Math.cos(y * 8) *
            0.08;

          values[
            row * GRID_SIZE + col
          ] =
            0.30 +
            hill * 0.40 +
            ridge;
        }
      }

      return normalizeValues(
        values
      );
    };

  /* ---------------------------------------------------
     ELEVATION
  --------------------------------------------------- */

  const loadElevationForArea =
    async (bounds) => {
      setElevationLoading(true);
      setAnswer(
        "Loading elevation data..."
      );

      try {
        const sampleSize = 12;
        const latitudes = [];
        const longitudes = [];

        for (
          let row = 0;
          row < sampleSize;
          row++
        ) {
          const lat =
            bounds.south +
            ((bounds.north - bounds.south) *
              row) /
              (sampleSize - 1);

          for (
            let col = 0;
            col < sampleSize;
            col++
          ) {
            const lon =
              bounds.west +
              ((bounds.east - bounds.west) *
                col) /
                (sampleSize - 1);

            latitudes.push(
              lat.toFixed(6)
            );

            longitudes.push(
              lon.toFixed(6)
            );
          }
        }

        const url =
          "https://api.open-meteo.com/v1/elevation" +
          `?latitude=${latitudes.join(",")}` +
          `&longitude=${longitudes.join(",")}`;

        const response =
          await fetch(url);

        if (!response.ok) {
          throw new Error(
            "Elevation service unavailable."
          );
        }

        const json =
          await response.json();

        const raw =
          Array.isArray(
            json.elevation
          )
            ? json.elevation.map(Number)
            : [];

        if (
          raw.length !==
          sampleSize * sampleSize
        ) {
          throw new Error(
            "Invalid elevation response."
          );
        }

        const min =
          Math.min(...raw);

        const max =
          Math.max(...raw);

        const avg =
          raw.reduce(
            (a, b) => a + b,
            0
          ) / raw.length;

        const normalized =
          normalizeValues(raw);

        const resized =
          new Array(
            GRID_SIZE * GRID_SIZE
          );

        for (
          let row = 0;
          row < GRID_SIZE;
          row++
        ) {
          for (
            let col = 0;
            col < GRID_SIZE;
            col++
          ) {
            const sourceRow =
              Math.round(
                (row /
                  (GRID_SIZE - 1)) *
                  (sampleSize - 1)
              );

            const sourceCol =
              Math.round(
                (col /
                  (GRID_SIZE - 1)) *
                  (sampleSize - 1)
              );

            resized[
              row * GRID_SIZE + col
            ] =
              normalized[
                sourceRow * sampleSize +
                  sourceCol
              ];
          }
        }

        const smoothed =
          smoothHeightMap(
            resized,
            GRID_SIZE,
            5
          );

        setHeightData(
          smoothed
        );

        setElevationData(
          raw
        );

        setTerrainStats({
          min,
          max,
          avg,
        });

        setAnswer(
          "Elevation data loaded. 3D terrain is ready."
        );
      } catch (error) {
        console.warn(error);

        const fallback =
          createFallbackTerrain();

        setHeightData(
          fallback
        );

        setElevationData(null);

        setTerrainStats({
          min: 0,
          max: 100,
          avg:
            (fallback.reduce(
              (a, b) => a + b,
              0
            ) /
              fallback.length) *
            100,
        });

        setAnswer(
          "Elevation service unavailable. Showing relative terrain preview."
        );
      } finally {
        setElevationLoading(false);
      }
    };

  /* ---------------------------------------------------
     MAP AREA
  --------------------------------------------------- */

  const handleMapAreaSelected =
    async (data) => {
      const {
        bounds,
        buildings = [],
        roads = [],
        water = [],
      } = data;

      setSelectedMapArea({
        bounds,
        buildings,
        roads,
        water,
      });

      setImage(null);

      setSatelliteImage(
        createSatelliteImageUrl(
          bounds
        )
      );

      setHeightData(null);
      setElevationData(null);
      setTerrainStats(null);
      setHighlight(null);
      setFlythrough(false);
      setMode("MAP");

      await loadElevationForArea(
        bounds
      );
    };

  /* ---------------------------------------------------
     ANALYZE
  --------------------------------------------------- */

  const analyze = async () => {
    if (processing) return;

    setProcessing(true);
    setHighlight(null);
    setFlythrough(false);

    try {
      if (selectedMapArea) {
        if (!heightData) {
          await loadElevationForArea(
            selectedMapArea.bounds
          );
        }

        setMode("3D");

        setAnswer(
          "Terrain analyzed. Use Highest, Lowest, Steepest or Flythrough."
        );

        return;
      }

      if (!image) {
        setAnswer(
          "Upload a satellite optical image first."
        );
        return;
      }

      const result =
        await generateHeightMap(
          image
        );

      setHeightData(
        result.heights
      );

      setElevationData(null);

      setTerrainStats(
        result.stats
      );

      setMode("3D");

      setAnswer(
        "Relative depth generated. 3D terrain is ready."
      );
    } catch (error) {
      console.error(error);

      setAnswer(
        "Image analysis failed. Please try another satellite optical image."
      );
    } finally {
      setProcessing(false);
    }
  };

  /* ---------------------------------------------------
     3D
  --------------------------------------------------- */

  const open3D = () => {
    if (!heightData) {
      setAnswer(
        "Analyze terrain first."
      );
      return;
    }

    setFlythrough(false);
    setHighlight(null);
    setMode("3D");
    setVirtualScene(false);
    setFloodSimulation(false);
    setFloodTime(0);

    setAnswer(
      "Interactive 3D terrain ready. Drag to rotate and scroll to zoom."
    );
  };

  /* ---------------------------------------------------
     VIRTUAL SCENE
  --------------------------------------------------- */

  const openVirtualScene = () => {
    if (!heightData) {
      setAnswer(
        "Analyze terrain first."
      );
      return;
    }

    const next = !virtualScene;

    setFlythrough(false);
    setHighlight(null);
    setMode("3D");
    setVirtualScene(next);
    setFloodSimulation(next);
    setFloodTime(next ? 0 : 0);

    setAnswer(
      next
        ? "Virtual disaster scene active — blueprint terrain, heavy rain, downhill water flow and low-area flood accumulation are running."
        : "Virtual disaster scene stopped. Original 3D terrain restored."
    );
  };

  /* ---------------------------------------------------
     FLYTHROUGH
  --------------------------------------------------- */

  const startFlythrough = () => {
    if (!heightData) {
      setAnswer(
        "Analyze terrain first."
      );
      return;
    }

    const next =
      !flythrough;

    setFlythrough(next);
    setMode("3D");
    setHighlight(null);
    setVirtualScene(false);
    setFloodSimulation(false);
    setFloodTime(0);

    setAnswer(
      next
        ? "Flythrough active — cinematic terrain survey."
        : "Flythrough stopped. Orbit mode restored."
    );
  };

  /* ---------------------------------------------------
     ANALYSIS
  --------------------------------------------------- */

  const activateHighlight =
    (type) => {
      if (!heightData) {
        setAnswer(
          "Analyze terrain first."
        );
        return;
      }

      setFlythrough(false);
      setMode("3D");
      setHighlight(type);

      const summary =
        getAnalysisSummary(
          heightData,
          type
        );

      if (type === "highest") {
        setAnswer(
          summary
            ? `Highest terrain region: ${summary.length.toFixed(1)} scene units long, ${summary.depth.toFixed(1)} relative units of relief.`
            : "Highest terrain regions highlighted in yellow."
        );
      }

      if (type === "lowest") {
        setAnswer(
          summary
            ? `Lowest terrain region: ${summary.length.toFixed(1)} scene units long, ${summary.depth.toFixed(1)} relative units of relief.`
            : "Lowest terrain regions highlighted in blue."
        );
      }

      if (type === "steepest") {
        setAnswer(
          summary
            ? `Steepest terrain region: ${summary.length.toFixed(1)} scene units long, ${summary.depth.toFixed(1)} relative units of relief.`
            : "Steepest terrain regions highlighted in red."
        );
      }
    };

  /* ---------------------------------------------------
     MODE
  --------------------------------------------------- */

  const changeMode =
    (nextMode) => {
      if (
        nextMode === "3D" &&
        !heightData
      ) {
        setAnswer(
          "Analyze terrain first."
        );
        return;
      }

      if (
        nextMode === "DEPTH" &&
        !heightData
      ) {
        setAnswer(
          "Analyze terrain first."
        );
        return;
      }

      setFlythrough(false);
      if (nextMode !== "3D") {
        setVirtualScene(false);
        setFloodSimulation(false);
        setFloodTime(0);
      }
      setMode(nextMode);
    };

  /* ---------------------------------------------------
     AI ASSISTANT
  --------------------------------------------------- */

  const askAI = () => {
    const q =
      query
        .trim()
        .toLowerCase();

    if (!q) {
      setAnswer(
        "Ask about highest, lowest, steepest, flythrough or terrain."
      );
      return;
    }

    if (
      q.includes("highest") ||
      q.includes("high")
    ) {
      activateHighlight(
        "highest"
      );
      return;
    }

    if (
      q.includes("lowest") ||
      q.includes("low")
    ) {
      activateHighlight(
        "lowest"
      );
      return;
    }

    if (
      q.includes("steep")
    ) {
      activateHighlight(
        "steepest"
      );
      return;
    }

    if (
      q.includes("fly") ||
      q.includes("tour")
    ) {
      startFlythrough();
      return;
    }

    if (
      q.includes("3d") ||
      q.includes("terrain")
    ) {
      open3D();
      return;
    }

    setAnswer(
      "Try: highest areas, lowest areas, steepest areas, 3D terrain or flythrough."
    );
  };

  /* ---------------------------------------------------
     STATS
  --------------------------------------------------- */

  const displayStats =
    useMemo(() => {
      if (elevationData?.length) {
        const min =
          Math.min(
            ...elevationData
          );

        const max =
          Math.max(
            ...elevationData
          );

        const avg =
          elevationData.reduce(
            (a, b) => a + b,
            0
          ) /
          elevationData.length;

        return {
          min,
          max,
          avg,
          unit: "m",
        };
      }

      if (terrainStats) {
        return {
          min: terrainStats.min,
          max: terrainStats.max,
          avg: terrainStats.avg,
          unit: "relative",
        };
      }

      return null;
    }, [
      elevationData,
      terrainStats,
    ]);

  const highlightedSummary =
    useMemo(
      () =>
        getAnalysisSummary(
          heightData,
          highlight
        ),
      [heightData, highlight]
    );

  return (
    <div className="app-shell">

      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">
            LOKA 3D
          </div>

          <div className="brand-subtitle">
            DEPTHWIZARD · TERRAIN
            <br />
            INTELLIGENCE
          </div>
        </div>

        <section className="side-section">
          <div className="section-title">
            INPUT DATA
          </div>

          <label className="upload-btn">
            UPLOAD SATELLITE IMAGE

            <input
              type="file"
              accept="image/*"
              onChange={
                handleImageUpload
              }
              hidden
            />
          </label>

          <button
            className="demo-btn"
            onClick={
              loadDemoRGB
            }
          >
            LOAD DEMO IMAGE
          </button>

          <button
            className="analyze-btn"
            onClick={analyze}
            disabled={
              processing ||
              elevationLoading
            }
          >
            {processing ||
            elevationLoading
              ? "ANALYZING..."
              : "ANALYZE TERRAIN"}
          </button>
        </section>

        <section className="side-section">
          <div className="section-title">
            VISUALIZATION
          </div>

          <div className="mode-grid">
            <button
              className={
                mode === "MAP"
                  ? "mode-btn active"
                  : "mode-btn"
              }
              onClick={() =>
                changeMode("MAP")
              }
            >
              MAP
            </button>

            <button
              className={
                mode === "IMAGE"
                  ? "mode-btn active"
                  : "mode-btn"
              }
              onClick={() =>
                changeMode("IMAGE")
              }
              disabled={!image}
            >
              IMAGE
            </button>

            <button
              className={
                mode === "DEPTH"
                  ? "mode-btn active"
                  : "mode-btn"
              }
              onClick={() =>
                changeMode("DEPTH")
              }
              disabled={!heightData}
            >
              DEPTH
            </button>

            <button
              className={
                mode === "3D"
                  ? "mode-btn active"
                  : "mode-btn"
              }
              onClick={open3D}
              disabled={!heightData}
            >
              3D TERRAIN
            </button>

            <button
              className={
                virtualScene
                  ? "mode-btn active"
                  : "mode-btn"
              }
              onClick={openVirtualScene}
              disabled={!heightData}
            >
              {virtualScene ? "■ STOP VIRTUAL SCENE" : "🔷 VIRTUAL SCENE"}
            </button>

          </div>
        </section>

        <section className="side-section">
          <div className="section-title">
            TERRAIN ANALYSIS
          </div>

          <button
            className={
              highlight === "highest"
                ? "analysis-btn active-high"
                : "analysis-btn"
            }
            onClick={() =>
              activateHighlight(
                "highest"
              )
            }
            disabled={!heightData}
          >
            ▲ HIGHEST AREAS
          </button>

          <button
            className={
              highlight === "lowest"
                ? "analysis-btn active-low"
                : "analysis-btn"
            }
            onClick={() =>
              activateHighlight(
                "lowest"
              )
            }
            disabled={!heightData}
          >
            ▼ LOWEST AREAS
          </button>

          <button
            className={
              highlight === "steepest"
                ? "analysis-btn active-steep"
                : "analysis-btn"
            }
            onClick={() =>
              activateHighlight(
                "steepest"
              )
            }
            disabled={!heightData}
          >
            ◢ STEEPEST AREAS
          </button>
        </section>

        <section className="side-section ai-section">
          <div className="section-title">
            TERRAIN AI ASSISTANT
          </div>

          <div className="ai-box">
            <input
              value={query}
              onChange={(e) =>
                setQuery(
                  e.target.value
                )
              }
              onKeyDown={(e) => {
                if (
                  e.key === "Enter"
                ) {
                  askAI();
                }
              }}
              placeholder="Ask about terrain..."
            />

            <button
              onClick={askAI}
            >
              ASK
            </button>
          </div>
        </section>
      </aside>

      {/* MAIN */}
      <main className="main">
        <header className="topbar">
          <div>
            <h1>
              SINGLE-VIEW HEIGHT ESTIMATION
            </h1>

            <p>
              SATELLITE IMAGE → RELATIVE DEPTH → 3D TERRAIN → FLYTHROUGH
            </p>
          </div>

          <div className="system-status">
            <span />
            SYSTEM ONLINE
          </div>
        </header>

        <section className="viewer">
          <div className="viewer-header">
            <div>
              INTERACTIVE 3D TERRAIN
            </div>

            <div className="viewer-mode">
              {virtualScene
                ? "VIRTUAL DISASTER SCENE · ACTIVE"
                : floodSimulation
                ? "FLOOD SIMULATION · ACTIVE"
                : highlight
                  ? `${highlight.toUpperCase()} ANALYSIS`
                  : mode}
            </div>
          </div>

          <div className="viewer-content">
            <FloodSimulationHUD
              active={floodSimulation}
              floodTime={floodTime}
            />
            {mode === "MAP" && (
              <MapView
                onAreaSelected={
                  handleMapAreaSelected
                }
              />
            )}

            {mode === "IMAGE" &&
              image && (
                <div className="image-preview">
                  <img
                    src={image}
                    alt="Uploaded satellite optical image"
                  />

                  <div className="image-overlay">
                    SATELLITE OPTICAL IMAGE
                  </div>
                </div>
              )}

            {mode === "DEPTH" && (
              <DepthMap
                heightData={
                  heightData
                }
              />
            )}

            {mode === "3D" &&
              heightData && (
                <Canvas
                  camera={{
                    position: [
                      30,
                      22,
                      30,
                    ],
                    fov: 76,
                    near: 0.1,
                    far: 500,
                  }}
                  dpr={[1, 1.15]}
                  gl={{
                    antialias: true,
                    powerPreference:
                      "high-performance",
                  }}
                  shadows
                >
                  <Scene
                    heightData={
                      heightData
                    }
                    highlight={
                      highlight
                    }
                    flythrough={
                      flythrough
                    }
                    satelliteImage={
                      satelliteImage
                    }
                    selectedMapArea={
                      selectedMapArea
                    }
                    virtualScene={
                      virtualScene
                    }
                    floodSimulation={
                      floodSimulation
                    }
                    floodTime={
                      floodTime
                    }
                  />
                </Canvas>
              )}

            {mode === "3D" &&
              !heightData && (
                <div className="empty-state">
                  ANALYZE TERRAIN FIRST
                </div>
              )}
          </div>
        </section>

        <section className="exploration-bar">
          <div>
            <strong>
              TERRAIN EXPLORATION
            </strong>

            <span>
              {answer}
            </span>
          </div>

          <button
            className={
              flythrough
                ? "fly-btn active"
                : "fly-btn"
            }
            onClick={
              startFlythrough
            }
            disabled={!heightData}
          >
            {flythrough
              ? "■ STOP FLYTHROUGH"
              : "▶ START FLYTHROUGH"}
          </button>
        </section>

        {displayStats && (
          <section className="analytics">
            <div className="analytics-title">
              TERRAIN ANALYTICS
            </div>

            <div className="analytics-grid">
              <div className="stat-card">
                <span>MIN</span>

                <strong>
                  {displayStats.min.toFixed(1)}
                </strong>

                <small>
                  {displayStats.unit}
                </small>
              </div>

              <div className="stat-card">
                <span>MAX</span>

                <strong>
                  {displayStats.max.toFixed(1)}
                </strong>

                <small>
                  {displayStats.unit}
                </small>
              </div>

              <div className="stat-card">
                <span>AVG</span>

                <strong>
                  {displayStats.avg.toFixed(1)}
                </strong>

                <small>
                  {displayStats.unit}
                </small>
              </div>
            </div>
          </section>
        )}

        {highlightedSummary && (
          <section className="region-summary">
            <div className="analytics-title">
              {highlightedSummary.label.toUpperCase()}
            </div>

            <div className="region-summary-grid">
              <div className="summary-card">
                <span>Length</span>
                <strong>
                  {highlightedSummary.length.toFixed(1)}
                </strong>
                <small>relative units</small>
              </div>

              <div className="summary-card">
                <span>Relief</span>
                <strong>
                  {highlightedSummary.depth.toFixed(1)}
                </strong>
                <small>relative units</small>
              </div>

              <div className="summary-card">
                <span>Elevation range</span>
                <strong>
                  {(
                    highlightedSummary.maxHeight -
                    highlightedSummary.minHeight
                  ).toFixed(1)}
                </strong>
                <small>relative units</small>
              </div>
            </div>
          </section>
        )}

        <footer className="footer">
          <span>
            LOKA 3D · DEPTHWIZARD
          </span>

          <span>
            SINGLE VIEW → TERRAIN → FLYTHROUGH
          </span>
        </footer>
      </main>
    </div>
  );
}
