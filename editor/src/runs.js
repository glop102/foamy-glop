// Running scenarios through foamy-studio: the Run button and the Runs
// drawer. Does nothing when the editor is served as plain static files.

const $ = (id) => document.getElementById(id);
const PALETTE = ["#4f8cff", "#ff7a45", "#5fcf8f", "#f0b84a", "#c678dd", "#56b6c2", "#e06c75", "#d19a66"];

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

async function api(path, opts = {}) {
  const res = await fetch(`api/${path}`, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

const PHASES = {
  blockMesh: "Meshing", topoSet: "Meshing", subsetMesh: "Meshing", createPatch: "Meshing",
  transformPoints: "Meshing", checkMesh: "Checking the mesh", decomposePar: "Splitting for parallel",
  buoyantSimpleFoam: "Solving", reconstructPar: "Collecting results",
};

export function initRuns({ getScenario, loadScenario }) {
  let runs = [];
  let selected = null;
  let detail = null;
  let open = false;
  let timer = null;
  let lastKey = "";

  api("ping")
    .then(() => {
      $("run").hidden = false;
      $("runsToggle").hidden = false;
      // With the studio, Save puts the case in the cases folder; the old
      // Save (a .json download) becomes Download.
      $("saveCase").hidden = false;
      $("save").textContent = "Download";
      $("saveCase").addEventListener("click", () => submit(false));

      // Keep the menu current with what's on disk: when it's pressed or
      // focused, after every pick (letting go of focus so the next press
      // counts), and every few seconds for cases made elsewhere.
      const menu = $("examples");
      for (const ev of ["pointerdown", "focus", "keydown"]) menu.addEventListener(ev, refreshMenu);
      menu.addEventListener("change", () => menu.blur());
      setInterval(refreshMenu, 5000);
      refresh();
    })
    .catch(() => {});

  // The scenario menu: the cases on disk, then the examples, both read
  // fresh from the studio. Only rebuilt when something changed, so an open
  // menu isn't pulled out from under you.
  let menuKey = "";
  async function refreshMenu() {
    let list;
    try {
      list = await api("scenarios");
    } catch {
      return;
    }
    const key = JSON.stringify(list);
    if (key === menuKey) return;
    menuKey = key;
    const menu = $("examples");
    const where = list.casesDir.split("/").slice(-2).join("/");
    const cases = el("optgroup", { label: `Cases in ${where}` },
      list.cases.length ? null : el("option", { disabled: true }, "None yet: press ▶ Run to make one"),
      list.cases.map((c) => el("option", { value: c.url, disabled: !c.current, title: c.notes },
        c.case + (c.current ? (c.status === "running" ? " (running)" : "") : " (old format, can't open)"))));
    const examples = el("optgroup", { label: "Examples" },
      list.examples.map((x) => el("option", { value: x.url, title: x.notes }, x.name)));
    const fresh = el("optgroup", { label: "Start fresh" }, el("option", { value: "new" }, "Empty room"));
    menu.replaceChildren(el("option", { value: "" }, "Open scenario…"), cases, examples, fresh);
  }

  $("runsToggle").addEventListener("click", () => setOpen(!open));
  $("run").addEventListener("click", () => submit(true));

  function setOpen(v) {
    open = v;
    $("runs").hidden = !open;
    $("runsToggle").classList.toggle("primary", open);
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    const busy = runs.some((r) => r.status === "running");
    if (open || busy) timer = setTimeout(refresh, busy ? 2000 : 6000);
  }

  async function refresh() {
    try {
      runs = await api("runs");
      if (selected && !runs.some((r) => r.name === selected)) selected = null;
      if (!selected && runs.length) selected = runs[0].name;
      detail = selected ? await api(`runs/${encodeURIComponent(selected)}`) : null;
      render();
    } catch {
      // studio went away; try again later
    }
    const running = runs.filter((r) => r.status === "running").length;
    $("runsToggle").textContent = running ? `Cases (${running} running)` : "Cases";
    refreshMenu();
    schedule();
  }

  // Save the scenario as cases/<name>/, and solve it if `run`.
  async function submit(run) {
    const s = getScenario();
    const name = (s.name || "scenario").replace(/[^A-Za-z0-9._-]+/g, "-");
    const existing = runs.find((r) => r.name === name);
    const hasResults = existing && !["saved", "running"].includes(existing.status);
    if (hasResults && !confirm(`Replace the case "${name}" and its results? Rename the scenario to keep both.`)) return;
    try {
      await api("runs", { method: "POST", body: JSON.stringify({ scenario: s, run }) });
      selected = name;
      lastKey = "";
      if (run) setOpen(true);
      else flash($("saveCase"), "Saved ✓");
      menuKey = "";
      refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  function flash(button, text) {
    const was = button.textContent;
    button.textContent = text;
    setTimeout(() => (button.textContent = was), 1500);
  }

  async function act(path, method = "POST") {
    try {
      await api(path, { method });
      refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  function render() {
    $("runList").replaceChildren(
      ...(runs.length ? runs : []).map((r) =>
        el("li", { class: r.name === selected ? "selected" : "", onclick: () => { selected = r.name; lastKey = ""; refresh(); } },
          r.name, el("span", { class: `badge ${r.status}` }, r.status))),
    );
    if (!runs.length) $("runList").append(el("li", { class: "settings" }, "No cases yet."));

    // Rebuild the detail only when something in it changed, so images and
    // scrolling don't jump every poll.
    const key = detail ? JSON.stringify([detail.status, detail.iteration, detail.phase, detail.images, !!detail.report, detail.series && Object.values(detail.series).map((s) => s.length)]) : "none";
    if (key === lastKey) return;
    lastKey = key;
    $("runDetail").replaceChildren(...(detail ? detailView(detail) : [el("p", { class: "empty" }, "Press ▶ Run to save the scenario as a case and solve it.")]));
    if (detail) drawCharts(detail);
  }

  function detailView(d) {
    const enc = encodeURIComponent(d.name);
    const pct = d.endTime && d.iteration ? Math.min(100, (100 * d.iteration) / d.endTime) : d.status === "done" ? 100 : 0;
    const phase = d.status === "running" ? `${PHASES[d.phase] ?? d.phase ?? "Starting"}${d.phase === "buoyantSimpleFoam" && d.iteration ? `: iteration ${d.iteration} of ${d.endTime}` : ""}` : "";
    const out = [
      el("div", { class: "run-head" },
        el("h1", {}, d.name),
        el("span", { class: `badge ${d.status}` }, d.status),
        el("span", { class: "note" }, phase),
        d.status === "running" ? el("button", { onclick: () => act(`runs/${enc}/stop`) }, "Stop") : null,
        d.status === "done" ? el("button", { title: "Opens the PyVista window on this computer", onclick: () => act(`runs/${enc}/view`) }, "Open 3D view") : null,
        el("button", { title: "Load this case's scenario into the editor", onclick: async () => loadScenario(await (await fetch(`api/runs/${enc}/files/scenario.json`)).json()) }, "Load scenario"),
        d.status !== "running" ? el("button", { class: "danger", onclick: () => confirm(`Delete the case "${d.name}" and its results?`) && act(`runs/${enc}`, "DELETE") }, "Delete") : null),
      el("div", { class: "progress" }, el("div", { style: `width:${pct}%` })),
    ];
    if (d.status === "saved") out.push(el("p", { class: "note" }, "Saved, not run yet. Open it from the scenario menu and press ▶ Run to solve it."));
    const hasSeries = d.series && Object.keys(d.series).length;
    if (hasSeries || d.residuals?.p_rgh?.length)
      out.push(el("div", { class: "charts" },
        el("div", { class: "chart" }, el("h3", {}, "Intake and room temperatures (°F)"), el("canvas", { id: "chartTemps" }), el("div", { class: "legend", id: "legendTemps" })),
        el("div", { class: "chart" }, el("h3", {}, "Solver residuals (lower is more settled)"), el("canvas", { id: "chartResid" }), el("div", { class: "legend", id: "legendResid" }))));
    if (d.report) out.push(el("h3", {}, "Report"), el("pre", { class: "report" }, d.report.replace(/\n\s*wrote .*$/gm, "")));
    if (d.images?.length)
      out.push(el("div", { class: "thumbs" },
        d.images.map((img) => el("a", { href: `api/runs/${enc}/files/${img}?t=${d.iteration}`, target: "_blank", title: img }, el("img", { src: `api/runs/${enc}/files/${img}?t=${d.iteration}`, alt: img })))));
    if (d.status === "failed" || d.status === "stopped" || (d.status === "running" && !hasSeries))
      out.push(el("h3", {}, "Log"), el("pre", { class: "report" }, (d.log ?? "").split("\n").slice(-25).join("\n")));
    return out;
  }

  function drawCharts(d) {
    const temps = Object.entries(d.series ?? {});
    if ($("chartTemps")) chart($("chartTemps"), $("legendTemps"), temps, { log: false });
    const resid = Object.entries(d.residuals ?? {}).filter(([, v]) => v.length);
    if ($("chartResid")) chart($("chartResid"), $("legendResid"), resid, { log: true });
  }
}

// A plain line chart: series is [[name, [[x, y], ...]], ...].
function chart(canvas, legend, series, { log }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  legend.replaceChildren();
  const all = series.flatMap(([, pts]) => pts).filter(([, y]) => !log || y > 0);
  if (!all.length) return;
  const tf = (y) => (log ? Math.log10(y) : y);
  let x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  let y0 = Math.min(...all.map((p) => tf(p[1]))), y1 = Math.max(...all.map((p) => tf(p[1])));
  if (x1 === x0) x1 = x0 + 1;
  if (y1 - y0 < (log ? 1 : 1)) {
    const m = (y0 + y1) / 2;
    y0 = m - 0.5;
    y1 = m + 0.5;
  }
  const pad = { l: 38, r: 8, t: 8, b: 18 };
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * (w - pad.l - pad.r);
  const Y = (y) => h - pad.b - ((tf(y) - y0) / (y1 - y0)) * (h - pad.t - pad.b);

  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "#9097a3";
  ctx.strokeStyle = "#343943";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4;
    const py = h - pad.b - ((v - y0) / (y1 - y0)) * (h - pad.t - pad.b);
    ctx.beginPath();
    ctx.moveTo(pad.l, py);
    ctx.lineTo(w - pad.r, py);
    ctx.stroke();
    ctx.fillText(log ? `1e${v.toFixed(1)}` : v.toFixed(1), 2, py + 3);
  }
  ctx.fillText(String(Math.round(x0)), pad.l, h - 4);
  ctx.fillText(String(Math.round(x1)), w - pad.r - 30, h - 4);

  series.forEach(([name, pts], i) => {
    const color = PALETTE[i % PALETTE.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const [x, y] of pts) {
      if (log && y <= 0) continue;
      started ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y));
      started = true;
    }
    ctx.stroke();
    const lastY = pts.at(-1)?.[1];
    legend.append(el("span", {}, el("span", { class: "swatch", style: `background:${color}` }), log ? name : `${name} ${lastY?.toFixed(1)}`));
  });
}
