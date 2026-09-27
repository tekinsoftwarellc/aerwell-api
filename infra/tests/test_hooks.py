"""CodeDeploy hook checks: run scripts/start_server.sh against stub npm/pm2."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
BOX_DIR = "/home/ubuntu/aerwell-api"


class StartServerTests(unittest.TestCase):
    def run_start(self, with_env_file):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "app"
            app.mkdir()
            if with_env_file:
                (app / ".env").write_text("NODE_ENV=production\n")
            script = root / "start_server.sh"
            script.write_text((REPO / "scripts/start_server.sh").read_text().replace(BOX_DIR, str(app)))
            bin_dir = root / "bin"
            bin_dir.mkdir()
            log = root / "calls.log"
            for tool in ("npm", "pm2"):
                stub = bin_dir / tool
                # `pm2 describe` fails: no existing process on a first deploy.
                stub.write_text(f'#!/bin/sh\necho "{tool} $*" >> "{log}"\n'
                                f'[ "{tool} $1" = "pm2 describe" ] && exit 1\nexit 0\n')
                stub.chmod(0o755)
            env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                   "MONGODB_URI": "mongodb://shell-value-must-not-leak"}
            result = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)
            calls = log.read_text().splitlines() if log.exists() else []
            return result, calls

    def test_missing_env_file_fails_before_touching_the_app(self):
        result, calls = self.run_start(with_env_file=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing per-application environment file", result.stderr)
        self.assertEqual(calls, [])

    def test_indexes_sync_before_single_pm2_start_with_drain_timeout(self):
        result, calls = self.run_start(with_env_file=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        verbs = [" ".join(c.split()[:3]) for c in calls]
        self.assertLess(verbs.index("npm ci --omit=dev"), verbs.index("npm run db:sync-indexes"))
        start = next(c for c in calls if c.startswith("pm2 start"))
        self.assertLess(calls.index("npm run db:sync-indexes"), calls.index(start))
        self.assertIn("--kill-timeout=50000", start)
        self.assertNotIn(" -i ", f" {start} ")  # fork mode, exactly one instance
        self.assertEqual(calls[-1], "pm2 save")

    def test_env_file_is_never_written_by_hooks(self):
        for name in ("start_server.sh", "stop_server.sh", "prepare_app_dir.sh", "validate_service.sh"):
            code = "\n".join(line for line in (REPO / "scripts" / name).read_text().splitlines()
                             if not line.lstrip().startswith("#"))
            self.assertNotRegex(code, r"(^|[;&|]\s*)(source|\.)\s", f"{name} sources a file")
            self.assertNotRegex(code, r">>?\s*\"?(\$\{?ENV_FILE|\S*\.env\b)", f"{name} writes the .env")


class AppspecTests(unittest.TestCase):
    def test_bundle_never_ships_env_and_hooks_are_packaged(self):
        buildspec = (REPO / "buildspec.yml").read_text()
        appspec = (REPO / "appspec.yml").read_text()
        self.assertNotRegex(buildspec, r"^\s*- \.env\s*$|^\s*- \.env\b(?!\.example)")
        for hook in ("stop_server.sh", "prepare_app_dir.sh", "start_server.sh", "validate_service.sh"):
            self.assertIn(f"scripts/{hook}", appspec)
            self.assertIn(f"scripts/{hook}", buildspec)
        self.assertIn(f"destination: {BOX_DIR}", appspec)
        self.assertIn("/api/v1/health", (REPO / "scripts/validate_service.sh").read_text())


if __name__ == "__main__":
    unittest.main()
