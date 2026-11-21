"""Package a self-contained dotnet publish directory with NuGet notices."""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

publish, output = map(Path, sys.argv[1:])
assets = json.loads((Path(__file__).parent / "native/obj/project.assets.json").read_text())
if not (publish / "OrbitChat.exe").is_file() or not (publish / "libsodium.dll").is_file():
    raise SystemExit("Publish Orbit.csproj for win-x64 before packaging.")

with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for file in sorted(publish.rglob("*")):
        if file.is_file() and file.suffix != ".pdb":
            archive.write(file, file.relative_to(publish))
    roots = [Path(p) for p in assets["packageFolders"]]
    packages = {v["path"] for v in assets["libraries"].values() if v["type"] == "package"}
    dependencies = json.loads((publish / "OrbitChat.deps.json").read_text())
    for name in dependencies["libraries"]:
        if name.startswith("runtimepack."):
            packages.add(name.removeprefix("runtimepack.").lower())
    for package in sorted(packages):
        directory = next((root / package for root in roots if (root / package).is_dir()), None)
        if directory is None:
            raise SystemExit(f"Missing restored package {package}")
        manifest = next(directory.glob("*.nuspec"))
        meta = ET.parse(manifest).find("{*}metadata")
        destination = "ThirdParty/" + package + "/"
        archive.write(manifest, destination + manifest.name)
        license_file = meta.find("{*}license")
        documents = {file for file in directory.iterdir() if file.is_file() and
                     any(word in file.name.lower() for word in ("license", "copying", "notice"))}
        if license_file is not None and license_file.get("type") == "file":
            documents.add(directory / license_file.text)
        for file in sorted(documents):
            archive.write(file, destination + file.name)
