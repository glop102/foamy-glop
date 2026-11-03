// The scenario: an ordered list of items, in inches and °F. Air items add up
// to the space air can be in, solids are cut out of it, surface stamps label
// the boundary faces they cover, and zones act on the air inside them.
// export.js turns a scenario into an OpenFOAM case. Neither file touches the
// DOM, so both run in Node too.
//
// Axes: x left -> right, y front -> back, z up. Nothing assumes a room; the
// mesh is a grid over the bounding box of all the air.

export const VERSION = 2;

// Wall constructions: layers from the air side out (thickness m,
// conductivity W/mK), and the coefficient h (W/m2K) on the far side.
export const CONSTRUCTIONS = {
  interior: { label: "Interior stud wall", ambient: "house", h: 8, layers: [[0.0127, 0.17], [0.089, 0.52], [0.0127, 0.17]] },
  exterior: { label: "Exterior wall, R-13", ambient: "outside", h: 25, layers: [[0.0127, 0.17], [0.089, 0.04], [0.02, 0.12]] },
  window: { label: "Double glazing", ambient: "outside", h: 25, layers: [[0.012, 0.04]] },
  ceiling: { label: "Ceiling, R-22", ambient: "attic", h: 8, layers: [[0.0127, 0.17], [0.152, 0.039]] },
  floor: { label: "Wood floor on plywood", ambient: "belowFloor", h: 6, layers: [[0.019, 0.16], [0.019, 0.13]] },
  slab: { label: "Concrete slab", ambient: "belowFloor", h: 6, layers: [[0.1, 1.4]] },
  door: { label: "Hollow-core door", ambient: "house", h: 8, layers: [[0.035, 0.09]] },
  duct: { label: "Insulated flex duct, R-6", ambient: "attic", h: 8, layers: [[0.038, 0.036]] },
  adiabatic: { label: "Adiabatic (no heat through)", ambient: null, h: 0, layers: [] },
};

export const DEFAULT_AMBIENTS = {
  house: { label: "House", temp: 68 },
  outside: { label: "Outside", temp: 63 },
  attic: { label: "Attic", temp: 63 },
  belowFloor: { label: "Below floor", temp: 68 },
};

export const FACES = ["-x", "+x", "-y", "+y", "-z", "+z"];
export const FACE_LABELS = {
  "-x": "left (-x)", "+x": "right (+x)", "-y": "front (-y)", "+y": "back (+y)", "-z": "bottom (-z)", "+z": "top (+z)",
};
const AXIS = { x: 0, y: 1, z: 2 };

// What each kind of item is. `shapes` lists the shapes it may take.
export const KINDS = {
  air: { label: "Air", group: "space", shapes: ["box", "cylinder", "path"], help: "Space air can be in. Overlapping air items join up; a duct is just air in a pipe shape." },
  machine: { label: "Machine", group: "solid", shapes: ["box"], help: "A solid box that pulls air in one face, heats it by its power and blows it out another. At 0 W it is a box fan." },
  heater: { label: "Passive heater", group: "solid", shapes: ["box"], help: "A fanless box (UPS, switch) giving off its power from its surface." },
  obstacle: { label: "Obstacle", group: "solid", shapes: ["box", "cylinder"], help: "Furniture, shelves, a pillar: air goes around it, no heat." },
  wall: { label: "Wall section", group: "surface", shapes: ["box"], help: "Surfaces inside this box get their own construction: a window, an outside wall, a floor." },
  opening: { label: "Opening", group: "surface", shapes: ["box"], help: "Surfaces inside this box open onto still air beyond: a door gap, a vent, a register." },
  fan: { label: "Wall fan", group: "surface", shapes: ["box"], help: "Surfaces inside this box move a fixed airflow in or out." },
  heat: { label: "Heat source", group: "zone", shapes: ["box", "cylinder"], help: "Adds heat to the air inside it, with no solid: a radiator, a person, a lamp." },
  loss: { label: "Pressure loss", group: "zone", shapes: ["box", "cylinder"], help: "Resists flow through it: a grille, a filter. K is the loss over the zone's length." },
};

export const GROUPS = { space: "Space", solid: "Solids", surface: "Surfaces", zone: "Zones" };

export const isSolid = (o) => KINDS[o.kind]?.group === "solid";
export const isStamp = (o) => KINDS[o.kind]?.group === "surface";
export const isZone = (o) => KINDS[o.kind]?.group === "zone";

// Names the generated case uses for itself.
const RESERVED = new Set(["surfaces", "solidWalls", "air", "wallHeat", "cuts", "limitT"]);

export function defaultScenario() {
  return {
    version: VERSION,
    name: "new-room",
    notes: "",
    mesh: { cellSize: 1, fineZ: 32 },
    ambients: structuredClone(DEFAULT_AMBIENTS),
    startTemp: 80,
    surfaces: { construction: "interior", ambient: "house" },
    solver: { iterations: 8000, outflowHeight: null },
    items: [
      { id: "room", kind: "air", shape: { type: "box", min: [0, 0, 0], max: [60, 72, 96] }, surface: null },
      { id: "floor", kind: "wall", shape: { type: "box", min: [0, 0, -0.25], max: [60, 72, 0.25] }, construction: "floor", ambient: "belowFloor" },
      { id: "ceiling", kind: "wall", shape: { type: "box", min: [0, 0, 95.75], max: [60, 72, 96.25] }, construction: "ceiling", ambient: "attic" },
    ],
  };
}

// A free name: `base` itself if it already ends in a number and is free
// (a name someone typed), otherwise base1, base2, ...
export function uniqueId(scenario, base) {
  const taken = new Set(scenario.items.map((o) => o.id));
  if (/\d$/.test(base) && !taken.has(base)) return base;
  for (let i = 1; ; i++) {
    const id = `${base}${i}`;
    if (!taken.has(id)) return id;
  }
}

// A new item of a kind, placed around `at` (a point in inches).
export function newItem(kind, scenario, at) {
  const id = uniqueId(scenario, kind === "air" ? "space" : kind);
  const [x, y, z] = at;
  const box = (w, d, h) => ({ type: "box", min: [x - w / 2, y - d / 2, z], max: [x + w / 2, y + d / 2, z + h] });
  switch (kind) {
    case "air":
      return { id, kind, shape: box(48, 48, 96), surface: null };
    case "machine":
      return { id, kind, shape: box(17, 24, 8), power: 150, cfm: 60, intake: "-y", exhaust: "+y" };
    case "heater":
      return { id, kind, shape: box(17, 24, 4), power: 20 };
    case "obstacle":
      return { id, kind, shape: box(24, 12, 30) };
    case "heat":
      return { id, kind, shape: box(12, 12, 24), power: 100 };
    case "loss":
      return { id, kind, shape: box(6, 6, 2), K: 4, axis: "z" };
    case "wall":
      return { id, kind, shape: box(12, 12, 12), construction: "window", ambient: "outside" };
    case "opening":
      return { id, kind, shape: box(12, 12, 12), ambient: "house" };
    case "fan":
      return { id, kind, shape: box(6, 6, 6), cfm: 20, direction: "out", ambient: "house" };
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

// ---- Shapes ---------------------------------------------------------------------

export function bounds(shape) {
  if (shape.type === "box") return { min: [...shape.min], max: [...shape.max] };
  const pts = shape.type === "cylinder" ? [shape.p1, shape.p2] : shape.points;
  const r = shape.type === "cylinder" ? shape.radius : shape.diameter / 2;
  return {
    min: [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])) - r),
    max: [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])) + r),
  };
}

export function translate(shape, d) {
  const add = (p) => p.map((v, i) => v + d[i]);
  if (shape.type === "box") return { ...shape, min: add(shape.min), max: add(shape.max) };
  if (shape.type === "cylinder") return { ...shape, p1: add(shape.p1), p2: add(shape.p2) };
  return { ...shape, points: shape.points.map(add) };
}

// A path as cylinders between its points, plus a cube at each bend so the
// corners have no gaps.
export function pathPieces(shape) {
  const r = shape.diameter / 2;
  const pieces = [];
  for (let i = 0; i + 1 < shape.points.length; i++) pieces.push({ type: "cylinder", p1: shape.points[i], p2: shape.points[i + 1], radius: r });
  for (let i = 1; i + 1 < shape.points.length; i++) {
    const p = shape.points[i];
    pieces.push({ type: "box", min: p.map((v) => v - r), max: p.map((v) => v + r) });
  }
  return pieces;
}

function pointInShape(p, shape) {
  if (shape.type === "box") return [0, 1, 2].every((i) => p[i] > shape.min[i] && p[i] < shape.max[i]);
  if (shape.type === "cylinder") {
    const a = shape.p1;
    const ab = shape.p2.map((v, i) => v - a[i]);
    const ap = p.map((v, i) => v - a[i]);
    const len2 = ab.reduce((s, v) => s + v * v, 0);
    const t = ap.reduce((s, v, i) => s + v * ab[i], 0) / len2;
    if (t < 0 || t > 1) return false;
    const d2 = ap.reduce((s, v, i) => s + (v - t * ab[i]) ** 2, 0);
    return d2 < shape.radius ** 2;
  }
  return pathPieces(shape).some((s) => pointInShape(p, s));
}

export const inAir = (s, p) =>
  s.items.some((o) => o.kind === "air" && pointInShape(p, o.shape)) && !s.items.some((o) => isSolid(o) && pointInShape(p, o.shape));

// One face of a box, as a thin box around its plane.
export function faceBox(box, face, d = 0.1) {
  const axis = AXIS[face[1]];
  const at = face[0] === "-" ? box.min[axis] : box.max[axis];
  const min = [...box.min];
  const max = [...box.max];
  min[axis] = at - d;
  max[axis] = at + d;
  return { min, max };
}

export const expand = (b, d) => ({ min: b.min.map((v) => v - d), max: b.max.map((v) => v + d) });
export const centre = (b) => [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
const boxesOverlap = (a, b) => [0, 1, 2].every((i) => a.min[i] < b.max[i] - 1e-9 && b.min[i] < a.max[i] - 1e-9);

// The axis a box is thin along (a stamp lying on a surface), or -1.
export function thinAxis(box, mesh) {
  const ext = [0, 1, 2].map((i) => box.max[i] - box.min[i]);
  const lim = Math.min(1, mesh.cellSize);
  const i = ext.indexOf(Math.min(...ext));
  return ext[i] <= lim + 1e-9 ? i : -1;
}

// Everything the mesh has to cover: all air, on the grid.
export function airBounds(s) {
  const air = s.items.filter((o) => o.kind === "air");
  if (!air.length) return null;
  const bs = air.map((o) => bounds(o.shape));
  return { min: [0, 1, 2].map((i) => Math.min(...bs.map((b) => b.min[i]))), max: [0, 1, 2].map((i) => Math.max(...bs.map((b) => b.max[i]))) };
}

// Patch names an item adds to the mesh.
export function patchNames(o) {
  if (o.kind === "machine") return [o.id + "In", o.id + "Out"];
  if (o.kind === "air") return o.surface ? [o.id] : [];
  if (["heater", "wall", "opening", "fan"].includes(o.kind)) return [o.id];
  return [];
}

// ---- Snapping -------------------------------------------------------------------
// Cells are cellSize across, and half that tall below fineZ.

export const snap = (v, step) => Math.round(v / step) * step;

export function snapCoord(mesh, axis, v) {
  const c = mesh.cellSize;
  if (axis !== 2 || !(mesh.fineZ > 0)) return snap(v, c);
  if (v <= mesh.fineZ) return Math.min(snap(v, c / 2), mesh.fineZ);
  return mesh.fineZ + snap(v - mesh.fineZ, c);
}

const onGrid = (mesh, axis, v) => Math.abs(snapCoord(mesh, axis, v) - v) < 1e-6;

// Estimated cells in the background grid.
export function cellEstimate(s) {
  const b = airBounds(s);
  if (!b) return 0;
  const c = s.mesh.cellSize;
  const ext = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
  let nz = ext[2] / c;
  if (s.mesh.fineZ > b.min[2]) nz += (Math.min(s.mesh.fineZ, b.max[2]) - b.min[2]) / c;
  return (ext[0] / c) * (ext[1] / c) * nz;
}

// ---- Validation -----------------------------------------------------------------

function overlapArea(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

// Does a box cut through the surface of a shape (rather than miss it or sit
// entirely inside)? Uses bounding boxes for round shapes, so it can say yes
// when the answer is no; good enough for a warning.
function touchesSurface(b, shape) {
  const sb = bounds(shape);
  if (!boxesOverlap(b, expand(sb, 0.01))) return false;
  const inner = expand(sb, -0.01);
  const inside = [0, 1, 2].every((i) => b.min[i] >= inner.min[i] && b.max[i] <= inner.max[i]);
  return !inside || shape.type !== "box";
}

function checkShape(s, o, err, warn) {
  const sh = o.shape;
  if (!sh || !KINDS[o.kind].shapes.includes(sh.type)) return err(o.id, `"${o.id}" can't be a ${sh?.type ?? "shapeless"} ${KINDS[o.kind].label.toLowerCase()}.`);
  if (sh.type === "box") {
    for (let i = 0; i < 3; i++) if (!(sh.max[i] > sh.min[i])) return err(o.id, `"${o.id}" has no size along ${"xyz"[i]}.`);
    const thin = isStamp(o) ? thinAxis(sh, s.mesh) : -1;
    for (let i = 0; i < 3; i++)
      if (i !== thin && (!onGrid(s.mesh, i, sh.min[i]) || !onGrid(s.mesh, i, sh.max[i]))) {
        warn(o.id, `"${o.id}" has edges off the mesh grid along ${"xyz"[i]}; the mesh will round them to the nearest cell.`);
        break;
      }
  } else if (sh.type === "cylinder") {
    if (!(sh.radius > 0)) return err(o.id, `"${o.id}" needs a positive radius.`);
    if (sh.p1.every((v, i) => v === sh.p2[i])) return err(o.id, `"${o.id}" has both ends in the same place.`);
    if (sh.radius < s.mesh.cellSize) warn(o.id, `"${o.id}" is less than two cells across; it will mesh as a jagged few cells, or not at all.`);
  } else if (sh.type === "path") {
    if (sh.points.length < 2) return err(o.id, `"${o.id}" needs at least two points.`);
    if (!(sh.diameter > 0)) return err(o.id, `"${o.id}" needs a positive diameter.`);
    if (sh.diameter < 2 * s.mesh.cellSize) warn(o.id, `"${o.id}" is less than two cells across; it will mesh as a jagged few cells, or not at all.`);
  }
}

// Returns [{level: "error"|"warning", id, msg}]. Errors stop an export.
export function validate(s) {
  const out = [];
  const err = (id, msg) => out.push({ level: "error", id, msg });
  const warn = (id, msg) => out.push({ level: "warning", id, msg });
  const m = s.mesh;

  if (!(m.cellSize > 0)) err(null, "Cell size must be positive.");
  if (m.fineZ !== null && m.fineZ !== undefined && m.fineZ !== 0 && Math.abs(snap(m.fineZ, m.cellSize) - m.fineZ) > 1e-6)
    err(null, "The fine-cell height must be a whole number of cells.");
  for (const [k, a] of Object.entries(s.ambients)) if (!Number.isFinite(a.temp)) err(null, `Ambient "${a.label ?? k}" needs a temperature.`);
  const ambientOk = (a) => a in s.ambients;
  if (!ambientOk(s.surfaces.ambient) && CONSTRUCTIONS[s.surfaces.construction]?.ambient) err(null, "The default surface points at an ambient that no longer exists.");

  const air = s.items.filter((o) => o.kind === "air");
  if (!air.length) err(null, "There is no air: add a Room or an Air item.");
  const cells = cellEstimate(s);
  if (cells > 3e6) warn(null, `About ${(cells / 1e6).toFixed(1)} million background cells: this will be slow. Raise the cell size, or check for air far from the rest.`);

  const ids = new Map();
  const patches = new Map();
  for (const o of s.items) {
    if (!KINDS[o.kind]) {
      err(o.id, `"${o.id}" is of unknown kind "${o.kind}".`);
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(o.id)) err(o.id, `"${o.id}": names must be letters and digits, starting with a letter.`);
    if (ids.has(o.id)) err(o.id, `Two items are called "${o.id}".`);
    ids.set(o.id, o);
    for (const p of patchNames(o)) {
      if (RESERVED.has(p)) err(o.id, `"${p}" is a name the case uses itself; rename "${o.id}".`);
      else if (patches.has(p)) err(o.id, `"${o.id}" and "${patches.get(p)}" both make a patch called "${p}".`);
      patches.set(p, o.id);
    }
    checkShape(s, o, err, warn);
    for (const key of ["ambient"]) if (o[key] && !ambientOk(o[key])) err(o.id, `"${o.id}" points at an ambient that no longer exists.`);
    if (o.surface && !CONSTRUCTIONS[o.surface.construction]) err(o.id, `"${o.id}" has an unknown construction.`);
    if (o.construction && !CONSTRUCTIONS[o.construction]) err(o.id, `"${o.id}" has an unknown construction.`);
    if ("power" in o && !(o.power >= 0)) err(o.id, `"${o.id}" needs a power of 0 W or more.`);
  }

  const solids = s.items.filter(isSolid);
  const airBoxes = air.map((o) => o.shape);
  for (const o of [...solids, ...s.items.filter(isZone)]) {
    const b = bounds(o.shape);
    if (!airBoxes.some((a) => boxesOverlap(b, bounds(a)))) warn(o.id, `"${o.id}" is not in any air, so it does nothing.`);
  }

  for (const o of solids.filter((x) => x.kind === "machine")) {
    if (o.intake === o.exhaust) err(o.id, `"${o.id}" takes in and blows out through the same face.`);
    if (!(o.cfm > 0)) err(o.id, `"${o.id}" needs an airflow above 0 CFM; make it a passive heater if it has no fans.`);
    for (const face of [o.intake, o.exhaust]) {
      // Just outside the middle of the face: is there air there?
      const axis = AXIS[face[1]];
      const p = centre(o.shape);
      p[axis] = face[0] === "-" ? o.shape.min[axis] - 0.3 : o.shape.max[axis] + 0.3;
      if (!inAir(s, p)) {
        err(o.id, `The middle of "${o.id}"'s ${FACE_LABELS[face]} face is against a wall or another solid; air can't get through it.`);
        continue;
      }
      const blocked = blockedFraction(o.shape, face, solids.filter((x) => x !== o).map((x) => bounds(x.shape)));
      if (blocked > 0.001) warn(o.id, `${Math.round(blocked * 100)}% of "${o.id}"'s ${FACE_LABELS[face]} face is covered; its airflow squeezes through the rest.`);
    }
  }
  for (let i = 0; i < solids.length; i++)
    for (let j = i + 1; j < solids.length; j++)
      if (boxesOverlap(bounds(solids[i].shape), bounds(solids[j].shape)))
        warn(solids[j].id, `"${solids[i].id}" and "${solids[j].id}" overlap; they mesh as one solid.`);

  const stamps = s.items.filter(isStamp);
  const surfaceShapes = [...air, ...solids].map((o) => o.shape);
  stamps.forEach((o, i) => {
    if (o.shape.type !== "box") return;
    if (!surfaceShapes.some((sh) => touchesSurface(o.shape, sh))) warn(o.id, `"${o.id}" doesn't reach any surface, so it will catch no faces.`);
    if (o.kind === "fan") {
      if (!(o.cfm >= 0)) err(o.id, `"${o.id}" needs a CFM of 0 or more.`);
      const later = stamps.slice(i + 1).find((x) => [0, 1, 2].every((k) => x.shape.min[k] <= o.shape.min[k] && x.shape.max[k] >= o.shape.max[k]));
      if (later) err(o.id, `"${o.id}" is entirely covered by "${later.id}", which comes later in the list and wins.`);
    }
    if (o.kind === "fan" || o.kind === "opening")
      for (const x of stamps.slice(i + 1))
        if (boxesOverlap(o.shape, x.shape)) warn(o.id, `"${x.id}" overlaps "${o.id}" and wins the shared surface (it is later in the list).`);
  });

  for (const o of s.items.filter((x) => x.kind === "loss")) {
    if (!(o.K >= 0)) err(o.id, `"${o.id}" needs a loss coefficient K of 0 or more.`);
  }

  if (!stamps.some((o) => o.kind === "opening"))
    warn(null, "No openings: the space is sealed, so a fan has nowhere to draw air from and heat only leaves through the walls.");
  return out;
}

// How much of a box face is covered by other boxes sitting against it.
function blockedFraction(box, face, others) {
  const axis = AXIS[face[1]];
  const out = face[0] === "+";
  const at = out ? box.max[axis] : box.min[axis];
  const [a, b] = [0, 1, 2].filter((i) => i !== axis);
  const rect = [box.min[a], box.min[b], box.max[a], box.max[b]];
  const area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
  let covered = 0;
  for (const s of others) {
    const touches = out ? s.min[axis] <= at + 1e-9 && s.max[axis] > at + 1e-9 : s.max[axis] >= at - 1e-9 && s.min[axis] < at - 1e-9;
    if (touches) covered += overlapArea(rect, [s.min[a], s.min[b], s.max[a], s.max[b]]);
  }
  return area > 0 ? Math.min(1, covered / area) : 0;
}

// ---- Loading ----------------------------------------------------------------------

// Fill in anything a hand-written or older scenario leaves out.
export function upgrade(s) {
  if (!s || typeof s !== "object" || !Array.isArray(s.items))
    throw new Error("Not a scenario: it has no items list. (Scenarios from before version 2 are no longer read.)");
  const d = defaultScenario();
  return {
    ...d,
    ...s,
    version: VERSION,
    mesh: { ...d.mesh, ...s.mesh },
    ambients: { ...(s.ambients ?? d.ambients) },
    surfaces: { ...d.surfaces, ...s.surfaces },
    solver: { ...d.solver, ...s.solver },
  };
}

// A ceiling register ducted to a register at the same height somewhere
// else: two boots, a round duct between them, a grille loss in each boot and
// an opening at the far register. Separate items, so each can be changed.
//   d: { register: [x0, y0, x1, y1], far: [x, y], diameter, bootHeight, grilleK, ambient }
export function ductItems(id, d, ceiling) {
  const [x0, y0, x1, y1] = d.register;
  const w = x1 - x0, l = y1 - y0;
  const far = [d.far[0] - w / 2, d.far[1] - l / 2, d.far[0] + w / 2, d.far[1] + l / 2];
  const r = d.diameter / 2;
  const top = ceiling + d.bootHeight;
  const z = top + r;
  const surface = { construction: "duct", ambient: "attic" };
  return [
    { id: `${id}Boot`, kind: "air", shape: { type: "box", min: [x0, y0, ceiling], max: [x1, y1, top + 1] }, surface },
    { id: `${id}FarBoot`, kind: "air", shape: { type: "box", min: [far[0], far[1], ceiling], max: [far[2], far[3], top + 1] }, surface },
    { id: `${id}Duct`, kind: "air", shape: { type: "cylinder", p1: [(x0 + x1) / 2, (y0 + y1) / 2, z], p2: [d.far[0], d.far[1], z], radius: r }, surface },
    { id: `${id}Grille`, kind: "loss", shape: { type: "box", min: [x0, y0, ceiling], max: [x1, y1, top] }, K: d.grilleK, axis: "z" },
    { id: `${id}FarGrille`, kind: "loss", shape: { type: "box", min: [far[0], far[1], ceiling], max: [far[2], far[3], top] }, K: d.grilleK, axis: "z" },
    { id: `${id}Register`, kind: "opening", shape: { type: "box", min: [far[0], far[1], ceiling - 0.25], max: [far[2], far[3], ceiling + 0.25] }, ambient: d.ambient ?? "house" },
  ];
}
