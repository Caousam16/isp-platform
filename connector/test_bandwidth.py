import copy
import contextlib
import datetime
import json
import tempfile
import unittest
from pathlib import Path
from bandwidth import apply_job, normalized, process_one, save_result

BASE = {"maxLimit": "100M/100M", "limitAt": "100M/100M", "burstLimit": "110M/110M", "burstThreshold": "110M/110M", "burstTime": "8s/8s"}
NEW = {"maxLimit": "10000000/30000000", "limitAt": "10000000/30000000", "burstLimit": "20000000/40000000", "burstThreshold": "20000000/40000000", "burstTime": "8s/8s"}
FIELDS = {"maxLimit": "max-limit", "limitAt": "limit-at", "burstLimit": "burst-limit", "burstThreshold": "burst-threshold", "burstTime": "burst-time"}


def job():
    return {"id": "00000000-0000-4000-8000-000000000001", "lease": "00000000-0000-4000-8000-000000000002",
            "queue_identity": {"id": "*1", "name": "JUAN 999", "target": "192.168.1.2/32"},
            "expected": copy.deepcopy(BASE), "desired": copy.deepcopy(NEW),
            "expires_at": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)).isoformat()}


class Router:
    def __init__(self):
        self.row = {".id": "*1", "name": "JUAN 999", "target": "192.168.1.2/32", "parent": "none", "dynamic": "false", "disabled": "false", "packet-marks": "",
                    **{field: BASE[key] for key, field in FIELDS.items()}}
        self.writes = 0
        self.disconnect = False
        self.mismatch = False

    def command(self, command, *words):
        if command == "/queue/simple/print":
            return [self.row.copy()]
        assert command == "/queue/simple/set"
        assert "=.id=*1" in words
        self.writes += 1
        for word in words:
            key, value = word[1:].split("=", 1)
            if key != ".id" and not self.mismatch:
                self.row[key] = value
        if self.disconnect:
            raise ConnectionResetError()
        return []


class BandwidthTests(unittest.TestCase):
    def test_apply_and_restore_all_original_fields(self):
        api, command = Router(), job()
        checkpoints = []
        result = apply_job(api, command, checkpoints.append)
        self.assertEqual(result["status"], "applied")
        self.assertEqual(api.row["max-limit"], "10000000/30000000")
        self.assertEqual(api.row["limit-at"], "10000000/30000000")
        self.assertEqual(api.row["burst-limit"], "20000000/40000000")
        self.assertEqual(checkpoints[0]["status"], "uncertain")
        command["expected"], command["desired"] = command["desired"], command["expected"]
        result = apply_job(api, command, checkpoints.append)
        self.assertEqual(result["status"], "applied")
        self.assertEqual({key: api.row[field] for key, field in FIELDS.items()}, BASE)

    def test_preconditions_prevent_writes(self):
        for mutation in [lambda q: q.update(target="192.168.1.4/32"), lambda q: q.update(name="Other"),
                         lambda q: q.update(dynamic="true"), lambda q: q.update(disabled="true"),
                         lambda q: q.update(parent="parent"), lambda q: q.update({"burst-limit": "120M/120M"})]:
            api = Router(); mutation(api.row)
            self.assertEqual(apply_job(api, job(), lambda x: None)["status"], "rejected")
            self.assertEqual(api.writes, 0)
        api = Router()
        command = job(); command["expires_at"] = "2000-01-01T00:00:00+00:00"
        self.assertEqual(apply_job(api, command, lambda x: None)["status"], "rejected")
        self.assertEqual(api.writes, 0)

    def test_uncertain_write_is_not_reported_as_failure_or_success(self):
        for mode in ["disconnect", "mismatch"]:
            api = Router(); setattr(api, mode, True)
            result = apply_job(api, job(), lambda x: None)
            self.assertEqual(result["status"], "uncertain")
            self.assertEqual(api.writes, 1)

    def test_ack_retry_never_replays_write(self):
        api, command = Router(), job()
        calls, failed_once = [], [False]
        def post(config, endpoint, body):
            calls.append(body)
            if body["action"] == "claim": return {"job": command}
            if not failed_once[0]:
                failed_once[0] = True
                raise ConnectionResetError()
            return {"message": "Result recorded"}
        @contextlib.contextmanager
        def session(config): yield api
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            config = {"allowed_queues": {"JUAN 999": "192.168.1.2/32"}}
            with self.assertRaises(ConnectionResetError): process_one(config, session, post, path)
            self.assertTrue(path.exists())
            process_one(config, session, post, path)
            self.assertFalse(path.exists())
            self.assertEqual(api.writes, 1)
            self.assertEqual(sum(c["action"] == "claim" for c in calls), 1)

    def test_rate_units_and_duration_are_compared_semantically(self):
        equivalent = {**BASE, "maxLimit": "100000000/100000000", "burstTime": "8000ms/8s"}
        self.assertEqual(normalized(BASE), normalized(equivalent))
        for value in ["0; /system/reboot/0", "-1/1", "100000000001/1"]:
            with self.assertRaises(ValueError): normalized({**BASE, "maxLimit": value})

    def test_checkpoint_failure_prevents_write(self):
        api = Router()
        def fail(value): raise OSError()
        self.assertEqual(apply_job(api, job(), fail)["status"], "rejected")
        self.assertEqual(api.writes, 0)


if __name__ == "__main__": unittest.main()
