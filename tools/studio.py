#!/usr/bin/env python3
"""foamy-studio: the scenario editor plus a local job runner.

    foamy-studio [--runs DIR] [--port 8642] [--editor DIR]

Serves the editor and a small JSON API it uses to run scenarios here:

    GET    /api/ping                     is the studio there
    GET    /api/runs                     every run, newest first
    POST   /api/runs                     {scenario, nprocs?}: export and start
    GET    /api/runs/<name>              status, progress, series, report
    GET    /api/runs/<name>/files/<f>    a file from the run (images, scenario)
    POST   /api/runs/<name>/stop         stop it
    POST   /api/runs/<name>/view         open the 3D view in a desktop window
    DELETE /api/runs/<name>              delete a finished run

Each run is runs/<scenario name>/: the exported case, meshed and solved in
place by its own Allrun. Listens on localhost only.
"""

import argparse
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
MAX_POINTS = 400


def f_from_k(k):
    return (k - 273.15) * 9 / 5 + 32


def thin(points, n=MAX_POINTS):
    """Every k-th point so at most about n remain, always keeping the last."""
    if len(points) <= n:
        return points
    step = len(points) / n
    out = [points[int(i * step)] for i in range(n)]
    out.append(points[-1])
    return out


class Run:
    """A run directory, and the Allrun process if this studio started it."""

    def __init__(self, path):
        self.path = path
        self.proc = None
        self.stopped = False
        self.residuals = {"p_rgh": [], "h": []}
        self.log_offset = 0
        self.log_iter = None
        self.lock = threading.Lock()

    @property
    def name(self):
        return os.path.basename(self.path)

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def file(self, *parts):
        return os.path.join(self.path, *parts)

    def status(self):
        if self.running():
            return "running"
        code = self.proc.returncode if self.proc else self._saved_code()
        if self.stopped:
            return "stopped"
        if code is None:
            # Not started by this studio: judge by what is on disk.
            if os.path.exists(self.file("report.txt")):
                return "done"
            solver = self.file("log.buoyantSimpleFoam")
            if os.path.exists(solver) and "\nEnd\n" in tail(solver, 2000):
                return "done"
            return "unknown"
        return "done" if code == 0 else "failed"

    def _saved_code(self):
        try:
            with open(self.file("studio.json")) as fh:
                return json.load(fh).get("exitCode")
        except (OSError, ValueError):
            return None

    def phase(self):
        logs = glob.glob(self.file("log.*"))
        if not logs:
            return None
        latest = max(logs, key=os.path.getmtime)
        return os.path.basename(latest)[4:]

    def end_time(self):
        try:
            with open(self.file("system", "controlDict")) as fh:
                m = re.search(r"^endTime\s+(\d+)", fh.read(), re.M)
            return int(m.group(1)) if m else None
        except OSError:
            return None

    def read_solver_log(self):
        """Pick up residuals from the solver log since the last call."""
        path = self.file("log.buoyantSimpleFoam")
        if not os.path.exists(path):
            return
        with self.lock:
            size = os.path.getsize(path)
            if size < self.log_offset:  # rerun: start over
                self.log_offset = 0
                self.residuals = {"p_rgh": [], "h": []}
                self.log_iter = None
            with open(path, errors="replace") as fh:
                fh.seek(self.log_offset)
                chunk = fh.read()
            # Only consume whole lines.
            cut = chunk.rfind("\n") + 1
            self.log_offset += len(chunk[:cut].encode())
            seen = set()
            for line in chunk[:cut].splitlines():
                if line.startswith("Time = "):
                    try:
                        self.log_iter = int(float(line[7:]))
                    except ValueError:
                        pass
                    seen = set()
                    continue
                m = re.search(r"Solving for (\w+), Initial residual = ([0-9.eE+-]+)", line)
                if m and m.group(1) in self.residuals and m.group(1) not in seen and self.log_iter is not None:
                    seen.add(m.group(1))
                    self.residuals[m.group(1)].append([self.log_iter, float(m.group(2))])

    def series(self):
        """Machine intake temperatures and room air, °F, by iteration."""
        out = {}
        for d in sorted(glob.glob(self.file("postProcessing", "*"))):
            name = os.path.basename(d)
            label = name[:-6] if name.endswith("Intake") else "room air" if name == "air" else None
            if label is None:
                continue
            files = sorted(glob.glob(os.path.join(d, "*", "*.dat")))
            if not files:
                continue
            pts = []
            with open(files[-1]) as fh:
                for line in fh:
                    if line.startswith("#") or not line.strip():
                        continue
                    parts = line.split()
                    try:
                        pts.append([float(parts[0]), round(f_from_k(float(parts[1])), 2)])
                    except (ValueError, IndexError):
                        pass
            if pts:
                out[label] = thin(pts)
        return out

    def summary(self):
        self.read_solver_log()
        return {
            "name": self.name,
            "status": self.status(),
            "phase": self.phase(),
            "iteration": self.log_iter,
            "endTime": self.end_time(),
            "modified": os.path.getmtime(self.path),
        }

    def details(self):
        d = self.summary()
        d["residuals"] = {k: thin(v) for k, v in self.residuals.items()}
        d["series"] = self.series()
        d["images"] = sorted(os.path.basename(p) for p in glob.glob(self.file("*.png")))
        d["report"] = read(self.file("report.txt"))
        d["log"] = tail(self.file("allrun.log"), 4000)
        return d


def read(path):
    try:
        with open(path, errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def tail(path, nbytes):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - nbytes))
            return fh.read().decode(errors="replace")
    except OSError:
        return None


class Studio:
    def __init__(self, runs_dir, export_cmd, report_cmd):
        self.runs_dir = os.path.abspath(runs_dir)
        self.export_cmd = export_cmd
        self.report_cmd = report_cmd
        self.runs = {}
        self.lock = threading.Lock()
        os.makedirs(self.runs_dir, exist_ok=True)

    def get(self, name):
        if not NAME.match(name):
            return None
        path = os.path.join(self.runs_dir, name)
        if not os.path.isdir(path):
            return None
        with self.lock:
            if name not in self.runs:
                self.runs[name] = Run(path)
            return self.runs[name]

    def list(self):
        names = [n for n in os.listdir(self.runs_dir) if NAME.match(n) and os.path.isdir(os.path.join(self.runs_dir, n))]
        runs = [self.get(n) for n in names]
        return sorted((r.summary() for r in runs if r), key=lambda r: -r["modified"])

    def start(self, scenario, nprocs):
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(scenario.get("name") or "scenario")).strip("-.") or "scenario"
        path = os.path.join(self.runs_dir, name)
        existing = self.get(name)
        if existing and existing.running():
            return HTTPStatus.CONFLICT, {"error": f"{name} is already running. Stop it first, or rename the scenario."}
        if os.path.isdir(path):
            if not os.path.exists(os.path.join(path, "scenario.json")):
                return HTTPStatus.CONFLICT, {"error": f"{path} exists and is not a studio run; not touching it."}
            shutil.rmtree(path)

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(scenario, fh)
            src = fh.name
        try:
            res = subprocess.run([*self.export_cmd, src, path], capture_output=True, text=True)
        finally:
            os.unlink(src)
        if res.returncode != 0:
            shutil.rmtree(path, ignore_errors=True)
            return HTTPStatus.BAD_REQUEST, {"error": (res.stderr or res.stdout).strip()}

        env = dict(os.environ)
        if nprocs:
            env["NPROCS"] = str(int(nprocs))
        run = Run(path)
        log = open(run.file("allrun.log"), "w")
        run.proc = subprocess.Popen(["./Allrun"], cwd=path, stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
        log.close()
        with self.lock:
            self.runs[name] = run
        threading.Thread(target=self._wait, args=(run,), daemon=True).start()
        return HTTPStatus.CREATED, run.summary()

    def _wait(self, run):
        code = run.proc.wait()
        try:
            with open(run.file("studio.json"), "w") as fh:
                json.dump({"exitCode": code, "stopped": run.stopped, "finished": time.time()}, fh)
        except OSError:
            pass

    def stop(self, run):
        if not run.running():
            return HTTPStatus.CONFLICT, {"error": "It is not running."}
        run.stopped = True
        # Allrun runs in its own session; take down mpirun and the solvers too.
        os.killpg(run.proc.pid, signal.SIGTERM)
        return HTTPStatus.OK, run.summary()

    def view(self, run):
        subprocess.Popen([*self.report_cmd, "--view", run.path], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return HTTPStatus.ACCEPTED, {"ok": True}

    def delete(self, run):
        if run.running():
            return HTTPStatus.CONFLICT, {"error": "Stop it before deleting it."}
        shutil.rmtree(run.path)
        with self.lock:
            self.runs.pop(run.name, None)
        return HTTPStatus.OK, {"ok": True}


def handler(studio, editor_dir):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=editor_dir, **kw)

        def log_message(self, fmt, *args):
            if not self.path.startswith("/api/"):
                return
            sys.stderr.write("%s %s\n" % (self.command, self.path))

        def end_headers(self):
            # The editor changes as you work on it; don't let the browser
            # hold on to an old copy.
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def send_json(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def route(self):
            parts = [unquote(p) for p in urlparse(self.path).path.split("/") if p]
            if parts[:1] != ["api"]:
                return None
            return parts[1:]

        def do_GET(self):
            parts = self.route()
            if parts is None:
                return super().do_GET()
            if parts == ["ping"]:
                return self.send_json(HTTPStatus.OK, {"studio": True, "runs": studio.runs_dir})
            if parts == ["runs"]:
                return self.send_json(HTTPStatus.OK, studio.list())
            if len(parts) >= 2 and parts[0] == "runs":
                run = studio.get(parts[1])
                if not run:
                    return self.send_json(HTTPStatus.NOT_FOUND, {"error": "No such run."})
                if len(parts) == 2:
                    return self.send_json(HTTPStatus.OK, run.details())
                if parts[2] == "files" and len(parts) == 4:
                    return self.send_file(run, parts[3])
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})

        def send_file(self, run, name):
            if "/" in name or name.startswith(".") or not re.match(r"^[\w.-]+\.(png|json|txt)$", name):
                return self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})
            path = run.file(name)
            if not os.path.isfile(path):
                return self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})
            ctype = {"png": "image/png", "json": "application/json", "txt": "text/plain; charset=utf-8"}[name.rsplit(".", 1)[1]]
            with open(path, "rb") as fh:
                data = fh.read()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 5_000_000:
                raise ValueError("too large")
            return json.loads(self.rfile.read(n) or b"{}")

        def do_POST(self):
            parts = self.route()
            if parts is None:
                return self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})
            try:
                body = self.body()
            except ValueError:
                return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Bad JSON."})
            if parts == ["runs"]:
                if not isinstance(body.get("scenario"), dict):
                    return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "No scenario."})
                return self.send_json(*studio.start(body["scenario"], body.get("nprocs")))
            if len(parts) == 3 and parts[0] == "runs":
                run = studio.get(parts[1])
                if not run:
                    return self.send_json(HTTPStatus.NOT_FOUND, {"error": "No such run."})
                if parts[2] == "stop":
                    return self.send_json(*studio.stop(run))
                if parts[2] == "view":
                    return self.send_json(*studio.view(run))
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})

        def do_DELETE(self):
            parts = self.route()
            if parts and len(parts) == 2 and parts[0] == "runs":
                run = studio.get(parts[1])
                if run:
                    return self.send_json(*studio.delete(run))
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})

    return Handler


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Scenario editor with a local job runner.")
    ap.add_argument("--runs", default="runs", help="where runs go (default: ./runs)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8642)))
    ap.add_argument("--editor", default=os.path.join(here, "..", "editor"), help="editor directory to serve")
    ap.add_argument("--export", default="foamy-export", help="command that exports a scenario")
    ap.add_argument("--report", default="foamy-report", help="command that reports on a run")
    args = ap.parse_args()

    if not os.environ.get("WM_PROJECT_DIR"):
        sys.exit("foamy-studio runs OpenFOAM, so it needs the OpenFOAM environment: start it inside 'nix develop' or with 'nix run .#studio'.")
    studio = Studio(args.runs, args.export.split(), args.report.split())
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(studio, os.path.abspath(args.editor)))
    print(f"foamy-studio at http://localhost:{args.port}/  (runs in {studio.runs_dir}; Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
