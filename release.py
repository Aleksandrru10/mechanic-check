#!/usr/bin/env python3
"""Prepare and verify the update manifest consumed by UpdateActivity."""
import argparse
import hashlib
import json
import re
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ANDROID = "{http://schemas.android.com/apk/res/android}"
REQUIRED = {"schema", "apk", "versionName", "versionCode", "size", "notes", "sha256", "minSdk", "packageName"}


def app_identity():
    manifest = ET.parse(ROOT / "app/AndroidManifest.xml").getroot()
    sdk = manifest.find("uses-sdk")
    return (manifest.attrib["package"], manifest.attrib[ANDROID + "versionName"],
            int(manifest.attrib[ANDROID + "versionCode"]), int(sdk.attrib[ANDROID + "minSdkVersion"]))


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def verify():
    release = json.loads((ROOT / "latest.json").read_text(encoding="utf-8"))
    if set(release) != REQUIRED:
        raise ValueError("latest.json: обязательные поля обновления отсутствуют или переименованы")
    package, version, code, min_sdk = app_identity()
    filename = f"MechanicCheck-{version}.apk"
    if not re.fullmatch(r"MechanicCheck-[0-9]+(?:\.[0-9]+)*\.apk", release["apk"]):
        raise ValueError("latest.json: неверное имя APK")
    if (release["schema"] != 1 or release["packageName"] != package or release["apk"] != filename
            or release["versionName"] != version or release["versionCode"] != code
            or release["minSdk"] != min_sdk or not isinstance(release["notes"], str)):
        raise ValueError("latest.json: поля не совпадают с AndroidManifest.xml")
    apk = ROOT / filename
    if not apk.is_file() or release["size"] != apk.stat().st_size or release["sha256"] != digest(apk):
        raise ValueError("latest.json: размер или SHA-256 APK не совпадает")
    print(f"OK: {filename}, versionCode={code}, size={release['size']}, sha256={release['sha256']}")


def prepare(notes):
    package, version, code, min_sdk = app_identity()
    filename = f"MechanicCheck-{version}.apk"
    source = ROOT / "dist" / filename
    if not source.is_file():
        raise FileNotFoundError(f"Сначала соберите подписанный APK: {source}")
    target = ROOT / filename
    shutil.copyfile(source, target)
    release = {"schema": 1, "apk": filename, "versionName": version, "versionCode": code,
               "size": target.stat().st_size, "notes": notes, "sha256": digest(target),
               "minSdk": min_sdk, "packageName": package}
    (ROOT / "latest.json").write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    verify()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "verify"))
    parser.add_argument("--notes", help="Русское описание изменений для prepare")
    args = parser.parse_args()
    if args.action == "prepare":
        if not args.notes:
            parser.error("prepare требует --notes")
        prepare(args.notes)
    else:
        verify()
