// The editor: a three.js view of the scenario plus forms for every number.
// The scenario object is the only state; every edit changes it, then
// rebuild() redraws the scene and panels from it.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import {
  CONSTRUCTIONS, AMBIENTS, WALLS, FACES, FACE_LABELS, TYPES, defaultScenario, newObject,
  ductGeometry, roomSize, snapCoord, validate, uniqueId, rectOverlap,
} from "./model.js";
import { exportCase } from "./export.js";
import { tarGz } from "./tar.js";

const COLORS = {
  machine: 0x5b6f96,
  heater: 0xa0773a,
  obstacle: 0x8a8f99,
  vent: 0x3fbf7f,
  fan: 0x2fb5c9,
  panel: 0x9ec9ff,
  duct: 0xc9a46b,
  intake: 0x3d7bff,
  exhaust: 0xff5a4a,
};
const STORAGE_KEY = "foamy-glop-editor/scenario";

// ---- State ----------------------------------------------------------------------

let scenario = defaultScenario();
let selectedId = null;
let selectedPart = null; // "far" for a duct's far register
let mode = "move";
const undoStack = [];
const redoStack = [];
let lastCommitted = null;

function commit() {
  const now = JSON.stringify(scenario);
  if (now === lastCommitted) return;
  if (lastCommitted !== null) undoStack.push(lastCommitted);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  lastCommitted = now;
  try {
    localStorage.setItem(STORAGE_KEY, now);
  } catch {
    // private window or blocked storage: autosave is a convenience only
  }
  rebuild();
}

function load(s, { resetHistory = true } = {}) {
  scenario = upgrade(s);
  selectedId = null;
  selectedPart = null;
  if (resetHistory) {
    undoStack.length = 0;
    redoStack.length = 0;
    lastCommitted = null;
  }
  commit();
  fitView("iso");
}

// Fill in anything an older or hand-written scenario leaves out.
function upgrade(s) {
  const d = defaultScenario();
  return {
    ...d,
    ...s,
    room: { ...d.room, ...s.room },
    temperatures: { ...d.temperatures, ...s.temperatures },
    walls: Object.fromEntries(Object.keys(d.walls).map((k) => [k, { ...d.walls[k], ...(s.walls?.[k] ?? {}) }])),
    solver: { ...d.solver, ...s.solver },
    objects: (s.objects ?? []).filter((o) => TYPES[o.type]),
  };
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(lastCommitted);
  lastCommitted = undoStack.pop();
  scenario = JSON.parse(lastCommitted);
  if (!byId(selectedId)) selectedId = null;
  rebuild();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(lastCommitted);
  lastCommitted = redoStack.pop();
  scenario = JSON.parse(lastCommitted);
  if (!byId(selectedId)) selectedId = null;
  rebuild();
}

const byId = (id) => scenario.objects.find((o) => o.id === id);

// ---- Three.js setup ---------------------------------------------------------------

const viewport = document.getElementById("viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x1a1d22);
viewport.prepend(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.top = "0";
labelRenderer.domElement.style.pointerEvents = "none";
viewport.append(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
camera.up.set(0, 0, 1);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.6, -0.9, 1.4);
scene.add(sun);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.15;

const transform = new TransformControls(camera, renderer.domElement);
transform.setSize(0.8);
scene.add(transform.getHelper());
const proxy = new THREE.Object3D();
scene.add(proxy);

const roomGroup = new THREE.Group();
const objectGroup = new THREE.Group();
const handleGroup = new THREE.Group();
scene.add(roomGroup, objectGroup, handleGroup);

let walls = []; // [{ mesh, normal, centre, base }]

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

function fitView(which) {
  // Frame the room and everything attached to it (ducts reach outside).
  const [W, D, H] = roomSize(scenario.room);
  const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(W, D, H));
  for (const o of scenario.objects)
    if (o.type === "duct") {
      const g = ductGeometry(scenario.room, o);
      bounds.expandByPoint(new THREE.Vector3(...g.farCentre, g.ductZ + g.radius));
    }
  const centre = bounds.getCenter(new THREE.Vector3());
  const r = bounds.getSize(new THREE.Vector3()).length();
  const dirs = {
    iso: [0.9, -1.25, 0.85],
    top: [0, -0.001, 1],
    front: [0, -1, 0.15],
    side: [1, 0, 0.15],
  };
  const d = new THREE.Vector3(...dirs[which]).normalize();
  camera.position.copy(centre).addScaledVector(d, r * 1.35);
  orbit.target.copy(centre);
  orbit.update();
}

// ---- Scene building ---------------------------------------------------------------

function material(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, ...opts });
}

function boxMesh(min, max, mat) {
  const size = [0, 1, 2].map((i) => Math.max(max[i] - min[i], 0.05));
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  m.position.set(...[0, 1, 2].map((i) => (min[i] + max[i]) / 2));
  return m;
}

function arrow(from, dir, len, color) {
  const a = new THREE.ArrowHelper(new THREE.Vector3(...dir).normalize(), new THREE.Vector3(...from), len, color, Math.min(4, len * 0.4), Math.min(3, len * 0.3));
  a.traverse((o) => (o.raycast = () => {}));
  return a;
}

function label(text, pos, selected) {
  const div = document.createElement("div");
  div.className = "label3d" + (selected ? " selected" : "");
  div.textContent = text;
  const l = new CSS2DObject(div);
  l.position.set(...pos);
  return l;
}

function buildRoom() {
  roomGroup.clear();
  walls = [];
  const [W, D, H] = roomSize(scenario.room);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(W, D, H)),
    new THREE.LineBasicMaterial({ color: 0x8a93a6 }),
  );
  edges.position.set(W / 2, D / 2, H / 2);
  roomGroup.add(edges);

  // Floor grid: cell lines faint, foot lines brighter.
  const grid = (step, color) => {
    const pts = [];
    for (let x = 0; x <= W + 1e-6; x += step) pts.push(x, 0, 0.02, x, D, 0.02);
    for (let y = 0; y <= D + 1e-6; y += step) pts.push(0, y, 0.02, W, y, 0.02);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }));
  };
  const c = scenario.room.cellSize;
  if (W / c <= 200 && D / c <= 200) roomGroup.add(grid(c, 0x2c313a));
  roomGroup.add(grid(12, 0x4a5262));

  for (const [key, w] of Object.entries(WALLS)) {
    const size = [W, D, H];
    const uLen = size[w.u];
    const vLen = size[w.v];
    const geo = new THREE.PlaneGeometry(uLen, vLen);
    const isFloor = key === "floor";
    const cons = scenario.walls[key].construction;
    const color = cons === "exterior" ? 0x9aa9bd : cons === "adiabatic" ? 0x777777 : isFloor ? 0x5a5348 : 0xc9c3b8;
    const mesh = new THREE.Mesh(geo, material(color, { transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
    // Orient the plane: its local x -> u axis, local y -> v axis.
    const ax = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    const normal = ax[w.axis].clone().multiplyScalar(w.side ? 1 : -1);
    const basis = new THREE.Matrix4().makeBasis(ax[w.u], ax[w.v], ax[w.u].clone().cross(ax[w.v]));
    mesh.quaternion.setFromRotationMatrix(basis);
    const centre = [W / 2, D / 2, H / 2];
    centre[w.axis] = w.side ? size[w.axis] : 0;
    mesh.position.set(...centre);
    mesh.raycast = () => {};
    mesh.renderOrder = -1;
    roomGroup.add(mesh);
    walls.push({ mesh, normal, centre: new THREE.Vector3(...centre), base: isFloor ? 0.85 : 0.3 });
  }
}

// Dollhouse: walls between the camera and the room fade out.
function fadeWalls() {
  for (const w of walls) {
    const toCam = camera.position.clone().sub(w.centre);
    const facingAway = toCam.dot(w.normal) > 0;
    w.mesh.material.opacity = facingAway ? 0.04 : w.base;
  }
}

function inwardNormal(wallKey) {
  const w = WALLS[wallKey];
  const n = [0, 0, 0];
  n[w.axis] = w.side ? -1 : 1;
  return n;
}

// A thing on a wall as a thin slab just inside the room.
function featureSlab(o, depth = 0.8) {
  const w = WALLS[o.wall];
  const size = roomSize(scenario.room);
  const at = w.side ? size[w.axis] : 0;
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  min[w.u] = o.rect[0];
  max[w.u] = o.rect[2];
  min[w.v] = o.rect[1];
  max[w.v] = o.rect[3];
  min[w.axis] = w.side ? at - depth : at;
  max[w.axis] = w.side ? at : at + depth;
  return { min, max };
}

const centreOf = (b) => [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);

function buildObject(o) {
  const g = new THREE.Group();
  g.userData.id = o.id;
  const sel = o.id === selectedId;
  const H = scenario.room.height;
  let labelPos;

  if (TYPES[o.type].solid) {
    const mesh = boxMesh(o.min, o.max, material(COLORS[o.type], { transparent: o.type === "obstacle", opacity: 0.85 }));
    mesh.userData.id = o.id;
    g.add(mesh);
    if (o.type === "machine") {
      for (const [face, color, out] of [[o.intake, COLORS.intake, false], [o.exhaust, COLORS.exhaust, true]]) {
        const axis = { x: 0, y: 1, z: 2 }[face[1]];
        const sign = face[0] === "-" ? -1 : 1;
        const fmin = [...o.min];
        const fmax = [...o.max];
        const at = sign < 0 ? o.min[axis] : o.max[axis];
        fmin[axis] = at + sign * 0.05;
        fmax[axis] = at + sign * 0.3;
        const f = boxMesh(fmin, fmax, material(color));
        f.userData.id = o.id;
        g.add(f);
        const c = centreOf({ min: fmin, max: fmax });
        const dir = [0, 0, 0];
        dir[axis] = sign * (out ? 1 : -1);
        const len = Math.min(10, 4 + o.cfm / 20);
        const from = [...c];
        from[axis] += out ? 0.5 : sign * (len + 0.5);
        g.add(arrow(from, dir, len, color));
      }
    }
    labelPos = [(o.min[0] + o.max[0]) / 2, (o.min[1] + o.max[1]) / 2, o.max[2] + 2];
  } else if (TYPES[o.type].wall) {
    const slab = featureSlab(o);
    const mesh = boxMesh(slab.min, slab.max, material(COLORS[o.type], { transparent: o.type === "panel", opacity: 0.6 }));
    mesh.userData.id = o.id;
    g.add(mesh);
    const c = centreOf(slab);
    const n = inwardNormal(o.wall);
    if (o.type === "fan" && o.cfm > 0) {
      const len = Math.min(14, 5 + o.cfm / 5);
      if (o.direction === "in") g.add(arrow(c, n, len, COLORS.fan));
      else g.add(arrow(c.map((v, i) => v + n[i] * (len + 1)), n.map((v) => -v), len, COLORS.fan));
    }
    labelPos = c.map((v, i) => v + n[i] * 3);
  } else if (o.type === "duct") {
    const dg = ductGeometry(scenario.room, o);
    const mat = material(COLORS.duct, { transparent: true, opacity: 0.75 });
    const [x0, y0, x1, y1] = dg.register;
    const [f0, g0, f1, g1] = dg.far;
    const reg = boxMesh([x0, y0, H - 0.8], [x1, y1, H], material(COLORS.vent));
    reg.userData = { id: o.id };
    const far = boxMesh([f0, g0, H - 0.8], [f1, g1, H], material(o.id === selectedId && selectedPart === "far" ? 0xffd166 : COLORS.vent));
    far.userData = { id: o.id, part: "far" };
    const boot1 = boxMesh([x0, y0, H], [x1, y1, dg.bootTop], mat);
    const boot2 = boxMesh([f0, g0, H], [f1, g1, dg.bootTop], mat);
    boot1.userData = { id: o.id };
    boot2.userData = { id: o.id, part: "far" };
    const a = new THREE.Vector3(...dg.centre, dg.ductZ);
    const b = new THREE.Vector3(...dg.farCentre, dg.ductZ);
    const len = a.distanceTo(b);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(dg.radius, dg.radius, Math.max(len, 0.1), 20), mat);
    pipe.position.copy(a).add(b).multiplyScalar(0.5);
    pipe.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    pipe.userData = { id: o.id };
    g.add(reg, far, boot1, boot2, pipe);
    g.add(label(`${o.id} (far end)`, [...dg.farCentre, dg.bootTop + 4], sel && selectedPart === "far"));
    labelPos = [...dg.centre, dg.bootTop + 4];
  }

  if (sel) {
    const own = TYPES[o.type].solid ? o : TYPES[o.type].wall ? featureSlab(o) : null;
    const box = own
      ? new THREE.Box3(new THREE.Vector3(...own.min), new THREE.Vector3(...own.max)).expandByScalar(0.3)
      : new THREE.Box3().setFromObject(g);
    const helper = new THREE.Box3Helper(box, 0xffd166);
    helper.raycast = () => {};
    g.add(helper);
  }
  g.add(label(o.id, labelPos, sel));
  return g;
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose?.();
    if (o.isCSS2DObject) o.element.remove();
  });
  group.clear();
}

function buildObjects() {
  disposeGroup(objectGroup);
  for (const o of scenario.objects) objectGroup.add(buildObject(o));
}

// ---- Selection, moving and resizing -----------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function setPointer(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}

function select(id, part = null) {
  selectedId = id;
  selectedPart = part;
  rebuild();
}

// Where the move gizmo sits for the selection, and which axes it offers.
function anchor(o) {
  const H = scenario.room.height;
  if (TYPES[o.type].solid) return { pos: centreOf(o), axes: [true, true, true] };
  if (TYPES[o.type].wall) {
    const w = WALLS[o.wall];
    const axes = [false, false, false];
    axes[w.u] = axes[w.v] = true;
    return { pos: centreOf(featureSlab(o)), axes };
  }
  if (o.type === "duct") {
    const g = ductGeometry(scenario.room, o);
    return { pos: [...(selectedPart === "far" ? g.farCentre : g.centre), H], axes: [true, true, false] };
  }
}

function placeGizmo() {
  const o = byId(selectedId);
  if (!o || mode !== "move") {
    transform.detach();
    return;
  }
  const a = anchor(o);
  proxy.position.set(...a.pos);
  transform.showX = a.axes[0];
  transform.showY = a.axes[1];
  transform.showZ = a.axes[2];
  transform.attach(proxy);
}

let dragStart = null;

transform.addEventListener("dragging-changed", (e) => {
  orbit.enabled = !e.value;
  if (e.value) {
    dragStart = { pos: proxy.position.clone(), obj: structuredClone(byId(selectedId)) };
  } else {
    dragStart = null;
    commit();
  }
});

transform.addEventListener("objectChange", () => {
  if (!dragStart) return;
  const o = byId(selectedId);
  const start = dragStart.obj;
  const delta = proxy.position.clone().sub(dragStart.pos).toArray();
  const r = scenario.room;
  const size = roomSize(r);

  if (TYPES[o.type].solid) {
    for (let i = 0; i < 3; i++) {
      const len = start.max[i] - start.min[i];
      let lo = snapCoord(r, i, start.min[i] + delta[i]);
      lo = Math.max(0, Math.min(lo, size[i] - len));
      o.min[i] = lo;
      o.max[i] = snapCoord(r, i, lo + len);
    }
  } else if (TYPES[o.type].wall) {
    const w = WALLS[o.wall];
    for (const [k, axis] of [[0, w.u], [1, w.v]]) {
      const len = start.rect[k + 2] - start.rect[k];
      let lo = snapCoord(r, axis, start.rect[k] + delta[axis]);
      lo = Math.max(0, Math.min(lo, size[axis] - len));
      o.rect[k] = lo;
      o.rect[k + 2] = snapCoord(r, axis, lo + len);
    }
  } else if (o.type === "duct") {
    const c = r.cellSize;
    if (selectedPart === "far") {
      o.far = [start.far[0] + Math.round(delta[0] / c) * c, start.far[1] + Math.round(delta[1] / c) * c];
    } else {
      for (const k of [0, 1]) {
        const len = start.register[k + 2] - start.register[k];
        let lo = start.register[k] + Math.round(delta[k] / c) * c;
        lo = Math.max(0, Math.min(lo, size[k] - len));
        o.register[k] = lo;
        o.register[k + 2] = lo + len;
      }
    }
  }
  refreshScene();
});

// Resize: a dot on each face (solids) or edge (wall things). Dragging one
// moves that face along its axis.
function buildHandles() {
  disposeGroup(handleGroup);
  const o = byId(selectedId);
  if (!o || mode !== "resize") return;
  const geo = new THREE.SphereGeometry(1.3, 16, 12);
  const add = (pos, info) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false }));
    m.renderOrder = 10;
    m.position.set(...pos);
    m.userData.handle = info;
    handleGroup.add(m);
  };
  if (TYPES[o.type].solid) {
    const c = centreOf(o);
    for (let axis = 0; axis < 3; axis++)
      for (const end of ["min", "max"]) {
        const p = [...c];
        p[axis] = o[end][axis];
        add(p, { axis, get: () => o[end][axis], set: (v) => (o[end][axis] = v), end, other: () => o[end === "min" ? "max" : "min"][axis] });
      }
  } else if (TYPES[o.type].wall) {
    const w = WALLS[o.wall];
    const slab = featureSlab(o, 0.4);
    const c = centreOf(slab);
    for (const [k, axis] of [[0, w.u], [1, w.v]])
      for (const [idx, end] of [[k, "min"], [k + 2, "max"]]) {
        const p = [...c];
        p[axis] = o.rect[idx];
        const otherIdx = end === "min" ? k + 2 : k;
        add(p, { axis, get: () => o.rect[idx], set: (v) => (o.rect[idx] = v), end, other: () => o.rect[otherIdx] });
      }
  }
}

let handleDrag = null;

function onPointerDown(ev) {
  pointerDownAt = [ev.clientX, ev.clientY];
  if (ev.button !== 0 || transform.axis !== null) return;
  setPointer(ev);
  const hit = raycaster.intersectObjects(handleGroup.children, false)[0];
  if (!hit) return;
  const h = hit.object.userData.handle;
  const axisVec = new THREE.Vector3().setComponent(h.axis, 1);
  const camDir = camera.getWorldDirection(new THREE.Vector3());
  const normal = camDir.clone().sub(axisVec.clone().multiplyScalar(camDir.dot(axisVec)));
  if (normal.lengthSq() < 1e-6) return; // looking straight down the axis
  handleDrag = { h, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), hit.object.position) };
  orbit.enabled = false;
  renderer.domElement.setPointerCapture(ev.pointerId);
  ev.stopPropagation();
}

function onPointerMove(ev) {
  if (!handleDrag) return;
  setPointer(ev);
  const p = raycaster.ray.intersectPlane(handleDrag.plane, new THREE.Vector3());
  if (!p) return;
  const { h } = handleDrag;
  const r = scenario.room;
  const size = roomSize(r);
  const minStep = h.axis === 2 ? r.cellSize / 2 : r.cellSize;
  let v = snapCoord(r, h.axis, p.getComponent(h.axis));
  v = Math.max(0, Math.min(size[h.axis], v));
  if (h.end === "min") v = Math.min(v, h.other() - minStep);
  else v = Math.max(v, h.other() + minStep);
  if (v !== h.get()) {
    h.set(v);
    refreshScene();
  }
}

function onPointerUp(ev) {
  if (handleDrag) {
    handleDrag = null;
    orbit.enabled = true;
    commit();
    return;
  }
  if (!pointerDownAt || ev.button !== 0) return;
  const moved = Math.hypot(ev.clientX - pointerDownAt[0], ev.clientY - pointerDownAt[1]);
  pointerDownAt = null;
  if (moved > 4 || transform.dragging) return;
  setPointer(ev);
  const hit = raycaster.intersectObjects(objectGroup.children, true).find((h) => h.object.userData.id);
  if (hit) select(hit.object.userData.id, hit.object.userData.part ?? null);
  else select(null);
}

let pointerDownAt = null;
renderer.domElement.addEventListener("pointerdown", onPointerDown, { capture: true });
renderer.domElement.addEventListener("pointermove", onPointerMove);
renderer.domElement.addEventListener("pointerup", onPointerUp);

// ---- Panels -----------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c);
  return e;
}

const hex = (n) => "#" + n.toString(16).padStart(6, "0");

function numberInput(get, set, { step = 0.5, min, title } = {}) {
  return el("input", {
    type: "number",
    step,
    min,
    title,
    value: get() ?? "",
    onchange: (e) => {
      const v = e.target.value === "" ? null : Number(e.target.value);
      if (v !== null && !Number.isFinite(v)) return;
      set(v);
      commit();
    },
  });
}

function selectInput(options, get, set) {
  const s = el("select", { onchange: (e) => (set(e.target.value), commit()) });
  for (const [value, text] of Object.entries(options)) s.append(el("option", { value, selected: value === get() }, text));
  return s;
}

const field = (label, input) => el("label", { class: "field" }, el("span", {}, label), input);
const triple = (cells, two = false) =>
  el("div", { class: "triple" + (two ? " two" : "") }, cells.map(([l, input]) => el("label", {}, l, input)));

function renderAdd() {
  const box = document.getElementById("add");
  box.replaceChildren(
    ...Object.entries(TYPES).map(([type, t]) =>
      el("button", {
        title: t.help,
        onclick: () => {
          const o = newObject(type, scenario);
          if (o.rect) clearSpot(o);
          scenario.objects.push(o);
          selectedId = o.id;
          selectedPart = null;
          commit();
        },
      }, el("span", { class: "swatch", style: `background:${hex(COLORS[type])}` }), t.label),
    ),
  );
}

// Slide a new wall thing along its wall until it is clear of the others.
function clearSpot(o) {
  const w = WALLS[o.wall];
  const size = roomSize(scenario.room);
  const others = scenario.objects.filter((x) => x.wall === o.wall).map((x) => x.rect);
  const wu = o.rect[2] - o.rect[0];
  const wv = o.rect[3] - o.rect[1];
  const step = Math.max(wu, 6);
  for (let v = o.rect[1]; v + wv <= size[w.v]; v += wv * 2)
    for (let u = o.rect[0], i = 0; i < 40; i++, u = o.rect[0] + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * step) {
      if (u < 0 || u + wu > size[w.u]) continue;
      const r = [u, v, u + wu, v + wv];
      if (!others.some((x) => rectOverlap(x, r))) {
        o.rect = r;
        return;
      }
    }
}

function renderList() {
  const list = document.getElementById("list");
  list.replaceChildren(
    el("li", { class: "room" + (selectedId === null ? " selected" : ""), onclick: () => select(null) }, "Room settings"),
    ...scenario.objects.map((o) =>
      el("li", { class: o.id === selectedId ? "selected" : "", onclick: () => select(o.id) },
        el("span", { class: "swatch", style: `background:${hex(COLORS[o.type])}` }),
        o.id,
        el("span", { class: "type" }, TYPES[o.type].label)),
    ),
  );
}

let problems = [];

function renderProblems() {
  const ul = document.getElementById("problems");
  const errors = problems.filter((p) => p.level === "error").length;
  document.getElementById("problemCount").textContent = problems.length ? `(${problems.length})` : "";
  document.getElementById("export").disabled = errors > 0;
  document.getElementById("export").title = errors ? "Fix the errors under Checks first" : "Download a runnable OpenFOAM case (.tar.gz)";
  if (!problems.length) {
    ul.replaceChildren(el("li", { class: "ok" }, "Ready to export."));
    return;
  }
  ul.replaceChildren(
    ...problems.map((p) => el("li", { class: p.level, "data-id": p.id ?? undefined, onclick: () => p.id && select(p.id) }, p.msg)),
  );
}

function renderProps() {
  const box = document.getElementById("props");
  const o = byId(selectedId);
  box.replaceChildren(...(o ? objectProps(o) : roomProps()));
}

function roomProps() {
  const s = scenario;
  const r = s.room;
  const t = s.temperatures;
  const cells = (r.width / r.cellSize) * (r.depth / r.cellSize) * ((2 * r.fineZ + (r.height - r.fineZ)) / r.cellSize);
  const out = [
    el("div", { class: "props-title" }, el("h1", {}, "Room")),
    el("p", { class: "help" }, "Lengths in inches, temperatures in °F. x runs left → right, y front → back, z up."),
    field("Notes", el("textarea", { onchange: (e) => ((s.notes = e.target.value), commit()) }, s.notes ?? "")),
    el("h3", {}, "Size"),
    triple([
      ["width (x)", numberInput(() => r.width, (v) => (r.width = v), { step: r.cellSize, min: r.cellSize })],
      ["depth (y)", numberInput(() => r.depth, (v) => (r.depth = v), { step: r.cellSize, min: r.cellSize })],
      ["height (z)", numberInput(() => r.height, (v) => (r.height = v), { step: r.cellSize, min: r.cellSize })],
    ]),
    el("h3", {}, "Mesh"),
    triple([
      ["cell size", numberInput(() => r.cellSize, (v) => (r.cellSize = v), { step: 0.5, min: 0.5 })],
      ["fine below z", numberInput(() => r.fineZ, (v) => (r.fineZ = v ?? 0), { step: r.cellSize, min: 0, title: "Cells are half as tall below this height. 0 turns it off." })],
    ], true),
    el("p", { class: "note" }, `About ${Math.round(cells).toLocaleString()} cells before solids are cut out.`),
    el("h3", {}, "Temperatures (°F)"),
    triple([
      ["house", numberInput(() => t.house, (v) => (t.house = v))],
      ["outside", numberInput(() => t.outside, (v) => (t.outside = v))],
      ["attic", numberInput(() => t.attic, (v) => (t.attic = v))],
    ]),
    triple([
      ["below floor", numberInput(() => t.belowFloor, (v) => (t.belowFloor = v))],
      ["start", numberInput(() => t.start, (v) => (t.start = v), { title: "Where the room air starts. Near the answer converges faster." })],
    ], true),
    el("h3", {}, "Walls"),
    ...Object.entries(WALLS).map(([key, w]) =>
      el("div", { class: "wallrow" },
        el("span", {}, key),
        selectInput(Object.fromEntries(Object.entries(CONSTRUCTIONS).map(([k, c]) => [k, c.label])), () => s.walls[key].construction, (v) => {
          s.walls[key].construction = v;
          if (CONSTRUCTIONS[v].ambient) s.walls[key].ambient = CONSTRUCTIONS[v].ambient;
        }),
        selectInput(AMBIENTS, () => s.walls[key].ambient, (v) => (s.walls[key].ambient = v)),
      ),
    ),
    el("h3", {}, "Solver"),
    field("Iterations", numberInput(() => s.solver.iterations, (v) => (s.solver.iterations = v ?? 8000), { step: 500, min: 100 })),
    field("Outflow height", numberInput(() => s.solver.outflowHeight, (v) => (s.solver.outflowHeight = v), { step: 1, title: "Height (in) of the opening air mostly leaves by. Blank picks one." })),
    el("p", { class: "note" }, "Outflow height: leave blank to use the duct, or the highest vent."),
  ];
  return out;
}

function idField(o) {
  return field("Name", el("input", {
    value: o.id,
    spellcheck: "false",
    onchange: (e) => {
      const v = e.target.value.trim();
      if (!v || v === o.id) return;
      o.id = byId(v) ? uniqueId(scenario, v) : v;
      selectedId = o.id;
      commit();
    },
  }));
}

function objectProps(o) {
  const t = TYPES[o.type];
  const out = [
    el("div", { class: "props-title" }, el("span", { class: "swatch", style: `background:${hex(COLORS[o.type])}` }), el("h1", {}, t.label)),
    el("p", { class: "help" }, t.help),
    idField(o),
  ];

  if (t.solid) {
    const pos = (i) => [["xyz"[i]], numberInput(() => o.min[i], (v) => {
      const len = o.max[i] - o.min[i];
      o.min[i] = v;
      o.max[i] = v + len;
    })];
    const size = (i) => [["wdh"[i]], numberInput(() => o.max[i] - o.min[i], (v) => (o.max[i] = o.min[i] + v), { min: 0.5 })];
    out.push(el("h3", {}, "Position (corner nearest the origin)"), triple([0, 1, 2].map(pos)));
    out.push(el("h3", {}, "Size"), triple([0, 1, 2].map(size)));
  }

  if (o.type === "machine") {
    out.push(el("h3", {}, "Load"));
    out.push(field("Power (W)", numberInput(() => o.power, (v) => (o.power = v), { step: 5, min: 0 })));
    out.push(field("Airflow (CFM)", numberInput(() => o.cfm, (v) => (o.cfm = v), { step: 5, min: 0 })));
    const rise = o.cfm > 0 ? (o.power / (o.cfm * 0.00047194745 * 1.2 * 1005)) * 1.8 : null;
    out.push(field("Intake face", selectInput(FACE_LABELS, () => o.intake, (v) => (o.intake = v))));
    out.push(field("Exhaust face", selectInput(FACE_LABELS, () => o.exhaust, (v) => (o.exhaust = v))));
    if (rise !== null) out.push(el("p", { class: "note" }, `Air leaves about ${rise.toFixed(1)} °F warmer than it went in. Rule of thumb: ~160 CFM per kW for a 20 °F rise.`));
  }
  if (o.type === "heater") out.push(field("Power (W)", numberInput(() => o.power, (v) => (o.power = v), { step: 5, min: 0 })));

  if (t.wall) {
    const w = WALLS[o.wall];
    const axisName = (a) => ["x", "y", "z"][a];
    out.push(field("Wall", selectInput(Object.fromEntries(Object.entries(WALLS).map(([k, v]) => [k, v.label])), () => o.wall, (v) => {
      const size = roomSize(scenario.room);
      const nw = WALLS[v];
      const wu = o.rect[2] - o.rect[0];
      const wv = o.rect[3] - o.rect[1];
      const u0 = Math.min(o.rect[0], Math.max(0, size[nw.u] - wu));
      const v0 = Math.min(o.rect[1], Math.max(0, size[nw.v] - wv));
      o.wall = v;
      o.rect = [u0, v0, u0 + Math.min(wu, size[nw.u]), v0 + Math.min(wv, size[nw.v])];
    })));
    out.push(el("h3", {}, `Position on the wall (${axisName(w.u)}, ${axisName(w.v)})`));
    out.push(triple([
      [`${axisName(w.u)} from`, numberInput(() => o.rect[0], (v) => { const l = o.rect[2] - o.rect[0]; o.rect[0] = v; o.rect[2] = v + l; })],
      [`${axisName(w.v)} from`, numberInput(() => o.rect[1], (v) => { const l = o.rect[3] - o.rect[1]; o.rect[1] = v; o.rect[3] = v + l; })],
    ], true));
    out.push(el("h3", {}, "Size"));
    out.push(triple([
      [`along ${axisName(w.u)}`, numberInput(() => o.rect[2] - o.rect[0], (v) => (o.rect[2] = o.rect[0] + v), { min: 0.5 })],
      [`along ${axisName(w.v)}`, numberInput(() => o.rect[3] - o.rect[1], (v) => (o.rect[3] = o.rect[1] + v), { min: 0.5 })],
    ], true));
  }
  if (o.type === "vent") out.push(field("Opens onto", selectInput(AMBIENTS, () => o.ambient, (v) => (o.ambient = v))));
  if (o.type === "fan") {
    out.push(field("Airflow (CFM)", numberInput(() => o.cfm, (v) => (o.cfm = v), { step: 5, min: 0 })));
    out.push(field("Blows", selectInput({ in: "into the room", out: "out of the room" }, () => o.direction, (v) => (o.direction = v))));
    out.push(field("Air from", selectInput(AMBIENTS, () => o.ambient, (v) => (o.ambient = v))));
    out.push(el("p", { class: "note" }, "A fan blowing out needs a vent or duct somewhere for air to come back in."));
  }
  if (o.type === "panel") {
    out.push(field("Construction", selectInput(Object.fromEntries(Object.entries(CONSTRUCTIONS).map(([k, c]) => [k, c.label])), () => o.construction, (v) => {
      o.construction = v;
      if (CONSTRUCTIONS[v].ambient) o.ambient = CONSTRUCTIONS[v].ambient;
    })));
    out.push(field("Beyond it", selectInput(AMBIENTS, () => o.ambient, (v) => (o.ambient = v))));
  }

  if (o.type === "duct") {
    const r = o.register;
    out.push(el("p", { class: "note" }, "Click the far register to move that end. The duct runs straight between the two, just above the ceiling."));
    out.push(el("h3", {}, "Ceiling register (centre)"));
    out.push(triple([
      ["x", numberInput(() => (r[0] + r[2]) / 2, (v) => { const w = r[2] - r[0]; r[0] = v - w / 2; r[2] = v + w / 2; })],
      ["y", numberInput(() => (r[1] + r[3]) / 2, (v) => { const l = r[3] - r[1]; r[1] = v - l / 2; r[3] = v + l / 2; })],
    ], true));
    out.push(el("h3", {}, "Register size"));
    out.push(triple([
      ["along x", numberInput(() => r[2] - r[0], (v) => { const c = (r[0] + r[2]) / 2; r[0] = c - v / 2; r[2] = c + v / 2; }, { min: 1 })],
      ["along y", numberInput(() => r[3] - r[1], (v) => { const c = (r[1] + r[3]) / 2; r[1] = c - v / 2; r[3] = c + v / 2; }, { min: 1 })],
    ], true));
    out.push(el("h3", {}, "Far register (centre, outside the room)"));
    out.push(triple([
      ["x", numberInput(() => o.far[0], (v) => (o.far[0] = v), { step: 1 })],
      ["y", numberInput(() => o.far[1], (v) => (o.far[1] = v), { step: 1 })],
    ], true));
    out.push(el("h3", {}, "Duct"));
    out.push(field("Diameter (in)", numberInput(() => o.diameter, (v) => (o.diameter = v), { step: 1, min: 2 })));
    out.push(field("Boot height (in)", numberInput(() => o.bootHeight, (v) => (o.bootHeight = v), { step: 1, min: 1 })));
    out.push(field("Grille loss K", numberInput(() => o.grilleK, (v) => (o.grilleK = v), { step: 0.5, min: 0, title: "Pressure loss of each grille; finned supply grilles are about 2–5." })));
    out.push(field("Far end opens to", selectInput(AMBIENTS, () => o.ambient, (v) => (o.ambient = v))));
  }

  out.push(el("div", { class: "actions" },
    el("button", { onclick: duplicate }, "Duplicate"),
    el("button", { class: "danger", onclick: remove }, "Delete")));
  return out;
}

function duplicate() {
  const o = byId(selectedId);
  if (!o) return;
  const copy = structuredClone(o);
  copy.id = uniqueId(scenario, o.id.replace(/\d+$/, ""));
  // Nudge it so it doesn't sit exactly on the original.
  const size = roomSize(scenario.room);
  if (copy.min) {
    const step = copy.max[0] - copy.min[0];
    if (copy.max[0] + step <= size[0]) { copy.min[0] += step; copy.max[0] += step; }
    else if (copy.min[0] - step >= 0) { copy.min[0] -= step; copy.max[0] -= step; }
  } else if (copy.rect) {
    const w = WALLS[copy.wall];
    const step = copy.rect[2] - copy.rect[0];
    if (copy.rect[2] + step <= size[w.u]) { copy.rect[0] += step; copy.rect[2] += step; }
  } else if (copy.register) {
    copy.register = copy.register.map((v, i) => (i % 2 === 0 ? v + 12 : v));
  }
  scenario.objects.push(copy);
  selectedId = copy.id;
  commit();
}

function remove() {
  if (!selectedId) return;
  scenario.objects = scenario.objects.filter((o) => o.id !== selectedId);
  selectedId = null;
  commit();
}

// ---- Rebuild ----------------------------------------------------------------------

let roomKey = "";

// Redraw the 3D scene only (during drags).
function refreshScene() {
  const key = JSON.stringify([scenario.room, scenario.walls]);
  if (key !== roomKey) {
    roomKey = key;
    buildRoom();
  }
  buildObjects();
  buildHandles();
}

function rebuild() {
  document.getElementById("name").value = scenario.name;
  problems = validate(scenario);
  refreshScene();
  if (!transform.dragging) placeGizmo();
  renderList();
  renderProps();
  renderProblems();
  document.getElementById("undo").disabled = !undoStack.length;
  document.getElementById("redo").disabled = !redoStack.length;
}

// ---- Toolbar ----------------------------------------------------------------------

function download(blob, filename) {
  const a = el("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const safeName = () => (scenario.name || "scenario").replace(/[^A-Za-z0-9._-]+/g, "-");

document.getElementById("name").addEventListener("change", (e) => {
  scenario.name = e.target.value.trim() || "scenario";
  commit();
});

document.getElementById("save").addEventListener("click", () => {
  download(new Blob([JSON.stringify(scenario, null, 2) + "\n"], { type: "application/json" }), `${safeName()}.json`);
});

document.getElementById("open").addEventListener("click", () => document.getElementById("file").click());
document.getElementById("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    load(JSON.parse(await f.text()), { resetHistory: false });
  } catch (err) {
    alert(`Could not read ${f.name}: ${err.message}`);
  }
});

document.getElementById("examples").addEventListener("change", async (e) => {
  const v = e.target.value;
  e.target.value = "";
  if (!v) return;
  if (v === "new") return load(defaultScenario(), { resetHistory: false });
  try {
    const res = await fetch(v);
    load(await res.json(), { resetHistory: false });
  } catch (err) {
    alert(`Could not load the example: ${err.message}`);
  }
});

document.getElementById("export").addEventListener("click", async () => {
  try {
    const { files } = exportCase(scenario);
    const name = safeName();
    const prefixed = Object.fromEntries(Object.entries(files).map(([p, f]) => [`${name}/${p}`, f]));
    download(await tarGz(prefixed), `${name}.tar.gz`);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("undo").addEventListener("click", undo);
document.getElementById("redo").addEventListener("click", redo);
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => fitView(b.dataset.view));
for (const r of document.querySelectorAll("input[name=mode]"))
  r.addEventListener("change", () => {
    mode = r.value;
    placeGizmo();
    buildHandles();
  });
document.getElementById("labels").addEventListener("change", (e) => viewport.classList.toggle("labels-off", !e.target.checked));

window.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
  } else if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    duplicate();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    remove();
  } else if (e.key === "Escape") {
    select(null);
  } else if (e.key === "m") {
    document.querySelector("input[name=mode][value=move]").click();
  } else if (e.key === "r") {
    document.querySelector("input[name=mode][value=resize]").click();
  }
});

// For poking at from the browser console: editor.scenario, editor.load(...).
window.editor = {
  get scenario() {
    return scenario;
  },
  load,
  commit,
  select,
  // Screen position (page pixels) of a point in room inches.
  project(p) {
    const v = new THREE.Vector3(...p).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  },
};

// ---- Start ------------------------------------------------------------------------

renderAdd();
resize();

async function start() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  if (saved) {
    try {
      return load(JSON.parse(saved));
    } catch {
      // fall through to the example
    }
  }
  try {
    const res = await fetch("examples/closet-gaming-load.json");
    load(await res.json());
  } catch {
    load(defaultScenario());
  }
}
start();

renderer.setAnimationLoop(() => {
  orbit.update();
  fadeWalls();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});
