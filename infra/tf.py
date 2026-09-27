#!/usr/bin/env python3
"""Run Terraform with local dotenv values, without evaluating shell commands."""
import argparse
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def read_env(path):
    values = {}
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        name, sep, raw = line.partition("=")
        name = name.strip()
        if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise ValueError(f"Invalid variable assignment at line {line_number}")
        try:
            parts = shlex.split(raw, comments=True, posix=True)
        except ValueError:
            raise ValueError(f"Invalid quoting at line {line_number}") from None
        if len(parts) > 1:
            raise ValueError(f"Quote values containing spaces at line {line_number}")
        values[name] = parts[0] if parts else ""
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, help="Defaults to infra/.env if present")
    args, terraform_args = parser.parse_known_args()
    if not terraform_args:
        parser.error("Provide a Terraform command, e.g. init, plan or apply")
    env_file = args.env_file or ROOT / ".env"
    env = dict(os.environ)
    try:
        if env_file.exists() or args.env_file:
            for key, value in read_env(env_file).items():
                # Explicit shell credentials/config take precedence over the file.
                env.setdefault(key, value)
        return subprocess.call(["terraform", f"-chdir={ROOT}", *terraform_args], env=env)
    except (OSError, ValueError) as error:
        print(f"Terraform launcher: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
