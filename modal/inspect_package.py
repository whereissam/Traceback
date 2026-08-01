"""Traceback — real npm package inspection.

Unlike `modal_sim.py`, which replays a fixed scenario, this fetches an actual
package from the npm registry and observes what its install hooks really do.

The evidence comes from `strace`, not from the package's own account of itself:
we trace `execve`, `openat`, `read` and `connect`, then normalise those syscalls
into the same event schema the correlation pipeline already consumes. That is
the difference between "the script told us it read .env" and "the kernel saw it
open .env".

Flow:
  1. npm install <pkg> --ignore-scripts     (nothing executes yet)
  2. read package.json for lifecycle scripts
  3. seed canary credentials into the workspace
  4. run the hook under strace
  5. parse syscalls -> normalised events

Deploy:
    modal deploy modal/inspect_package.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from typing import Any

import modal

app = modal.App("traceback-inspect")

# Node for npm, strace for the actual observation.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("strace", "curl", "ca-certificates")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
        "npm --version && node --version",
    )
    .pip_install("fastapi[standard]==0.115.6")
)

sim_secret = modal.Secret.from_name("traceback-sim", required_keys=["SIM_TOKEN"])

CANARY = "TRACEBACK_CANARY_a91f4c27"
WORK = "/work"

# Syscalls we care about, as emitted by `strace -f -tt`.
RE_PID = re.compile(r"^(\d+)\s+(\d{2}:\d{2}:\d{2}\.\d+)\s+(.*)$")
RE_EXECVE = re.compile(r'execve\("([^"]+)",\s*\[(.*?)\]')
RE_OPENAT = re.compile(r'openat\([^,]+,\s*"([^"]+)",\s*([^)]*)\)\s*=\s*(-?\d+)')
RE_READ = re.compile(r"read\((\d+),")
RE_CONNECT = re.compile(r'connect\(\d+,\s*\{sa_family=AF_INET[^}]*inet_addr\("([^"]+)"\)[^}]*\}')
RE_CLONE = re.compile(r"(?:clone|vfork|fork)\(.*\)\s*=\s*(\d+)")


def _iso(base_date: str, clock: str) -> str:
    """strace gives wall-clock time only; pair it with the run's date."""
    return f"{base_date}T{clock}Z"


def _seed_canaries() -> None:
    """Place synthetic credentials a malicious hook would want.

    None of these are real. Their only purpose is to be recognisable if a
    package reads them, and traceable if their contents leave the sandbox.
    """
    os.makedirs(f"{WORK}", exist_ok=True)
    os.makedirs(f"{WORK}/.aws", exist_ok=True)
    os.makedirs(f"{WORK}/.ssh", exist_ok=True)
    with open(f"{WORK}/.env", "w", encoding="utf-8") as fh:
        fh.write(f"API_KEY={CANARY}\n")
    with open(f"{WORK}/.aws/credentials", "w", encoding="utf-8") as fh:
        fh.write(f"[default]\naws_secret_access_key = {CANARY}\n")
    with open(f"{WORK}/.ssh/id_rsa", "w", encoding="utf-8") as fh:
        fh.write(f"-----BEGIN OPENSSH PRIVATE KEY-----\n{CANARY}\n")


def _parse_strace(path: str, base_date: str) -> list[dict[str, Any]]:
    """Turn a raw strace log into normalised Traceback events.

    Deliberately conservative: only syscalls that succeeded become evidence, and
    a `read` is only attributed to a path when we saw that fd opened.
    """
    events: list[dict[str, Any]] = []
    fd_paths: dict[tuple[str, str], str] = {}  # (pid, fd) -> path
    parents: dict[str, str] = {}
    seen_reads: set[tuple[str, str]] = set()

    if not os.path.exists(path):
        return events

    with open(path, "r", errors="replace") as fh:
        for line in fh:
            m = RE_PID.match(line.strip())
            if not m:
                continue
            pid, clock, body = m.group(1), m.group(2), m.group(3)
            ts = _iso(base_date, clock)

            if child := RE_CLONE.search(body):
                parents[child.group(1)] = pid

            if e := RE_EXECVE.search(body):
                argv = [a.strip().strip('"') for a in e.group(2).split(",") if a.strip()]
                exe = e.group(1)
                events.append(
                    {
                        "timestamp": ts,
                        "source": "process",
                        "event_type": "process_start",
                        "process_id": pid,
                        "parent_process_id": parents.get(pid),
                        "user_id": "sandbox",
                        "raw": {
                            "process": os.path.basename(exe),
                            "args": " ".join(argv[1:])[:200],
                            "exe": exe,
                        },
                    }
                )

            if o := RE_OPENAT.search(body):
                fpath, flags, ret = o.group(1), o.group(2), o.group(3)
                if ret.startswith("-"):
                    continue  # failed open proves nothing
                fd_paths[(pid, ret)] = fpath
                if "O_WRONLY" in flags or "O_CREAT" in flags or "O_RDWR" in flags:
                    events.append(
                        {
                            "timestamp": ts,
                            "source": "file",
                            "event_type": "file_write",
                            "process_id": pid,
                            "parent_process_id": parents.get(pid),
                            "user_id": "sandbox",
                            "raw": {"path": fpath},
                        }
                    )

            if r := RE_READ.search(body):
                fd = r.group(1)
                fpath = fd_paths.get((pid, fd))
                # Only report reads of files we care about, and only once.
                if fpath and (pid, fpath) not in seen_reads:
                    interesting = any(
                        k in fpath
                        for k in (".env", "credentials", "id_rsa", ".npmrc", ".pem")
                    )
                    if interesting:
                        seen_reads.add((pid, fpath))
                        events.append(
                            {
                                "timestamp": ts,
                                "source": "file",
                                "event_type": "file_read",
                                "process_id": pid,
                                "parent_process_id": parents.get(pid),
                                "user_id": "sandbox",
                                "raw": {"path": fpath, "canary_token": CANARY},
                            }
                        )

            if c := RE_CONNECT.search(body):
                ip = c.group(1)
                if ip.startswith("127.") or ip == "0.0.0.0":
                    continue  # loopback isn't egress
                events.append(
                    {
                        "timestamp": ts,
                        "source": "network",
                        "event_type": "network_out",
                        "process_id": pid,
                        "parent_process_id": parents.get(pid),
                        "user_id": "sandbox",
                        "raw": {"dest_host": ip, "status": "completed"},
                    }
                )

    return events


def _inspect(package: str) -> dict[str, Any]:
    base_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    os.makedirs(WORK, exist_ok=True)
    subprocess.run(["npm", "init", "-y"], cwd=WORK, capture_output=True, timeout=60)

    # --- 1. Download WITHOUT executing anything -----------------------------
    fetch = subprocess.run(
        ["npm", "install", package, "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd=WORK,
        capture_output=True,
        text=True,
        timeout=180,
    )
    if fetch.returncode != 0:
        return {
            "package": package,
            "error": f"install failed: {fetch.stderr[-400:]}",
            "events": [],
        }

    # --- 2. What lifecycle scripts does it declare? -------------------------
    name = package.split("@")[0] if not package.startswith("@") else "@".join(
        package.split("@")[:2]
    )
    pkg_json = os.path.join(WORK, "node_modules", name, "package.json")
    scripts: dict[str, str] = {}
    version = None
    if os.path.exists(pkg_json):
        with open(pkg_json, encoding="utf-8") as fh:
            meta = json.load(fh)
        version = meta.get("version")
        all_scripts = meta.get("scripts") or {}
        scripts = {
            k: v
            for k, v in all_scripts.items()
            if k in ("preinstall", "install", "postinstall", "prepare")
        }

    if not scripts:
        return {
            "package": package,
            "version": version,
            "lifecycle_scripts": {},
            "events": [],
            "note": "No install lifecycle scripts declared — nothing to detonate.",
        }

    # --- 3. Read the hook's source, so capability can be assessed statically
    # even if the sandbox run exercises none of it.
    sources: dict[str, str] = {}
    pkg_dir_early = os.path.join(WORK, "node_modules", name)
    for hook_cmd in scripts.values():
        for token in hook_cmd.split():
            if token.endswith((".js", ".cjs", ".mjs")):
                candidate = os.path.join(pkg_dir_early, token)
                if os.path.exists(candidate):
                    try:
                        with open(candidate, encoding="utf-8", errors="replace") as fh:
                            sources[token] = fh.read()[:200_000]
                    except OSError:
                        pass

    # --- 4. Seed canaries, then run the hook under strace -------------------
    _seed_canaries()
    trace = "/tmp/trace.log"
    hook = next(iter(scripts.values()))
    pkg_dir = os.path.join(WORK, "node_modules", name)

    subprocess.run(
        [
            "strace", "-f", "-tt", "-s", "200",
            "-e", "trace=execve,openat,read,connect,clone,vfork",
            "-o", trace,
            "/bin/sh", "-c", hook,
        ],
        cwd=pkg_dir,
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "HOME": WORK, "PATH": os.environ.get("PATH", "")},
    )

    events = _parse_strace(trace, base_date)
    return {
        "package": package,
        "version": version,
        "lifecycle_scripts": scripts,
        "hook_sources": sources,
        "events": events,
        "event_count": len(events),
    }


@app.function(image=image, timeout=300, secrets=[sim_secret])
@modal.fastapi_endpoint(method="POST", docs=False)
def inspect(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Inspect a real npm package. Body: {"token": "...", "package": "name"}."""
    body = payload or {}
    if body.get("token") != os.environ["SIM_TOKEN"]:
        return {"error": "unauthorized"}
    package = str(body.get("package") or "").strip()
    if not package or not re.fullmatch(r"[@a-z0-9._/-]{1,120}", package):
        return {"error": "invalid package name"}
    try:
        return _inspect(package)
    except subprocess.TimeoutExpired:
        return {"package": package, "error": "inspection timed out", "events": []}


@app.local_entrypoint()
def main(package: str = "esbuild") -> None:
    print(json.dumps(_inspect_local.remote(package), indent=2)[:4000])


@app.function(image=image, timeout=300)
def _inspect_local(package: str) -> dict[str, Any]:
    return _inspect(package)
