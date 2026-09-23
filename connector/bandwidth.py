"""Narrow simple-queue bandwidth writer. No arbitrary RouterOS commands."""
import contextlib
import datetime
import ipaddress
import json
import os
import re
import uuid
from decimal import Decimal
from pathlib import Path

FIELDS = {"maxLimit": "max-limit", "limitAt": "limit-at", "burstLimit": "burst-limit",
          "burstThreshold": "burst-threshold", "burstTime": "burst-time"}
PROPERTIES = ".id,name,target,parent,disabled,dynamic,packet-marks," + ",".join(FIELDS.values())


def settings(row):
    return {key: row.get(field, "") for key, field in FIELDS.items()}


def rate(value):
    match = re.fullmatch(r"(\d+(?:\.\d+)?)([kKmMgG]?)", value)
    if not match:
        raise ValueError("Invalid rate")
    number = Decimal(match[1]) * {"": 1, "k": 1000, "m": 1000000, "g": 1000000000}[match[2].lower()]
    if number != int(number) or not 0 <= number <= 100_000_000_000:
        raise ValueError("Rate outside supported range")
    return int(number)


def duration(value):
    if re.fullmatch(r"\d+(?:\.\d+)?", value):
        return Decimal(value)
    clock = re.fullmatch(r"(\d{1,3}):(\d{2}):(\d{2}(?:\.\d+)?)", value)
    if clock:
        return Decimal(clock[1]) * 3600 + Decimal(clock[2]) * 60 + Decimal(clock[3])
    parts = re.findall(r"(\d+(?:\.\d+)?)(ms|s|m|h)", value)
    if not parts or "".join(n + unit for n, unit in parts) != value:
        raise ValueError("Invalid burst duration")
    return sum(Decimal(n) * {"ms": Decimal(".001"), "s": 1, "m": 60, "h": 3600}[unit] for n, unit in parts)


def normalized(profile):
    if not isinstance(profile, dict) or set(profile) != set(FIELDS):
        raise ValueError("Incomplete settings")
    result = {}
    for key, value in profile.items():
        if not isinstance(value, str) or len(value) > 80 or value.count("/") != 1:
            raise ValueError("Invalid setting")
        result[key] = tuple((duration if key == "burstTime" else rate)(v) for v in value.split("/"))
    return result


def apply_job(api, job, checkpoint):
    outcome = {
        "action": "result",
        "id": job["id"],
        "lease": job["lease"],
        "status": "rejected",
        "code": "precondition_failed",
    }

    writing = False

    try:
        uuid.UUID(job["id"])
        uuid.UUID(job["lease"])

        expiry = datetime.datetime.fromisoformat(
            job["expires_at"].replace("Z", "+00:00")
        )

        if (
            expiry.tzinfo is None
            or expiry <= datetime.datetime.now(datetime.timezone.utc)
        ):
            raise ValueError("Expired")

        identity = job["queue_identity"]

        if (
            set(identity) != {"id", "name", "target"}
            or not re.fullmatch(r"\*[0-9a-fA-F]+", identity["id"])
        ):
            raise ValueError("Invalid queue identity")

        target = ipaddress.ip_network(identity["target"], strict=True)

        if target.version != 4 or target.prefixlen != 32:
            raise ValueError("Queue target must be an IPv4 /32")

        before = normalized(job["expected"])
        desired = normalized(job["desired"])

        if any(v <= 0 for v in desired["maxLimit"]):
            raise ValueError("Unlimited rates are not supported")

        if any(
            lo > hi
            for lo, hi in zip(
                desired["limitAt"],
                desired["maxLimit"],
            )
        ):
            raise ValueError("Guaranteed rate exceeds maximum")

        def read():
            rows = api.command(
                "/queue/simple/print",
                "=.proplist=" + PROPERTIES,
                "?.id=" + identity["id"],
            )

            if len(rows) != 1:
                raise ValueError(
                    f"Queue no longer exists: {identity['id']}"
                )

            row = rows[0]

            if any(
                row.get(k) != identity[field]
                for k, field in [
                    (".id", "id"),
                    ("name", "name"),
                    ("target", "target"),
                ]
            ):
                raise ValueError("Queue identity changed")

            if (
                row.get("dynamic") != "false"
                or row.get("disabled") != "false"
                or row.get("parent") != "none"
                or row.get("packet-marks", "") != ""
            ):
                raise ValueError("Unsupported queue")

            return normalized(settings(row))

        actual_before = read()

        if actual_before != before:
            raise ValueError("Queue settings changed since snapshot")

        # Save uncertain state BEFORE issuing the RouterOS write.
        checkpoint({
            **outcome,
            "status": "uncertain",
            "code": "interrupted",
        })

        writing = True


        api.command(
            "/queue/simple/set",
            "=.id=" + identity["id"],
            *(
                "=" + field + "=" + job["desired"][key]
                for key, field in FIELDS.items()
            ),
        )

        print(
            "RouterOS queue set command completed; verifying...",
            flush=True,
        )

        actual_after = read()


        if actual_after != desired:

            outcome.update(
                status="uncertain",
                code="write_outcome_unknown",
            )

            return outcome

        outcome.update(
            status="applied",
            code="verified",
        )

    except Exception as exc:
        print(
            "Bandwidth command exception:",
            type(exc).__name__,
            flush=True,
        )

        if writing:
            outcome.update(
                status="uncertain",
                code="write_outcome_unknown",
            )
        else:
            outcome.update(
                status="rejected",
                code="precondition_failed",
            )

    return outcome


def save_result(path, result):
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as stream:
        json.dump(result, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def process_one(config, api_factory, post, state_path):
    state_path = Path(state_path)
    # An unacknowledged result is retried, never its router command.
    if state_path.exists():
        saved = json.loads(state_path.read_text(encoding="utf-8"))
        if saved.get("code") == "readback_mismatch":
            saved["code"] = "write_outcome_unknown"
        post(config, "commands", saved)
        state_path.unlink()
        return False
    job = post(config, "commands", {"action": "claim"}).get("job")
    if not job:
        return False
    initial = {"action": "result", "id": job["id"], "lease": job["lease"], "status": "uncertain", "code": "interrupted"}
    save_result(state_path, initial)
    try:
        with api_factory(config) as api:
            result = apply_job(api, job, lambda value: save_result(state_path, value))
    except (OSError, ValueError, RuntimeError):
        # Could not establish the router session; no set command has been issued.
        result = {**initial, "status": "rejected", "code": "precondition_failed"}
    save_result(state_path, result)
    post(config, "commands", result)
    state_path.unlink()
    print("Bandwidth command: " + result["status"], flush=True)
    return True


def lock_writer(path):
    stream = open(path, "a+b")
    stream.seek(0)
    if os.name == "nt":
        import msvcrt
        if not stream.read(1):
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    return stream  # Retain until process exits; OS releases the lock on close/crash.
