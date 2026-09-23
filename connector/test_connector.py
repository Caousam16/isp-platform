import io
import contextlib
import json
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from mikrotik_connector import API, ProtocolError, collect, encode_length, load_config, main, describe_error


class FragmentedSocket:
    def __init__(self, data):
        self.data = bytearray(data)
        self.sent = b""

    def recv(self, n):
        chunk = bytes(self.data[:min(n, 1)])
        del self.data[:len(chunk)]
        return chunk

    def sendall(self, data):
        self.sent += data

    def settimeout(self, value):
        pass


def sentence(*words):
    return b"".join(encode_length(len(w.encode())) + w.encode() for w in words) + b"\0"


class ConnectorTest(unittest.TestCase):
    def test_diagnostic_timeout_reports_stage_without_secrets(self):
        def fail(config, progress):
            progress("Connecting to router TCP port")
            raise TimeoutError("secret-router-password")
        output = io.StringIO()
        with patch("sys.argv", ["connector", "--local-only", "--diagnose"]), \
             patch("mikrotik_connector.load_config", return_value={}), \
             patch("mikrotik_connector.collect", side_effect=fail), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(main(), 1)
        self.assertIn("Connecting to router TCP port", output.getvalue())
        self.assertIn("Timed out", output.getvalue())
        self.assertNotIn("secret-router-password", output.getvalue())

    def test_missing_ca_has_specific_diagnostic(self):
        self.assertIn("CA file not found", describe_error(FileNotFoundError()))

    def test_length_boundaries(self):
        for n in [0, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456]:
            self.assertEqual(API(FragmentedSocket(encode_length(n))).length(), n)

    def test_fragmented_replies_and_equals(self):
        sock = FragmentedSocket(sentence("!re", "=.id=*1", "=name=a=b") + sentence("!done"))
        self.assertEqual(API(sock).command("/queue/simple/print"), [{".id": "*1", "name": "a=b"}])
        self.assertEqual(sock.sent, sentence("/queue/simple/print"))

    def test_trap_eof_and_oversize(self):
        for data in [sentence("!trap", "=message=secret"), b"", encode_length(65537), b"\xf8"]:
            with self.assertRaises(ProtocolError):
                API(FragmentedSocket(data)).command("/queue/simple/print")

    def test_collect_over_real_tls(self):
        with tempfile.TemporaryDirectory() as directory:
            cert, key = str(Path(directory) / "cert.pem"), str(Path(directory) / "key.pem")
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(5)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            commands, errors = [], []

            def server():
                try:
                    conn, _ = listener.accept()
                    with context.wrap_socket(conn, server_side=True) as sock:
                        api = API(sock)
                        replies = [sentence("!done"), sentence("!re", "=name=Lab") + sentence("!done"),
                            sentence("!re", "=version=6.49.19", "=uptime=1d") + sentence("!done"),
                            sentence("!re", "=.id=*1", "=name=Subscriber", "=target=10.0.0.2/32", "=max-limit=10M/20M", "=disabled=false") + sentence("!done"), sentence("!done"), sentence("!done")]
                        for reply in replies:
                            commands.append(api.sentence())
                            sock.sendall(reply)
                except Exception as error:
                    errors.append(error)
                finally:
                    listener.close()

            worker = threading.Thread(target=server, daemon=True)
            worker.start()
            result = collect({"ca_file": cert, "router_host": "127.0.0.1", "router_port": listener.getsockname()[1],
                "tls_server_name": "localhost", "router_username": "test", "router_password": "test"})
            worker.join(timeout=6)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(result["version"], "6.49.19")
            self.assertEqual(result["queues"][0]["maxLimit"], "10M/20M")
            self.assertEqual([c[0] for c in commands], ["/login", "/system/identity/print", "/system/resource/print", "/queue/simple/print", "/queue/tree/print", "/ip/dhcp-server/lease/print"])

    def test_config_rejects_http(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({"router_host": "x", "tls_server_name": "x", "ca_file": "x", "router_username": "x", "router_password": "x", "app_url": "http://example.com", "connector_token": "a" * 43}))
            with self.assertRaises(ValueError):
                load_config(path, False)


if __name__ == "__main__":
    unittest.main()
