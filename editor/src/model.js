// The scenario: a room full of boxes, described in inches and °F. This file
// knows what a scenario looks like and what makes one valid; export.js turns
// one into an OpenFOAM case. Neither touches the DOM, so both run in Node.
//
// Axes, standing in the doorway looking in:
//   x  left wall (0)  -> right wall (width)
//   y  front wall (0) -> back wall (depth)
//   z  floor (0)      -> ceiling (height)

export const VERSION = 1;

// Wall constructions: layers from the room side out (thickness m, conductivity
// W/mK), and the surface coefficient h (W/m2K) on the far side.
export const CONSTRUCTIONS = {
  interior: {
    label: "Interior stud wall",
    ambient: "house",
    h: 8,
    layers: [[0.0127, 0.17], [0.089, 0.52], [0.0127, 0.17]],
  },
  exterior: {
    label: "Exterior wall, R-13",
    ambient: "outside",
    h: 25,
    layers: [[0.0127, 0.17], [0.089, 0.04], [0.02, 0.12]],
  },
  window: {
    label: "Double glazing",
    ambient: "outside",
    h: 25,
    layers: [[0.012, 0.04]],
  },
  ceiling: {
    label: "Ceiling, R-22 to attic",
    ambient: "attic",
    h: 8,
    layers: [[0.0127, 0.17], [0.152, 0.039]],
  },
  floor: {
    label: "Wood floor on plywood",
    ambient: "belowFloor",
    h: 6,
    layers: [[0.019, 0.16], [0.019, 0.13]],
  },
  slab: {
    label: "Concrete slab",
    ambient: "belowFloor",
    h: 6,
    layers: [[0.1, 1.4]],
  },
  adiabatic: {
    label: "Adiabatic (no heat through it)",
    ambient: null,
    h: 0,
    layers: [],
  },
};

// Insulated flex duct (R-6) for ducts through the attic.
export const DUCT_CONSTRUCTION = { ambient: "attic", h: 8, layers: [[0.038, 0.036]] };

export const AMBIENTS = {
  house: "House",
  outside: "Outside",
  attic: "Attic",
  belowFloor: "Below floor",
};

// Each wall: the axis it is normal to, where it sits, and its in-plane axes
// (u, v) for things placed on it.
export const WALLS = {
  front: { patch: "frontWall", axis: 1, side: 0, u: 0, v: 2, label: "Front (door) wall" },
  back: { patch: "backWall", axis: 1, side: 1, u: 0, v: 2, label: "Back wall" },
  left: { patch: "leftWall", axis: 0, side: 0, u: 1, v: 2, label: "Left wall" },
  right: { patch: "rightWall", axis: 0, side: 1, u: 1, v: 2, label: "Right wall" },
  floor: { patch: "floor", axis: 2, side: 0, u: 0, v: 1, label: "Floor" },
  ceiling: { patch: "ceiling", axis: 2, side: 1, u: 0, v: 1, label: "Ceiling" },
};

export const FACES = ["-x", "+x", "-y", "+y", "-z", "+z"];
export const FACE_LABELS = {
  "-x": "left (-x)",
  "+x": "right (+x)",
  "-y": "front (-y)",
  "+y": "back (+y)",
  "-z": "bottom (-z)",
  "+z": "top (+z)",
};

export const TYPES = {
  machine: { label: "Machine", solid: true, help: "Pulls air in one face, heats it by its power, blows it out another." },
  heater: { label: "Passive heater", solid: true, help: "A fanless box (UPS, switch) shedding its power from its surfaces." },
  obstacle: { label: "Obstacle", solid: true, help: "Furniture, shelves, boxes: air goes around it, no heat." },
  vent: { label: "Vent", wall: true, help: "Passive opening onto still air beyond the wall." },
  fan: { label: "Fan", wall: true, help: "Moves a fixed airflow in or out through the wall." },
  panel: { label: "Wall panel", wall: true, help: "Part of a wall with its own construction, e.g. a window." },
  duct: { label: "Ceiling duct", help: "Ceiling register ducted through the attic to a register beyond the room." },
};

// Names the generated case already uses for itself.
const RESERVED = new Set([
  "floor", "ceiling", "leftWall", "rightWall", "frontWall", "backWall",
  "ductWalls", "solidWalls", "remoteRegisters", "attic", "walls", "air",
  "wallHeat", "cuts", "limitT",
]);

export function defaultScenario() {
  return {
    version: VERSION,
    name: "new-room",
    notes: "",
    room: { width: 60, depth: 72, height: 96, cellSize: 1, fineZ: 32 },
    temperatures: { house: 68, outside: 63, attic: 63, belowFloor: 68, start: 80 },
    walls: {
      front: { construction: "interior", ambient: "house" },
      back: { construction: "interior", ambient: "house" },
      left: { construction: "interior", ambient: "house" },
      right: { construction: "interior", ambient: "house" },
      floor: { construction: "floor", ambient: "belowFloor" },
      ceiling: { construction: "ceiling", ambient: "attic" },
    },
    solver: { iterations: 8000, outflowHeight: null },
    objects: [],
  };
}

export function newObject(type, scenario) {
  const r = scenario.room;
  const id = uniqueId(scenario, type);
  const cx = Math.round(r.width / 2);
  const cy = Math.round(r.depth / 2);
  switch (type) {
    case "machine":
      return { id, type, min: [cx - 8, cy - 12, 0], max: [cx + 9, cy + 12, 8], power: 150, cfm: 60, intake: "-y", exhaust: "+y" };
    case "heater":
      return { id, type, min: [cx - 8, cy - 12, 0], max: [cx + 9, cy + 12, 4], power: 20 };
    case "obstacle":
      return { id, type, min: [cx - 12, cy - 6, 0], max: [cx + 12, cy + 6, 30] };
    case "vent":
      return { id, type, wall: "front", rect: [cx - 6, 0, cx + 6, 2], ambient: "house" };
    case "fan":
      return { id, type, wall: "back", rect: [cx - 3, 80, cx + 3, 86], cfm: 20, direction: "out", ambient: "house" };
    case "panel":
      return { id, type, wall: "right", rect: [cy - 15, 30, cy + 15, 78], construction: "window", ambient: "outside" };
    case "duct":
      return {
        id, type,
        register: [cx - 2.5, cy - 5.5, cx + 2.5, cy + 5.5],
        far: [cx, -60],
        diameter: 6,
        bootHeight: 4,
        grilleK: 4,
        ambient: "house",
      };
    default:
      throw new Error(`unknown object type ${type}`);
  }
}

export function uniqueId(scenario, base) {
  const taken = new Set(scenario.objects.map((o) => o.id));
  for (let i = 1; ; i++) {
    const id = `${base}${i}`;
    if (!taken.has(id)) return id;
  }
}

// ---- Geometry -----------------------------------------------------------------

export function roomSize(room) {
  return [room.width, room.depth, room.height];
}

// The 3D box of a thing on a wall: its rectangle, 0.1 in either side of the
// wall plane. topoSet picks the wall faces whose centres fall inside.
export function featureBox(room, obj) {
  const w = WALLS[obj.wall];
  const size = roomSize(room);
  const at = w.side ? size[w.axis] : 0;
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  min[w.axis] = at - 0.1;
  max[w.axis] = at + 0.1;
  min[w.u] = obj.rect[0];
  min[w.v] = obj.rect[1];
  max[w.u] = obj.rect[2];
  max[w.v] = obj.rect[3];
  return { min, max };
}

// One face of a solid, as a thin box around its plane.
export function faceBox(obj, face) {
  const axis = { x: 0, y: 1, z: 2 }[face[1]];
  const at = face[0] === "-" ? obj.min[axis] : obj.max[axis];
  const min = [...obj.min];
  const max = [...obj.max];
  min[axis] = at - 0.1;
  max[axis] = at + 0.1;
  return { min, max };
}

export function expand(box, d) {
  return { min: box.min.map((v) => v - d), max: box.max.map((v) => v + d) };
}

// Everything about a duct derived from its few settings.
export function ductGeometry(room, d) {
  const H = room.height;
  const [x0, y0, x1, y1] = d.register;
  const w = x1 - x0;
  const l = y1 - y0;
  const far = [d.far[0] - w / 2, d.far[1] - l / 2, d.far[0] + w / 2, d.far[1] + l / 2];
  const radius = d.diameter / 2;
  const bootTop = H + d.bootHeight;
  return {
    register: [x0, y0, x1, y1],
    far,
    centre: [(x0 + x1) / 2, (y0 + y1) / 2],
    farCentre: [...d.far],
    radius,
    bootTop,
    ductZ: bootTop + radius,
  };
}

export const solids = (s) => s.objects.filter((o) => TYPES[o.type]?.solid);
export const features = (s) => s.objects.filter((o) => TYPES[o.type]?.wall);
export const ducts = (s) => s.objects.filter((o) => o.type === "duct");

// Patch names an object adds to the mesh.
export function patchNames(obj) {
  switch (obj.type) {
    case "machine":
      return [obj.id + "In", obj.id + "Out"];
    case "heater":
    case "vent":
    case "fan":
    case "panel":
      return [obj.id];
    case "duct":
      return [obj.id + "Far"];
    default:
      return [];
  }
}

// ---- Snapping -------------------------------------------------------------------
// Cells are cellSize across, and half that tall below fineZ. Edges of things
// have to land on cell edges, or topoSet picks a ragged set of faces.

export function snap(v, step) {
  return Math.round(v / step) * step;
}

export function snapCoord(room, axis, v) {
  const c = room.cellSize;
  if (axis !== 2) return snap(v, c);
  if (v <= room.fineZ) return Math.min(snap(v, c / 2), room.fineZ);
  return room.fineZ + snap(v - room.fineZ, c);
}

function onGrid(room, axis, v) {
  return Math.abs(snapCoord(room, axis, v) - v) < 1e-6;
}

// ---- Validation -----------------------------------------------------------------

const overlaps = (a, b) => [0, 1, 2].every((i) => a.min[i] < b.max[i] - 1e-9 && b.min[i] < a.max[i] - 1e-9);

export function rectOverlap(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function overlapArea(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

// How much of a solid's face is covered by other solids sitting against it.
// (Overlapping covers are counted twice; good enough for a warning.)
function blockedFraction(o, face, others) {
  const axis = { x: 0, y: 1, z: 2 }[face[1]];
  const out = face[0] === "+";
  const at = out ? o.max[axis] : o.min[axis];
  const [a, b] = [0, 1, 2].filter((i) => i !== axis);
  const rect = [o.min[a], o.min[b], o.max[a], o.max[b]];
  const area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
  let covered = 0;
  for (const s of others) {
    const touches = out ? s.min[axis] <= at + 1e-9 && s.max[axis] > at + 1e-9 : s.max[axis] >= at - 1e-9 && s.min[axis] < at - 1e-9;
    if (touches) covered += overlapArea(rect, [s.min[a], s.min[b], s.max[a], s.max[b]]);
  }
  return area > 0 ? Math.min(1, covered / area) : 0;
}

// Returns [{level: "error"|"warning", id, msg}]. Errors stop an export.
export function validate(s) {
  const out = [];
  const err = (id, msg) => out.push({ level: "error", id, msg });
  const warn = (id, msg) => out.push({ level: "warning", id, msg });
  const r = s.room;
  const size = roomSize(r);

  if (!(r.cellSize > 0)) err(null, "Cell size must be positive.");
  for (const [k, v] of [["width", r.width], ["depth", r.depth], ["height", r.height]]) {
    if (!(v > 0)) err(null, `Room ${k} must be positive.`);
    else if (Math.abs(snap(v, r.cellSize) - v) > 1e-6) err(null, `Room ${k} must be a whole number of cells (${r.cellSize} in).`);
  }
  if (r.fineZ < 0 || r.fineZ >= r.height) err(null, "Fine layer height must be between 0 and the room height.");
  else if (Math.abs(snap(r.fineZ, r.cellSize) - r.fineZ) > 1e-6) err(null, "Fine layer height must be a whole number of cells.");
  const cells = (r.width / r.cellSize) * (r.depth / r.cellSize) * ((2 * r.fineZ + (r.height - r.fineZ)) / r.cellSize);
  if (cells > 3e6) warn(null, `About ${(cells / 1e6).toFixed(1)} million cells: this will be slow. Raise the cell size?`);

  const ids = new Map();
  const patches = new Map();
  for (const o of s.objects) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(o.id)) err(o.id, `"${o.id}": names must be letters and digits, starting with a letter.`);
    if (ids.has(o.id)) err(o.id, `Two objects are called "${o.id}".`);
    ids.set(o.id, o);
    for (const p of patchNames(o)) {
      if (RESERVED.has(p)) err(o.id, `"${p}" is a name the case uses itself; rename "${o.id}".`);
      else if (patches.has(p)) err(o.id, `"${o.id}" and "${patches.get(p)}" both make a patch called "${p}".`);
      patches.set(p, o.id);
    }
  }

  const sol = solids(s);
  for (const o of sol) {
    for (let i = 0; i < 3; i++) {
      if (!(o.max[i] > o.min[i])) err(o.id, `"${o.id}" has no size along ${"xyz"[i]}.`);
      if (o.min[i] < -1e-9 || o.max[i] > size[i] + 1e-9) err(o.id, `"${o.id}" sticks out of the room.`);
      if (!onGrid(r, i, o.min[i]) || !onGrid(r, i, o.max[i])) warn(o.id, `"${o.id}" has edges off the mesh grid along ${"xyz"[i]}; they will be rounded to the nearest cell.`);
    }
    if (o.type === "machine") {
      if (o.intake === o.exhaust) err(o.id, `"${o.id}" takes in and blows out through the same face.`);
      if (!(o.cfm > 0)) err(o.id, `"${o.id}" needs an airflow above 0 CFM; make it a passive heater if it has no fans.`);
      for (const face of [o.intake, o.exhaust]) {
        const axis = { x: 0, y: 1, z: 2 }[face[1]];
        const at = face[0] === "-" ? o.min[axis] : o.max[axis];
        if (at <= 1e-9 || at >= size[axis] - 1e-9) err(o.id, `"${o.id}" has its ${FACE_LABELS[face]} face against a wall, so no air can get through it.`);
      }
    }
    if (o.power < 0) err(o.id, `"${o.id}" has negative power.`);
  }
  for (let i = 0; i < sol.length; i++)
    for (let j = i + 1; j < sol.length; j++)
      if (overlaps(sol[i], sol[j])) warn(sol[i].id, `"${sol[i].id}" and "${sol[j].id}" overlap; they will be meshed as one solid.`);

  // A machine face blocked by another solid has less (or no) area for its
  // airflow. With none at all, the fixed-flow boundary divides by zero.
  for (const o of sol.filter((x) => x.type === "machine")) {
    for (const face of [o.intake, o.exhaust]) {
      const blocked = blockedFraction(o, face, sol.filter((x) => x !== o));
      if (blocked > 0.999) err(o.id, `"${o.id}" has its ${FACE_LABELS[face]} face completely covered by another box.`);
      else if (blocked > 0.001) warn(o.id, `"${o.id}" has ${Math.round(blocked * 100)}% of its ${FACE_LABELS[face]} face covered; its airflow squeezes through the rest.`);
    }
  }

  const feats = features(s);
  for (const o of feats) {
    const w = WALLS[o.wall];
    if (!w) {
      err(o.id, `"${o.id}" is on an unknown wall "${o.wall}".`);
      continue;
    }
    const [u0, v0, u1, v1] = o.rect;
    if (!(u1 > u0 && v1 > v0)) err(o.id, `"${o.id}" has no size.`);
    if (u0 < -1e-9 || v0 < -1e-9 || u1 > size[w.u] + 1e-9 || v1 > size[w.v] + 1e-9) err(o.id, `"${o.id}" runs off the edge of the ${w.label.toLowerCase()}.`);
    for (const [axis, val] of [[w.u, u0], [w.u, u1], [w.v, v0], [w.v, v1]])
      if (!onGrid(r, axis, val)) warn(o.id, `"${o.id}" has edges off the mesh grid; they will be rounded to the nearest cell.`);
    if (o.type === "fan" && !(o.cfm >= 0)) err(o.id, `"${o.id}" needs a CFM of 0 or more.`);
    if (o.type === "panel" && !CONSTRUCTIONS[o.construction]) err(o.id, `"${o.id}" has an unknown construction.`);
    const box = featureBox(r, o);
    const area = (o.rect[2] - o.rect[0]) * (o.rect[3] - o.rect[1]);
    let covered = 0;
    for (const so of sol)
      if (overlaps(box, so)) {
        covered += overlapArea(o.rect, [so.min[w.u], so.min[w.v], so.max[w.u], so.max[w.v]]);
        warn(o.id, `"${o.id}" is partly covered by "${so.id}"; only the uncovered part stays open.`);
      }
    // Earlier things on the same wall take the shared faces first.
    for (const other of feats) {
      if (other === o) break;
      if (other.wall === o.wall) covered += overlapArea(o.rect, other.rect);
    }
    if (area > 0 && covered >= area - 1e-9 && (o.type === "fan" || o.type === "vent"))
      err(o.id, `"${o.id}" is completely covered by other things, so it has no area left.`);
  }
  for (let i = 0; i < feats.length; i++)
    for (let j = i + 1; j < feats.length; j++)
      if (feats[i].wall === feats[j].wall && rectOverlap(feats[i].rect, feats[j].rect))
        warn(feats[j].id, `"${feats[i].id}" and "${feats[j].id}" overlap on the ${WALLS[feats[i].wall].label.toLowerCase()}; "${feats[i].id}" (earlier in the list) gets the shared part.`);

  for (const d of ducts(s)) {
    const g = ductGeometry(r, d);
    const [x0, y0, x1, y1] = g.register;
    if (!(x1 > x0 && y1 > y0)) err(d.id, `"${d.id}" register has no size.`);
    if (x0 < 0 || y0 < 0 || x1 > r.width || y1 > r.depth) err(d.id, `"${d.id}" register is not within the ceiling.`);
    const [fx0, fy0, fx1, fy1] = g.far;
    if (!(fx1 <= 0 || fx0 >= r.width || fy1 <= 0 || fy0 >= r.depth)) err(d.id, `"${d.id}" far register must be entirely outside the room's footprint.`);
    if (!(d.diameter > 0) || !(d.bootHeight > 0)) err(d.id, `"${d.id}" needs a positive duct diameter and boot height.`);
    if (d.diameter > 2 * Math.min(x1 - x0, y1 - y0) + 1e-9) warn(d.id, `"${d.id}" duct is much wider than its register; check the sizes.`);
    for (const f of feats)
      if (f.wall === "ceiling" && rectOverlap(f.rect, g.register)) err(d.id, `"${d.id}" register overlaps "${f.id}" on the ceiling.`);
    for (const so of sol)
      if (so.max[2] >= r.height - 1e-9 && rectOverlap([so.min[0], so.min[1], so.max[0], so.max[1]], g.register))
        err(d.id, `"${d.id}" register is blocked by "${so.id}".`);
  }

  if (!s.objects.some((o) => o.type === "vent" || o.type === "duct"))
    warn(null, "No vents or ducts: the room is sealed, so a fan has nowhere to draw air from.");
  return out;
}
