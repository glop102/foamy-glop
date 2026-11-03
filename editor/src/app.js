// The editor: a three.js view of the scenario plus forms for every number.
// The scenario object is the only state; every edit changes it, then
// rebuild() redraws the scene and panels from it. When served by
// foamy-studio, it can also run scenarios and show their results (runs.js).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import {
  CONSTRUCTIONS, FACE_LABELS, KINDS, defaultScenario, newItem, bounds, translate, faceBox, centre,
  pathPieces, snapCoord, snap, validate, uniqueId, upgrade, isSolid, isStamp, isZone, thinAxis, inAir,
  airBounds, cellEstimate, ductItems,
} from "./model.js";
import { exportCase } from "./export.js";
import { tarGz } from "./tar.js";
import { initRuns } from "./runs.js";

const COLORS = {
  air: 0x6fa8dc,
  duct: 0xc9a46b,
  machine: 0x5b6f96,
  boxFan: 0x2fb5c9,
  heater: 0xa0773a,
  obstacle: 0x8a8f99,
  wall: 0xd6c7a1,
  glass: 0x9ec9ff,
  opening: 0x3fbf7f,
  fan: 0x2fb5c9,
  heat: 0xff7a45,
  loss: 0xb48ead,
  intake: 0x3d7bff,
  exhaust: 0xff5a4a,
};
const STORAGE_KEY = "foamy-glop-editor/scenario-v2";

const colorOf = (o) => {
  if (o.kind === "air") return o.surface ? COLORS.duct : COLORS.air;
  if (o.kind === "machine") return o.power === 0 ? COLORS.boxFan : COLORS.machine;
  if (o.kind === "wall") return o.construction === "window" ? COLORS.glass : COLORS.wall;
  return COLORS[o.kind];
};
const hex = (n) => "#" + n.toString(16).padStart(6, "0");

// ---- State ----------------------------------------------------------------------

let scenario = defaultScenario();
let selectedId = null;
let selectedPoint = null; // index of a cylinder end or path point
let mode = "move";
let placing = null; // kind of surface item waiting for a click
const undoStack = [];
const redoStack = [];
let lastCommitted = null;

function commit() {
  const now = JSON.stringify(scenario);
  if (now !== lastCommitted) {
    if (lastCommitted !== null) undoStack.push(lastCommitted);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    lastCommitted = now;
    try {
      localStorage.setItem(STORAGE_KEY, now);
    } catch {
      // private window or blocked storage: autosave is a convenience only
    }
  }
  rebuild();
}

function load(s, { resetHistory = true } = {}) {
  scenario = upgrade(s);
  selectedId = null;
  selectedPoint = null;
  if (resetHistory) {
    undoStack.length = 0;
    redoStack.length = 0;
    lastCommitted = null;
  }
  commit();
  fitView("iso");
}

function restore(json) {
  scenario = JSON.parse(json);
  if (!byId(selectedId)) select(null, null, false);
  rebuild();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(lastCommitted);
  lastCommitted = undoStack.pop();
  restore(lastCommitted);
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(lastCommitted);
  lastCommitted = redoStack.pop();
  restore(lastCommitted);
}

const byId = (id) => scenario.items.find((o) => o.id === id);

// ---- Three.js setup ---------------------------------------------------------------

const viewport = document.getElementById("viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x1a1d22);
viewport.prepend(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
Object.assign(labelRenderer.domElement.style, { position: "absolute", top: "0", pointerEvents: "none" });
viewport.append(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 10000);
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

const gridGroup = new THREE.Group();
const itemGroup = new THREE.Group();
const handleGroup = new THREE.Group();
scene.add(gridGroup, itemGroup, handleGroup);

let fading = []; // air box faces: [{ mesh, normal, point, base }]

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

function sceneBounds() {
  const b = airBounds(scenario) ?? { min: [0, 0, 0], max: [60, 60, 96] };
  return new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
}

function fitView(which) {
  const box = sceneBounds();
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length();
  const dirs = { iso: [0.9, -1.25, 0.85], top: [0, -0.001, 1], front: [0, -1, 0.15], side: [1, 0, 0.15] };
  const d = new THREE.Vector3(...dirs[which]).normalize();
  camera.position.copy(c).addScaledVector(d, r * 1.35);
  orbit.target.copy(c);
  orbit.update();
}

// ---- Scene building ---------------------------------------------------------------

const material = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, ...opts });
const seeThrough = (color, opacity) => material(color, { transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });

function boxMesh(min, max, mat) {
  const size = [0, 1, 2].map((i) => Math.max(max[i] - min[i], 0.05));
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  m.position.set(...centre({ min, max }));
  return m;
}

function cylinderMesh(p1, p2, radius, mat) {
  const a = new THREE.Vector3(...p1);
  const b = new THREE.Vector3(...p2);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(a.distanceTo(b), 0.01), 24, 1, false), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

function sphere(pos, r, mat) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat);
  m.position.set(...pos);
  return m;
}

function shapeMeshes(shape, mat) {
  if (shape.type === "box") return [boxMesh(shape.min, shape.max, mat)];
  if (shape.type === "cylinder") return [cylinderMesh(shape.p1, shape.p2, shape.radius, mat)];
  return pathPieces(shape).map((p) => (p.type === "box" ? sphere(centre(p), shape.diameter / 2, mat) : cylinderMesh(p.p1, p.p2, p.radius, mat)));
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

function edges(min, max, color) {
  const l = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(...[0, 1, 2].map((i) => max[i] - min[i]))),
    new THREE.LineBasicMaterial({ color }),
  );
  l.position.set(...centre({ min, max }));
  l.raycast = () => {};
  return l;
}

function buildGrid() {
  disposeGroup(gridGroup);
  const b = airBounds(scenario);
  if (!b) return;
  const c = scenario.mesh.cellSize;
  const z = b.min[2] + 0.02;
  const lines = (step, color) => {
    const pts = [];
    const x0 = Math.floor(b.min[0] / step) * step, x1 = Math.ceil(b.max[0] / step) * step;
    const y0 = Math.floor(b.min[1] / step) * step, y1 = Math.ceil(b.max[1] / step) * step;
    for (let x = x0; x <= x1 + 1e-6; x += step) pts.push(x, y0, z, x, y1, z);
    for (let y = y0; y <= y1 + 1e-6; y += step) pts.push(x0, y, z, x1, y, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }));
    m.raycast = () => {};
    return m;
  };
  if ((b.max[0] - b.min[0]) / c <= 300 && (b.max[1] - b.min[1]) / c <= 300) gridGroup.add(lines(c, 0x2c313a));
  gridGroup.add(lines(12, 0x4a5262));
}

// Which way is "into the air" from a stamp lying on a surface.
function stampInward(o) {
  const t = thinAxis(o.shape, scenario.mesh);
  if (t < 0) return null;
  const c = centre(o.shape);
  for (const sign of [1, -1]) {
    const p = [...c];
    p[t] += sign * 0.75;
    if (inAir(scenario, p)) {
      const n = [0, 0, 0];
      n[t] = sign;
      return n;
    }
  }
  return null;
}

function buildItem(o) {
  const g = new THREE.Group();
  const sel = o.id === selectedId;
  const sh = o.shape;
  const b = bounds(sh);
  const tag = (m, extra = {}) => {
    m.userData = { id: o.id, ...extra };
    return m;
  };
  let labelPos = [centre(b)[0], centre(b)[1], b.max[2] + 2];

  if (o.kind === "air") {
    const color = colorOf(o);
    if (sh.type === "box") {
      // Six faces that fade when they are between the camera and the inside.
      const size = [0, 1, 2].map((i) => sh.max[i] - sh.min[i]);
      const ax = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
      for (let axis = 0; axis < 3; axis++)
        for (const side of [0, 1]) {
          const [u, v] = [0, 1, 2].filter((i) => i !== axis);
          const isFloor = axis === 2 && side === 0;
          const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[u], size[v]), seeThrough(isFloor ? 0x5a5348 : color, 0.2));
          mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ax[u], ax[v], ax[u].clone().cross(ax[v])));
          const p = centre(sh);
          p[axis] = side ? sh.max[axis] : sh.min[axis];
          mesh.position.set(...p);
          mesh.renderOrder = -1;
          const normal = ax[axis].clone().multiplyScalar(side ? 1 : -1);
          tag(mesh, { air: true, normal: normal.toArray() });
          g.add(mesh);
          fading.push({ mesh, normal, point: new THREE.Vector3(...p), base: isFloor ? 0.55 : 0.2 });
        }
      g.add(edges(sh.min, sh.max, sel ? 0xffd166 : 0x8a93a6));
    } else {
      for (const m of shapeMeshes(sh, seeThrough(color, 0.28))) g.add(tag(m, { air: true }));
    }
  } else if (o.kind === "machine") {
    g.add(tag(boxMesh(sh.min, sh.max, material(colorOf(o)))));
    for (const [face, color, out] of [[o.intake, COLORS.intake, false], [o.exhaust, COLORS.exhaust, true]]) {
      const axis = { x: 0, y: 1, z: 2 }[face[1]];
      const sign = face[0] === "-" ? -1 : 1;
      const f = faceBox(sh, face, 0.15);
      f.min[axis] += sign * 0.15;
      f.max[axis] += sign * 0.15;
      g.add(tag(boxMesh(f.min, f.max, material(color))));
      const c = centre(f);
      const dir = [0, 0, 0];
      dir[axis] = sign * (out ? 1 : -1);
      const len = Math.min(10, 4 + o.cfm / 20);
      const from = [...c];
      from[axis] += out ? 0.5 : sign * (len + 0.5);
      g.add(arrow(from, dir, len, color));
    }
  } else if (isSolid(o)) {
    for (const m of shapeMeshes(sh, material(colorOf(o), { transparent: o.kind === "obstacle", opacity: 0.85 }))) g.add(tag(m));
  } else if (isStamp(o)) {
    const base = o.kind === "wall" ? 0.55 : 0.85;
    const mat = material(colorOf(o), { transparent: true, opacity: base, polygonOffset: true, polygonOffsetFactor: -2 });
    const mesh = tag(boxMesh(sh.min, sh.max, mat));
    g.add(mesh);
    const n = stampInward(o);
    // Wall sections fade with the wall they lie on, so they don't hide the
    // inside; openings and fans stay solid so you can always find them.
    if (n && o.kind === "wall") fading.push({ mesh, normal: new THREE.Vector3(...n).negate(), point: new THREE.Vector3(...centre(sh)), base });
    if (n) labelPos = centre(sh).map((v, i) => v + n[i] * 3);
    if (o.kind === "fan" && n && o.cfm > 0) {
      const c = centre(sh);
      const len = Math.min(14, 5 + o.cfm / 5);
      if (o.direction === "in") g.add(arrow(c, n, len, COLORS.fan));
      else g.add(arrow(c.map((v, i) => v + n[i] * (len + 1)), n.map((v) => -v), len, COLORS.fan));
    }
  } else if (isZone(o)) {
    for (const m of shapeMeshes(sh, seeThrough(colorOf(o), 0.3))) g.add(tag(m));
    if (sh.type === "box") g.add(edges(sh.min, sh.max, colorOf(o)));
  }

  if (sel && !(o.kind === "air" && sh.type === "box")) {
    const helper = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)).expandByScalar(0.3), 0xffd166);
    helper.raycast = () => {};
    g.add(helper);
  }
  g.add(label(o.id, labelPos, sel));
  return g;
}

function disposeGroup(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose?.();
    if (o.isCSS2DObject) o.element.remove();
  });
  group.clear();
}

function buildItems() {
  disposeGroup(itemGroup);
  fading = [];
  for (const o of scenario.items) itemGroup.add(buildItem(o));
}

// Faces of air boxes between the camera and their inside fade away.
function fadeFaces() {
  for (const f of fading) {
    const outside = camera.position.clone().sub(f.point).dot(f.normal) > 0;
    f.mesh.material.opacity = outside ? 0.03 : f.base;
  }
}

// ---- Selection, moving and resizing -----------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function setPointer(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}

// What's under the pointer, ignoring faded-out faces: things first, then
// air faces (which surround everything).
function pick() {
  const hits = raycaster.intersectObjects(itemGroup.children, true).filter((h) => h.object.userData.id && h.object.material.opacity > 0.05);
  return hits.find((h) => !h.object.userData.air) ?? hits[0] ?? null;
}

function select(id, point = null, redraw = true) {
  selectedId = id;
  selectedPoint = point;
  if (redraw) rebuild();
}

const points = (sh) => (sh.type === "cylinder" ? [sh.p1, sh.p2] : sh.type === "path" ? sh.points : []);

function anchor(o) {
  const pts = points(o.shape);
  if (selectedPoint !== null && pts[selectedPoint]) return { pos: pts[selectedPoint], axes: [true, true, true] };
  const axes = [true, true, true];
  if (isStamp(o)) {
    // A stamp on a surface slides along it; lift it off with the numbers.
    const t = thinAxis(o.shape, scenario.mesh);
    if (t >= 0) axes[t] = false;
  }
  return { pos: centre(bounds(o.shape)), axes };
}

function placeGizmo() {
  const o = byId(selectedId);
  if (!o || mode !== "move") return transform.detach();
  const a = anchor(o);
  proxy.position.set(...a.pos);
  [transform.showX, transform.showY, transform.showZ] = a.axes;
  transform.attach(proxy);
}

let dragStart = null;

transform.addEventListener("dragging-changed", (e) => {
  orbit.enabled = !e.value;
  if (e.value) dragStart = { pos: proxy.position.clone(), item: structuredClone(byId(selectedId)) };
  else {
    dragStart = null;
    commit();
  }
});

transform.addEventListener("objectChange", () => {
  if (!dragStart) return;
  const o = byId(selectedId);
  const start = dragStart.item;
  const d = proxy.position.clone().sub(dragStart.pos).toArray();
  const m = scenario.mesh;
  const half = m.cellSize / 2;
  const sh = start.shape;

  if (selectedPoint !== null && points(sh).length) {
    const p = points(sh)[selectedPoint].map((v, i) => snap(v + d[i], half));
    if (sh.type === "cylinder") o.shape[selectedPoint === 0 ? "p1" : "p2"] = p;
    else o.shape.points[selectedPoint] = p;
  } else if (sh.type === "box") {
    const thin = isStamp(start) ? thinAxis(sh, m) : -1;
    for (let i = 0; i < 3; i++) {
      const len = sh.max[i] - sh.min[i];
      if (i === thin) {
        const mid = snapCoord(m, i, (sh.min[i] + sh.max[i]) / 2 + d[i]);
        o.shape.min[i] = mid - len / 2;
        o.shape.max[i] = mid + len / 2;
      } else {
        o.shape.min[i] = snapCoord(m, i, sh.min[i] + d[i]);
        o.shape.max[i] = snapCoord(m, i, o.shape.min[i] + len);
      }
    }
  } else {
    o.shape = translate(sh, d.map((v) => snap(v, half)));
  }
  refreshScene();
});

// Handles: dots on each box face to resize (resize mode), and dots on the
// points of cylinders and paths to pick one to move.
function buildHandles() {
  disposeGroup(handleGroup);
  const o = byId(selectedId);
  if (!o) return;
  const add = (pos, info, color = 0xffd166, r = 1.3) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.renderOrder = 10;
    m.position.set(...pos);
    m.userData = info;
    handleGroup.add(m);
  };
  const sh = o.shape;
  points(sh).forEach((p, i) => add(p, { point: i }, i === selectedPoint ? 0x4f8cff : 0xffd166, 1.6));
  if (mode !== "resize" || sh.type !== "box") return;
  const thin = isStamp(o) ? thinAxis(sh, scenario.mesh) : -1;
  const c = centre(sh);
  for (let axis = 0; axis < 3; axis++) {
    if (axis === thin) continue;
    for (const end of ["min", "max"]) {
      const p = [...c];
      p[axis] = sh[end][axis];
      add(p, { face: { axis, end } });
    }
  }
}

let handleDrag = null;
let pointerDownAt = null;

function onPointerDown(ev) {
  pointerDownAt = [ev.clientX, ev.clientY];
  if (ev.button !== 0 || transform.axis !== null || placing) return;
  setPointer(ev);
  const hit = raycaster.intersectObjects(handleGroup.children, false)[0];
  if (!hit) return;
  const info = hit.object.userData;
  if (info.point !== undefined) {
    select(selectedId, info.point === selectedPoint ? null : info.point);
    pointerDownAt = null;
    return;
  }
  const { axis } = info.face;
  const axisVec = new THREE.Vector3().setComponent(axis, 1);
  const camDir = camera.getWorldDirection(new THREE.Vector3());
  const normal = camDir.clone().sub(axisVec.clone().multiplyScalar(camDir.dot(axisVec)));
  if (normal.lengthSq() < 1e-6) return;
  handleDrag = { ...info.face, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), hit.object.position) };
  orbit.enabled = false;
  renderer.domElement.setPointerCapture(ev.pointerId);
}

function onPointerMove(ev) {
  if (!handleDrag) return;
  setPointer(ev);
  const p = raycaster.ray.intersectPlane(handleDrag.plane, new THREE.Vector3());
  if (!p) return;
  const o = byId(selectedId);
  const { axis, end } = handleDrag;
  const m = scenario.mesh;
  const minStep = axis === 2 && m.fineZ > 0 ? m.cellSize / 2 : m.cellSize;
  let v = snapCoord(m, axis, p.getComponent(axis));
  if (end === "min") v = Math.min(v, o.shape.max[axis] - minStep);
  else v = Math.max(v, o.shape.min[axis] + minStep);
  if (v !== o.shape[end][axis]) {
    o.shape[end][axis] = v;
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
  if (placing) return placeStamp();
  const hit = pick();
  select(hit ? hit.object.userData.id : null);
}

renderer.domElement.addEventListener("pointerdown", onPointerDown, { capture: true });
renderer.domElement.addEventListener("pointermove", onPointerMove);
renderer.domElement.addEventListener("pointerup", onPointerUp);

// ---- Adding things ------------------------------------------------------------------

// Where new things go: the middle of the floor of the first air item.
function dropPoint() {
  const air = scenario.items.find((o) => o.kind === "air");
  if (!air) return [30, 36, 0];
  const b = bounds(air.shape);
  const c = scenario.mesh.cellSize;
  return [snap((b.min[0] + b.max[0]) / 2, c), snap((b.min[1] + b.max[1]) / 2, c), b.min[2]];
}

function push(...items) {
  scenario.items.push(...items);
  select(items[0].id, null, false);
  commit();
}

const addItem = (kind) => push(newItem(kind, scenario, dropPoint()));

function addBoxFan() {
  const o = newItem("machine", scenario, dropPoint());
  Object.assign(o, { id: uniqueId(scenario, "boxFan"), power: 0, cfm: 150 });
  o.shape.max[1] = o.shape.min[1] + 6;
  o.shape.max[2] = o.shape.min[2] + 20;
  push(o);
}

function addRoom() {
  // Next to whatever air there is, along x.
  const b = airBounds(scenario);
  const [x0, y0, z0] = b ? [b.max[0], b.min[1], b.min[2]] : [0, 0, 0];
  const [W, D, H] = [120, 120, 96];
  const id = uniqueId(scenario, "room");
  const slab = (z) => ({ type: "box", min: [x0, y0, z - 0.25], max: [x0 + W, y0 + D, z + 0.25] });
  scenario.items.push({ id, kind: "air", shape: { type: "box", min: [x0, y0, z0], max: [x0 + W, y0 + D, z0 + H] }, surface: null });
  scenario.items.push({ id: uniqueId(scenario, `${id}Floor`), kind: "wall", shape: slab(z0), construction: "floor", ambient: "belowFloor" });
  scenario.items.push({ id: uniqueId(scenario, `${id}Ceiling`), kind: "wall", shape: slab(z0 + H), construction: "ceiling", ambient: "attic" });
  select(id, null, false);
  commit();
  fitView("iso");
}

function addAirShape(type) {
  const [x, y] = dropPoint();
  const top = (airBounds(scenario)?.max[2] ?? 96) + 7;
  const shape =
    type === "path"
      ? { type: "path", points: [[x, y, top - 9], [x, y, top], [x + 48, y, top], [x + 48, y, top - 9]], diameter: 6 }
      : { type: "cylinder", p1: [x, y, top], p2: [x + 48, y, top], radius: 3 };
  push({ id: uniqueId(scenario, type === "path" ? "duct" : "pipe"), kind: "air", shape, surface: { construction: "duct", ambient: "attic" } });
}

function addDuct() {
  // A ceiling register in the first room, ducted 5 ft past its front wall.
  const air = scenario.items.find((o) => o.kind === "air" && o.shape.type === "box");
  if (!air) return alert("Add a room first: the duct starts in its ceiling.");
  const b = air.shape;
  const cx = Math.floor((b.min[0] + b.max[0]) / 2) + 0.5;
  const cy = Math.floor((b.min[1] + b.max[1]) / 2) + 0.5;
  const items = ductItems(uniqueId(scenario, "hvac"), { register: [cx - 2.5, cy - 5.5, cx + 2.5, cy + 5.5], far: [cx, b.min[1] - 60], diameter: 6, bootHeight: 4, grilleK: 4, ambient: "house" }, b.max[2]);
  scenario.items.push(...items);
  select(items[2].id, null, false);
  commit();
  fitView("iso");
}

function startPlacing(kind) {
  placing = kind;
  select(null, null, false);
  rebuild();
}

function stopPlacing() {
  placing = null;
  rebuild();
}

// Put the waiting surface item flat on whatever surface was clicked.
function placeStamp() {
  const hit = pick();
  if (!hit) return;
  const target = byId(hit.object.userData.id);
  let n = hit.object.userData.normal;
  if (!n && hit.face) n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).toArray();
  if (!n) return;
  const axis = [0, 1, 2].reduce((a, i) => (Math.abs(n[i]) > Math.abs(n[a]) ? i : a), 0);
  const p = hit.point.toArray();
  const tb = bounds(target.shape);
  // On a box, the plane is exactly the face that was hit.
  const plane =
    target.shape.type === "box"
      ? Math.abs(p[axis] - tb.min[axis]) < Math.abs(p[axis] - tb.max[axis]) ? tb.min[axis] : tb.max[axis]
      : snapCoord(scenario.mesh, axis, p[axis]);
  const [w, h] = { opening: [12, 6], fan: [6, 6], wall: [24, 24] }[placing];
  const [u, v] = [0, 1, 2].filter((i) => i !== axis);
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  min[axis] = plane - 0.25;
  max[axis] = plane + 0.25;
  for (const [i, len] of [[u, w], [v, h]]) {
    let lo = snapCoord(scenario.mesh, i, p[i] - len / 2);
    if (target.shape.type === "box") lo = Math.max(tb.min[i], Math.min(lo, tb.max[i] - len));
    min[i] = lo;
    max[i] = snapCoord(scenario.mesh, i, lo + len);
  }
  const o = newItem(placing, scenario, [0, 0, 0]);
  o.shape = { type: "box", min, max };
  placing = null;
  push(o);
}

// ---- Panels -----------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

function numberInput(get, set, { step = 0.5, min, title } = {}) {
  return el("input", {
    type: "number", step, min, title, value: get() ?? "",
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

const field = (labelText, input) => el("label", { class: "field" }, el("span", {}, labelText), input);
const triple = (cells, two = false) => el("div", { class: "triple" + (two ? " two" : "") }, cells.map(([l, input]) => el("label", {}, l, input)));
const constructionOptions = () => Object.fromEntries(Object.entries(CONSTRUCTIONS).map(([k, c]) => [k, c.label]));
const ambientOptions = () => Object.fromEntries(Object.entries(scenario.ambients).map(([k, a]) => [k, `${a.label} (${a.temp} °F)`]));

const ADD = [
  ["Space", [
    ["Room", COLORS.air, addRoom, "A 10 × 10 ft room with a floor and ceiling, next to the existing air."],
    ["Air box", COLORS.air, () => addItem("air"), KINDS.air.help],
    ["Air pipe", COLORS.duct, () => addAirShape("cylinder"), "A straight round duct: air with its own insulated surface."],
    ["Duct path", COLORS.duct, () => addAirShape("path"), "A duct with bends; drag its points."],
    ["Ceiling duct", COLORS.duct, addDuct, "A ceiling register ducted through the attic to a register beyond the room, with grilles, like the closet's."],
  ]],
  ["Solids", [
    ["Machine", COLORS.machine, () => addItem("machine"), KINDS.machine.help],
    ["Box fan", COLORS.boxFan, addBoxFan, "A freestanding fan: a 0 W machine moving air from one face to the other."],
    ["Passive heater", COLORS.heater, () => addItem("heater"), KINDS.heater.help],
    ["Obstacle", COLORS.obstacle, () => addItem("obstacle"), KINDS.obstacle.help],
  ]],
  ["Surfaces (click to place)", [
    ["Opening", COLORS.opening, () => startPlacing("opening"), KINDS.opening.help],
    ["Wall fan", COLORS.fan, () => startPlacing("fan"), KINDS.fan.help],
    ["Wall section", COLORS.wall, () => startPlacing("wall"), KINDS.wall.help],
  ]],
  ["Zones", [
    ["Heat source", COLORS.heat, () => addItem("heat"), KINDS.heat.help],
    ["Pressure loss", COLORS.loss, () => addItem("loss"), KINDS.loss.help],
  ]],
];

function renderAdd() {
  document.getElementById("add").replaceChildren(
    ...ADD.map(([title, buttons]) =>
      el("div", { class: "add-group" }, el("h3", {}, title), el("div", { class: "buttons" },
        buttons.map(([text, color, fn, help]) => el("button", { title: help, onclick: fn }, el("span", { class: "swatch", style: `background:${hex(color)}` }), text))))),
  );
}

function moveInList(o, by) {
  const i = scenario.items.indexOf(o);
  const j = i + by;
  if (j < 0 || j >= scenario.items.length) return;
  [scenario.items[i], scenario.items[j]] = [scenario.items[j], scenario.items[i]];
  commit();
}

const kindLabel = (o) => (o.kind === "machine" && o.power === 0 ? "Box fan" : KINDS[o.kind]?.label ?? o.kind);

function renderList() {
  document.getElementById("list").replaceChildren(
    el("li", { class: "settings" + (selectedId === null ? " selected" : ""), onclick: () => select(null) }, "Scenario settings"),
    ...scenario.items.map((o) =>
      el("li", { class: o.id === selectedId ? "selected" : "", onclick: () => select(o.id) },
        el("span", { class: "swatch", style: `background:${hex(colorOf(o))}` }),
        o.id,
        el("span", { class: "kind" }, kindLabel(o)),
        el("span", { class: "order" },
          el("button", { title: "Earlier in the list", onclick: (e) => (e.stopPropagation(), moveInList(o, -1)) }, "↑"),
          el("button", { title: "Later in the list (wins shared surfaces)", onclick: (e) => (e.stopPropagation(), moveInList(o, 1)) }, "↓"))),
    ),
  );
}

let problems = [];

function renderProblems() {
  const ul = document.getElementById("problems");
  const errors = problems.filter((p) => p.level === "error").length;
  document.getElementById("problemCount").textContent = problems.length ? `(${problems.length})` : "";
  for (const id of ["export", "run"]) {
    const b = document.getElementById(id);
    b.disabled = errors > 0;
    b.title = errors ? "Fix the errors under Checks first" : id === "run" ? "Mesh and solve this scenario here" : "Download a runnable OpenFOAM case (.tar.gz)";
  }
  if (!problems.length) return ul.replaceChildren(el("li", { class: "ok" }, "Ready to run."));
  ul.replaceChildren(...problems.map((p) => el("li", { class: p.level, "data-id": p.id ?? undefined, onclick: () => p.id && select(p.id) }, p.msg)));
}

function renderProps() {
  const o = byId(selectedId);
  document.getElementById("props").replaceChildren(...(o ? itemProps(o) : settingsProps()));
}

function settingsProps() {
  const s = scenario;
  const m = s.mesh;
  const ambRows = Object.entries(s.ambients).map(([k, a]) =>
    el("div", { class: "ambrow" },
      el("input", { value: a.label, title: `Ambient "${k}"`, onchange: (e) => ((a.label = e.target.value || k), commit()) }),
      numberInput(() => a.temp, (v) => (a.temp = v ?? 0), { step: 1, title: "°F" }),
      el("button", { title: "Remove", onclick: () => { delete s.ambients[k]; commit(); } }, "×")));
  const addAmbient = () => {
    let i = 1;
    while (`ambient${i}` in s.ambients) i++;
    s.ambients[`ambient${i}`] = { label: "New ambient", temp: 70 };
    commit();
  };
  return [
    el("div", { class: "props-title" }, el("h1", {}, "Scenario")),
    el("p", { class: "help" }, "Lengths in inches, temperatures in °F. x runs left → right, y front → back, z up."),
    field("Notes", el("textarea", { onchange: (e) => ((s.notes = e.target.value), commit()) }, s.notes ?? "")),
    el("h3", {}, "Mesh"),
    triple([
      ["cell size", numberInput(() => m.cellSize, (v) => (m.cellSize = v), { step: 0.5, min: 0.5 })],
      ["fine below z", numberInput(() => m.fineZ, (v) => (m.fineZ = v || null), { step: m.cellSize, min: 0, title: "Cells are half as tall below this height. Blank turns it off." })],
    ], true),
    el("p", { class: "note" }, `About ${Math.round(cellEstimate(s)).toLocaleString()} cells in the background grid, before anything is cut away.`),
    el("h3", {}, "Ambients: still air beyond surfaces (°F)"),
    ...ambRows,
    el("button", { onclick: addAmbient }, "Add ambient"),
    el("h3", {}, "Default surface"),
    el("p", { class: "note" }, "Every surface no wall section, opening or air item sets otherwise."),
    field("Construction", selectInput(constructionOptions(), () => s.surfaces.construction, (v) => {
      s.surfaces.construction = v;
      const a = CONSTRUCTIONS[v].ambient;
      if (a && a in s.ambients) s.surfaces.ambient = a;
    })),
    field("Beyond it", selectInput(ambientOptions(), () => s.surfaces.ambient, (v) => (s.surfaces.ambient = v))),
    el("h3", {}, "Solver"),
    field("Start at (°F)", numberInput(() => s.startTemp, (v) => (s.startTemp = v ?? 75), { step: 1, title: "Where the air starts. Near the answer converges faster." })),
    field("Iterations", numberInput(() => s.solver.iterations, (v) => (s.solver.iterations = v ?? 8000), { step: 500, min: 100 })),
    field("Outflow height", numberInput(() => s.solver.outflowHeight, (v) => (s.solver.outflowHeight = v), { step: 1, title: "Height (in) of the opening air mostly leaves by. Blank picks the highest opening." })),
  ];
}

function idField(o) {
  return field("Name", el("input", {
    value: o.id, spellcheck: "false",
    onchange: (e) => {
      const v = e.target.value.trim();
      if (!v || v === o.id) return;
      o.id = byId(v) ? uniqueId(scenario, v) : v;
      selectedId = o.id;
      commit();
    },
  }));
}

function convertShape(o, type) {
  const sh = o.shape;
  const b = bounds(sh);
  const c = centre(b);
  const r = Math.max(1, Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2);
  const pts = points(sh).map((p) => [...p]);
  if (type === "box") o.shape = { type: "box", min: b.min, max: b.max };
  const radius = sh.radius ?? (sh.diameter ? sh.diameter / 2 : r);
  if (type === "cylinder") o.shape = { type: "cylinder", p1: pts[0] ?? [c[0], c[1], b.min[2]], p2: pts.at(-1) ?? [c[0], c[1], b.max[2]], radius };
  else if (type === "path") o.shape = { type: "path", points: pts.length ? pts : [[c[0], c[1], b.min[2]], [c[0], c[1], b.max[2]]], diameter: 2 * radius };
  selectedPoint = null;
}

function shapeProps(o) {
  const sh = o.shape;
  const out = [];
  const allowed = KINDS[o.kind].shapes;
  const names = { box: "Box", cylinder: "Cylinder", path: "Path (duct with bends)" };
  if (allowed.length > 1) out.push(field("Shape", selectInput(Object.fromEntries(allowed.map((t) => [t, names[t]])), () => sh.type, (t) => convertShape(o, t))));
  if (sh.type === "box") {
    const pos = (i) => ["xyz"[i], numberInput(() => sh.min[i], (v) => { const l = sh.max[i] - sh.min[i]; sh.min[i] = v; sh.max[i] = v + l; })];
    const size = (i) => ["wdh"[i], numberInput(() => +(sh.max[i] - sh.min[i]).toFixed(4), (v) => (sh.max[i] = sh.min[i] + v), { min: 0.1 })];
    out.push(el("h3", {}, "Corner nearest the origin"), triple([0, 1, 2].map(pos)));
    out.push(el("h3", {}, "Size"), triple([0, 1, 2].map(size)));
    if (isStamp(o)) out.push(el("p", { class: "note" }, "Catches the surfaces inside this box: keep it thin and lying on one. A bigger box wrapped round a solid catches all its faces."));
    return out;
  }
  const pts = points(sh);
  out.push(el("h3", {}, sh.type === "cylinder" ? "Ends (click a dot to drag it)" : "Points (click a dot to drag it)"));
  pts.forEach((p, i) =>
    out.push(el("div", { class: "points" + (i === selectedPoint ? " selected" : "") },
      el("span", {}, String(i + 1)),
      ...[0, 1, 2].map((k) => numberInput(() => p[k], (v) => (p[k] = v ?? 0))),
      sh.type === "path" && pts.length > 2 ? el("button", { title: "Remove this point", onclick: () => { sh.points.splice(i, 1); selectedPoint = null; commit(); } }, "×") : el("span"))));
  if (sh.type === "path")
    out.push(el("button", { onclick: () => {
      const i = selectedPoint ?? sh.points.length - 1;
      const a = sh.points[i];
      const b = sh.points[i + 1];
      const half = scenario.mesh.cellSize / 2;
      sh.points.splice(i + 1, 0, b ? a.map((v, k) => snap((v + b[k]) / 2, half)) : a.map((v, k) => v + (k === 0 ? 12 : 0)));
      selectedPoint = i + 1;
      commit();
    } }, "Add a point after the selected one"));
  if (sh.type === "cylinder") out.push(field("Radius (in)", numberInput(() => sh.radius, (v) => (sh.radius = v), { step: 0.5, min: 0.5 })));
  else out.push(field("Diameter (in)", numberInput(() => sh.diameter, (v) => (sh.diameter = v), { step: 1, min: 1 })));
  return out;
}

function itemProps(o) {
  const k = KINDS[o.kind];
  const out = [
    el("div", { class: "props-title" }, el("span", { class: "swatch", style: `background:${hex(colorOf(o))}` }), el("h1", {}, kindLabel(o))),
    el("p", { class: "help" }, k.help),
    idField(o),
    ...shapeProps(o),
  ];
  const ambient = (labelText, key = "ambient") => field(labelText, selectInput(ambientOptions(), () => o[key], (v) => (o[key] = v)));

  if (o.kind === "air") {
    out.push(el("h3", {}, "Its surfaces"));
    out.push(field("Own construction", el("input", {
      type: "checkbox", checked: !!o.surface,
      onchange: (e) => {
        o.surface = e.target.checked ? { construction: "duct", ambient: "attic" in scenario.ambients ? "attic" : Object.keys(scenario.ambients)[0] } : null;
        commit();
      },
    })));
    if (o.surface) {
      out.push(field("Construction", selectInput(constructionOptions(), () => o.surface.construction, (v) => (o.surface.construction = v))));
      out.push(field("Beyond it", selectInput(ambientOptions(), () => o.surface.ambient, (v) => (o.surface.ambient = v))));
    } else out.push(el("p", { class: "note" }, "Uses the default surface, except where wall sections and openings say otherwise."));
  }
  if (o.kind === "machine") {
    out.push(el("h3", {}, "Load"));
    out.push(field("Power (W)", numberInput(() => o.power, (v) => (o.power = v ?? 0), { step: 5, min: 0 })));
    out.push(field("Airflow (CFM)", numberInput(() => o.cfm, (v) => (o.cfm = v), { step: 5, min: 0 })));
    out.push(field("Intake face", selectInput(FACE_LABELS, () => o.intake, (v) => (o.intake = v))));
    out.push(field("Exhaust face", selectInput(FACE_LABELS, () => o.exhaust, (v) => (o.exhaust = v))));
    if (o.cfm > 0 && o.power > 0) out.push(el("p", { class: "note" }, `Air leaves about ${((o.power / (o.cfm * 0.00047194745 * 1.2 * 1005)) * 1.8).toFixed(1)} °F warmer than it went in. Rule of thumb: ~160 CFM per kW for a 20 °F rise.`));
  }
  if (o.kind === "heater" || o.kind === "heat") out.push(field("Power (W)", numberInput(() => o.power, (v) => (o.power = v ?? 0), { step: 5, min: 0 })));
  if (o.kind === "loss") {
    out.push(field("Loss K", numberInput(() => o.K, (v) => (o.K = v ?? 0), { step: 0.5, min: 0, title: "Pressure loss as a multiple of the dynamic pressure. Finned grilles are about 2–5." })));
    if (o.shape.type === "box") out.push(field("Air flows along", selectInput({ x: "x", y: "y", z: "z (up/down)" }, () => o.axis ?? "z", (v) => (o.axis = v))));
  }
  if (o.kind === "wall") {
    out.push(field("Construction", selectInput(constructionOptions(), () => o.construction, (v) => {
      o.construction = v;
      const a = CONSTRUCTIONS[v].ambient;
      if (a && a in scenario.ambients) o.ambient = a;
    })));
    out.push(ambient("Beyond it"));
  }
  if (o.kind === "opening") out.push(ambient("Opens onto"));
  if (o.kind === "fan") {
    out.push(field("Airflow (CFM)", numberInput(() => o.cfm, (v) => (o.cfm = v), { step: 5, min: 0 })));
    out.push(field("Blows", selectInput({ in: "in", out: "out" }, () => o.direction, (v) => (o.direction = v))));
    out.push(ambient("Air from"));
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
  const b = bounds(o.shape);
  const thin = isStamp(o) ? thinAxis(o.shape, scenario.mesh) : -1;
  const axis = thin === 0 ? 1 : 0;
  const d = [0, 0, 0];
  d[axis] = snap(b.max[axis] - b.min[axis], scenario.mesh.cellSize) + scenario.mesh.cellSize;
  copy.shape = translate(o.shape, d);
  scenario.items.splice(scenario.items.indexOf(o) + 1, 0, copy);
  select(copy.id, null, false);
  commit();
}

function remove() {
  if (!selectedId) return;
  scenario.items = scenario.items.filter((o) => o.id !== selectedId);
  select(null, null, false);
  commit();
}

// ---- Rebuild ----------------------------------------------------------------------

function refreshScene() {
  buildGrid();
  buildItems();
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
  const banner = document.getElementById("placing");
  banner.hidden = !placing;
  banner.textContent = placing ? `Click a surface to place the ${KINDS[placing].label.toLowerCase()} · Esc cancels` : "";
  viewport.classList.toggle("is-placing", !!placing);
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
    load(await (await fetch(v)).json(), { resetHistory: false });
  } catch (err) {
    alert(`Could not load the example: ${err.message}`);
  }
});

document.getElementById("export").addEventListener("click", async () => {
  try {
    const { files } = exportCase(scenario);
    const name = safeName();
    download(await tarGz(Object.fromEntries(Object.entries(files).map(([p, f]) => [`${name}/${p}`, f]))), `${name}.tar.gz`);
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
  const key = e.key.toLowerCase();
  if (mod && key === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && key === "y") {
    e.preventDefault();
    redo();
  } else if (mod && key === "d") {
    e.preventDefault();
    duplicate();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    remove();
  } else if (e.key === "Escape") {
    if (placing) stopPlacing();
    else if (selectedPoint !== null) select(selectedId);
    else select(null);
  } else if (key === "m" && !mod) {
    document.querySelector("input[name=mode][value=move]").click();
  } else if (key === "r" && !mod) {
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
  project(p) {
    const v = new THREE.Vector3(...p).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  },
};

// ---- Start ------------------------------------------------------------------------

renderAdd();
resize();
initRuns({
  getScenario: () => scenario,
  loadScenario: (s) => load(s, { resetHistory: false }),
});

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
    load(await (await fetch("examples/closet-gaming-load.json")).json());
  } catch {
    load(defaultScenario());
  }
}
start();

renderer.setAnimationLoop(() => {
  orbit.update();
  fadeFaces();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});
