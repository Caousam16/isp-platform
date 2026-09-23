import datetime
import random
#!/usr/bin/env python3
"""RouterOS 6.43+ API-SSL collector with opt-in bandwidth writes. Python 3.10+, stdlib only."""
import argparse
from contextlib import contextmanager
from bandwidth import settings, process_one, lock_writer
import json
import re
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class ProtocolError(Exception):
    pass


def encode_length(n):
    if n < 0 or n > 0xFFFFFFFF:
        raise ProtocolError("Invalid word length")
    if n < 0x80:
        return bytes([n])
    if n < 0x4000:
        return struct.pack("!H", n | 0x8000)
    if n < 0x200000:
        return (n | 0xC00000).to_bytes(3, "big")
    if n < 0x10000000:
        return struct.pack("!I", n | 0xE0000000)
    return b"\xf0" + struct.pack("!I", n)


class API:
    def __init__(self, sock):
        self.sock = sock
        self.deadline = time.monotonic() + 30
        self.remaining = 4_000_000

    def exact(self, n):
        if n > self.remaining:
            raise ProtocolError("Router response exceeds collection limit")
        self.remaining -= n
        result = bytearray()
        while len(result) < n:
            remaining_time = self.deadline - time.monotonic()
            if remaining_time <= 0:
                raise TimeoutError("Collection deadline exceeded")
            self.sock.settimeout(min(10, remaining_time))
            chunk = self.sock.recv(n - len(result))
            if not chunk:
                raise ProtocolError("Router closed connection")
            result.extend(chunk)
        return bytes(result)

    def length(self):
        first = self.exact(1)[0]
        if first < 0x80:
            return first
        if first < 0xC0:
            return ((first & 0x3F) << 8) | int.from_bytes(self.exact(1), "big")
        if first < 0xE0:
            return ((first & 0x1F) << 16) | int.from_bytes(self.exact(2), "big")
        if first < 0xF0:
            return ((first & 0x0F) << 24) | int.from_bytes(self.exact(3), "big")
        if first == 0xF0:
            return int.from_bytes(self.exact(4), "big")
        raise ProtocolError("Unsupported length prefix")

    def sentence(self):
        words = []
        while True:
            length = self.length()
            if length == 0:
                return words
            if length > 65536 or len(words) >= 64:
                raise ProtocolError("Router sentence exceeds limit")
            words.append(self.exact(length).decode("utf-8", errors="replace"))

    def command(self, *words):
        # Commands are built locally; cloud input is restricted to validated settings.
        encoded = [word.encode("utf-8") for word in words]
        self.sock.sendall(b"".join(encode_length(len(w)) + w for w in encoded) + b"\0")
        rows = []
        while True:
            reply = self.sentence()
            if not reply:
                continue
            if reply[0] in ("!trap", "!fatal"):
                # Do not include router responses, credentials or PII in logs.
                raise ProtocolError("Router rejected login; check username, password, api policy and user address restriction" if words[0] == "/login" else "Router rejected command; check read/write policy")
            if reply[0] == "!done":
                return rows
            if reply[0] == "!re":
                row = {}
                for word in reply[1:]:
                    if word.startswith("=") and "=" in word[1:]:
                        key, value = word[1:].split("=", 1)
                        row[key] = value
                rows.append(row)
                if len(rows) > 2000:
                    raise ProtocolError("More than 2000 rows; narrow test scope")
            elif reply[0] != "!empty":
                raise ProtocolError("Unexpected API reply")


def collect(config, progress=lambda stage: None):
    progress("Loading CA certificate")
    context = ssl.create_default_context(cafile=config["ca_file"])
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    progress("Connecting to router TCP port")
    with socket.create_connection((config["router_host"], config.get("router_port", 8729)), timeout=10) as raw:
        progress("Negotiating TLS and verifying router certificate")
        with context.wrap_socket(raw, server_hostname=config["tls_server_name"]) as sock:
            api = API(sock)
            progress("Logging in to RouterOS API")
            api.command("/login", "=name=" + config["router_username"], "=password=" + config["router_password"])
            progress("Reading router identity")
            identity = api.command("/system/identity/print", "=.proplist=name")
            progress("Reading router version and uptime")
            resource = api.command("/system/resource/print", "=.proplist=version,uptime")
            if len(identity) != 1 or len(resource) != 1:
                raise ProtocolError("Missing router identity or resource data")
            queues = []
            for kind in ("simple", "tree"):
                progress("Reading " + kind + " queues")
                properties = ".id,name,parent,max-limit,disabled,dynamic" + (",target,packet-marks,limit-at,burst-limit,burst-threshold,burst-time" if kind == "simple" else "")
                rows = api.command("/queue/" + kind + "/print", "=.proplist=" + properties)
                for row in rows:
                    queues.append({
                        "id": row.get(".id", ""), "kind": kind,
                        "name": row.get("name", ""), "target": row.get("target", ""),
                        "parent": row.get("parent", ""), "maxLimit": row.get("max-limit", ""),
                        "disabled": row.get("disabled") == "true", "dynamic": row.get("dynamic") == "true",
                        **({"settings": settings(row), "packetMarks": row.get("packet-marks", "")} if kind == "simple" else {}),
                    })
            if len(queues) > 2000:
                raise ProtocolError("More than 2000 queues; narrow test scope")
            progress("Reading DHCP leases")
            lease_rows = api.command("/ip/dhcp-server/lease/print",
                "=.proplist=.id,address,mac-address,host-name,server,status,dynamic,comment")
            dhcp_leases = [{
                "id": row.get(".id", ""),
                "address": row.get("address", ""),
                "macAddress": row.get("mac-address", "").upper(),
                "hostName": row.get("host-name", ""),
                "server": row.get("server", ""),
                "status": row.get("status", ""),
                "dynamic": row.get("dynamic") == "true",
                "comment": row.get("comment", ""),
            } for row in lease_rows]
            if len(dhcp_leases) > 2000:
                raise ProtocolError("More than 2000 DHCP leases; narrow test scope")
            return {"collectedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"), "identity": identity[0].get("name", ""), "version": resource[0].get("version", ""),
                    "uptime": resource[0].get("uptime", ""), "queues": queues, "dhcpLeases": dhcp_leases}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the bearer token to a redirected destination.
        return None


@contextmanager
def write_session(config):
    context = ssl.create_default_context(cafile=config["ca_file"])
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    with socket.create_connection((config["router_host"], config.get("router_port", 8729)), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname=config["tls_server_name"]) as sock:
            api = API(sock)
            api.command("/login", "=name=" + config["router_username"], "=password=" + config["router_password"])
            yield api


def post(config, endpoint, body):
    payload = json.dumps(body).encode("utf-8")
    if len(payload) > (4_000_000 if endpoint == "telemetry" else 65_536):
        raise ProtocolError("Payload exceeds upload limit")
    request = urllib.request.Request(config["app_url"].rstrip("/") + "/api/mikrotik/" + endpoint,
        data=payload, headers={"Authorization": "Bearer " + config["connector_token"], "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            data = response.read(65537)
            if len(data) > 65536:
                raise ProtocolError("Oversized server response")
            return json.loads(data)
    except urllib.error.HTTPError as error:
        # Show only known server messages, never arbitrary HTML or echoed credentials.
        try:
            message = json.loads(error.read(4096)).get("message", "")
        except (ValueError, AttributeError):
            message = ""
        allowed = {"Connector not configured", "Snapshot storage unavailable", "Unauthorized",
                   "Command storage unavailable", "Result storage unavailable", "Command state conflict"}
        if message in allowed:
            raise ProtocolError(f"HTTP {error.code}: {message}") from None
        raise


def publish(config, snapshot):
    post(config, "telemetry", snapshot)


def load_config(path, local_only):
    config = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(config, dict):
        raise ValueError("Configuration must be a JSON object")
    keys = ["router_host", "tls_server_name", "ca_file", "router_username", "router_password"]
    if not local_only:
        keys += ["app_url", "connector_token"]
    if any(not isinstance(config.get(key), str) or not config[key] for key in keys):
        raise ValueError("Missing configuration field")
    if not local_only:
        url = urllib.parse.urlsplit(config["app_url"])
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError("app_url must be an HTTPS origin without a path or credentials")
        if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", config["connector_token"]):
            raise ValueError("Use a generated connector token")
    port = config.get("router_port", 8729)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Invalid router port")
    interval = config.get("interval_seconds", 120)
    if type(interval) is not int or not 30 <= interval <= 3600:
        raise ValueError("Interval must be 30–3600 seconds")
    command_interval = config.get("command_interval_seconds", 10)
    if type(command_interval) is not int or not 5 <= command_interval <= 60:
        raise ValueError("Command interval must be 5–60 seconds")
    ca = Path(config["ca_file"])
    if not ca.is_absolute():
        config["ca_file"] = str(Path(path).resolve().parent / ca)
    if type(config.get("enable_writes", False)) is not bool:
        raise ValueError("enable_writes must be boolean")
    return config


def describe_error(error):
    """Describe known failures without printing config, API replies or credentials."""
    if isinstance(error, ssl.SSLCertVerificationError):
        return f"Certificate verification failed (code {error.verify_code}). Check CA, SAN/server name, expiry and clocks."
    if isinstance(error, ssl.SSLError):
        reason = getattr(error, "reason", "") or "UNKNOWN"
        reason = re.sub(r"[^A-Z0-9_]", "", reason)[:100]
        return f"TLS error {reason}. Check the API-SSL server certificate/private key and TLS 1.2 support."
    if isinstance(error, FileNotFoundError):
        return "CA file not found. Relative ca_file paths start in the config.json directory; check the filename and extension."
    if isinstance(error, PermissionError):
        return "Access denied. Check file permissions and local security software."
    if isinstance(error, socket.gaierror):
        return "Router hostname could not be resolved. Use the router LAN IP in router_host."
    if isinstance(error, (TimeoutError, socket.timeout)):
        return "Timed out. Check the router address, TCP port, service allowlist and firewall; if TCP passed, check the displayed stage."
    if isinstance(error, ConnectionRefusedError):
        return "Connection refused. Check API-SSL is enabled on the configured port (normally 8729)."
    if isinstance(error, (ConnectionResetError, ConnectionAbortedError)):
        return "Connection reset/aborted. Check API-SSL service/user address restrictions and whether this is the correct TLS port."
    if isinstance(error, urllib.error.HTTPError):
        return f"Upload returned HTTP {error.code}. See setup troubleshooting."
    if isinstance(error, urllib.error.URLError):
        return "HTTPS upload failed. Check internet connectivity, app URL and HTTPS trust."
    if isinstance(error, ProtocolError):
        return str(error)  # All messages are local constants; never raw RouterOS messages.
    if isinstance(error, OSError):
        return f"OS/network error (errno={error.errno}, winerror={getattr(error, 'winerror', None)}). Check the displayed stage."
    return "Invalid configuration or response. Check configuration values and certificate format."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config.json")
    parser.add_argument("--once", action="store_true", help="Collect and upload once")
    parser.add_argument("--local-only", action="store_true", help="Test TLS/login/queue reads once without upload")
    parser.add_argument("--diagnose", action="store_true", help="Show connection stages without credentials")
    args = parser.parse_args()
    try:
        config = load_config(args.config, args.local_only)
    except (OSError, ValueError, TypeError):
        print("Configuration invalid. Check config.json and the setup guide.", file=sys.stderr)
        return 1
    writer_lock = None
    state_path = str(Path(args.config).resolve()) + ".result.json"
    if not args.local_only:
        try:
            writer_lock = lock_writer(str(Path(args.config).resolve()) + ".lock")
        except OSError:
            print("Another writer is running, or the config directory is not writable.", file=sys.stderr)
            return 1
    stage = "Starting"
    def progress(value):
        nonlocal stage
        stage = value
        if args.diagnose:
            print("[check] " + stage, flush=True)

    next_snapshot = 0
    failures = 0
    while True:
        success = False
        try:
            if not args.local_only and config.get("enable_writes") and Path(state_path).exists():
                progress("Acknowledging saved command result")
                process_one(config, write_session, post, state_path)
            if args.local_only or time.monotonic() >= next_snapshot:
                snapshot = collect(config, progress)
                if not args.local_only:
                    progress("Uploading snapshot")
                    publish(config, snapshot)
                next_snapshot = time.monotonic() + config.get("interval_seconds", 120)
                print(f"Snapshot collected: {len(snapshot['queues'])} queues, {len(snapshot['dhcpLeases'])} DHCP leases", flush=True)
            if not args.local_only and config.get("enable_writes"):
                progress("Processing one bandwidth command")
                wrote = process_one(config, write_session, post, state_path)
                if wrote:
                    snapshot = collect(config, progress)
                    publish(config, snapshot)
                    next_snapshot = time.monotonic() + config.get("interval_seconds", 120)
            success = True
            failures = 0
        except (OSError, ValueError, ProtocolError) as error:
            failures = min(failures + 1, 6)
            print(stage + ": " + describe_error(error), file=sys.stderr, flush=True)
        if args.once or args.local_only:
            return 0 if success else 1
        delay = config.get("command_interval_seconds", 10) if config.get("enable_writes") else max(1, next_snapshot-time.monotonic())
        if failures:
            delay = min(120, 5 * (2 ** failures))
        time.sleep(delay + random.uniform(0, 2))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
