"""Offline distribution checks for this package's declared single-module wheel."""
import base64
import csv
import hashlib
import io
import os
from email import policy
from email.parser import BytesParser
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib
from zipfile import ZipFile

PACKAGE = Path(__file__).resolve().parents[1]
MODULE = "semlint_core/__init__.py"


def require(condition, code):
    if not condition:
        raise AssertionError(code)


def verify_payloads(payloads, project, readme, source):
    """This package only: compare its four payloads with the declared source."""
    info = f"semlint_core-{project['version']}.dist-info"
    metadata_path, wheel_path, record_path = [f"{info}/{name}" for name in ("METADATA", "WHEEL", "RECORD")]
    require(set(payloads) == {MODULE, metadata_path, wheel_path, record_path}, "entries")
    require(payloads[MODULE] == source, "module_bytes")
    metadata = BytesParser(policy=policy.default).parsebytes(payloads[metadata_path])
    expected = {"Name": project["name"], "Version": project["version"],
                "Summary": project["description"], "Requires-Python": project["requires-python"]}
    require(not metadata.defects and len(metadata.items()) == 6
            and set(metadata.keys()) == {*expected, "Metadata-Version", "Description-Content-Type"}
            and all(metadata[key] == value for key, value in expected.items())
            and metadata["Metadata-Version"] in ("2.3", "2.4")
            and metadata["Description-Content-Type"] == "text/markdown", "metadata_fields")
    require(metadata.get_payload(decode=True) == readme, "metadata_readme")
    wheel = BytesParser(policy=policy.default).parsebytes(payloads[wheel_path])
    require(not wheel.defects and len(wheel.items()) == 4
            and set(wheel.keys()) == {"Wheel-Version", "Generator", "Root-Is-Purelib", "Tag"}
            and wheel["Wheel-Version"] == "1.0" and wheel["Root-Is-Purelib"] == "true"
            and wheel["Tag"] == "py3-none-any" and str(wheel["Generator"]).startswith("uv "), "wheel_fields")
    rows = list(csv.reader(io.StringIO(payloads[record_path].decode("utf-8"))))
    require(all(len(row) == 3 for row in rows) and len(rows) == len(payloads)
            and {row[0] for row in rows} == set(payloads), "record_entries")
    for name, digest, size in rows:
        if name == record_path:
            require(digest == size == "", "record_self")
        else:
            actual = base64.urlsafe_b64encode(hashlib.sha256(payloads[name]).digest()).decode().rstrip("=")
            require(digest == f"sha256={actual}" and size == str(len(payloads[name])), "record_payload")
    return metadata_path


def read_wheel(path, project):
    directories = {"semlint_core/", f"semlint_core-{project['version']}.dist-info/"}
    with ZipFile(path) as wheel:
        entries = wheel.infolist()
        require(len(entries) == len({entry.filename for entry in entries}), "duplicate_entries")
        payloads = {}
        for entry in entries:
            content = wheel.read(entry)  # Read every entry; ZipFile verifies its CRC.
            if entry.is_dir():
                require(entry.filename in directories and content == b"", "directory_entries")
            else:
                payloads[entry.filename] = content
    return payloads


def run(argv, env, cwd):
    subprocess.run(argv, env=env, cwd=cwd, check=True)


def main():
    project = tomllib.loads((PACKAGE / "pyproject.toml").read_text())["project"]
    require(project["name"] == "semlint-core" and project["dependencies"] == [], "package_contract")
    readme, source = (PACKAGE / project["readme"]).read_bytes(), (PACKAGE / "src" / MODULE).read_bytes()
    uv = shutil.which("uv")
    require(uv is not None, "uv_missing")
    work = Path(tempfile.mkdtemp(prefix="semlint-core-distribution-"))
    # Nix/CI owns its workspace lifetime. This check never recursively deletes it.
    env = {"PATH": os.environ["PATH"], "HOME": str(work), "UV_CACHE_DIR": str(work / "cache"),
           "UV_OFFLINE": "1", "UV_NO_CONFIG": "1", "UV_PYTHON_DOWNLOADS": "never",
           "PYTHONDONTWRITEBYTECODE": "1", "LC_ALL": "C.UTF-8"}
    run([uv, "--version"], env, work)
    wheels = work / "wheels"
    run([uv, "build", "--offline", "--no-config", "--no-python-downloads", "--wheel",
         "--no-create-gitignore", "--python", sys.executable, "--out-dir", str(wheels), str(PACKAGE)], env, work)
    built = list(wheels.glob("*.whl"))
    require(len(built) == 1, "wheel_count")
    payloads = read_wheel(built[0], project)
    metadata_path = verify_payloads(payloads, project, readme, source)
    mutations = [("metadata_readme", metadata_path, payloads[metadata_path] + b"Synthetic mismatch.\n"),
                 ("module_bytes", MODULE, source + b"\n# synthetic mismatch\n"),
                 ("entries", "unexpected.txt", b"synthetic extra")]
    for expected, name, value in mutations:
        changed = {**payloads, name: value}
        try:
            verify_payloads(changed, project, readme, source)
        except AssertionError as error:
            require(str(error) == expected, "negative_reason")
        else:
            raise AssertionError(f"negative_not_rejected:{expected}")
    venv = work / "venv"
    run([uv, "venv", "--offline", "--no-config", "--no-python-downloads", "--python", sys.executable, str(venv)], env, work)
    python = venv / "bin/python"
    run([uv, "pip", "install", "--offline", "--no-config", "--no-deps", "--python", str(python), str(built[0])], env, work)
    installed_check = """import hashlib, importlib.metadata, sys
from pathlib import Path
import semlint_core
root = Path(sys.prefix).resolve()
module = Path(semlint_core.__file__).resolve()
assert module.is_relative_to(root) and 'site-packages' in module.parts, 'installed_location'
assert module.read_bytes() == Path(sys.argv[1]).read_bytes(), 'installed_module_bytes'
dist = importlib.metadata.distribution('semlint-core')
assert Path(dist.locate_file('')).resolve().is_relative_to(root), 'installed_metadata_location'
assert hashlib.sha256(dist.read_text('METADATA').encode()).hexdigest() == sys.argv[2], 'installed_metadata_bytes'
print('Fresh installed module and metadata match the source wheel')
"""
    run([str(python), "-I", "-B", "-c", installed_check, str(PACKAGE / "src" / MODULE),
         hashlib.sha256(payloads[metadata_path]).hexdigest()], env, work)
    run([str(python), "-I", "-B", str(PACKAGE / "tests/test_core.py")], env, work)
    print(f"Distribution PASS: {len(payloads)} payloads, 3 specific negative controls, isolated installed tests")
    print(f"Fresh wheel retained at {built[0]}")


if __name__ == "__main__":
    main()
