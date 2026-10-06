"""Recover a bounded texture set through the APK's file-level Image loader.

Run with the existing original-decoder-venv (texture2ddecoder==1.0.6).
This translates the observed native resource permutation, not game JavaScript.
Only the assigned private report directory is written; rejected assets stay intact.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import zipfile

import PIL
from PIL import Image
import texture2ddecoder

APK_SHA256 = "d660393138d25d6419bc814e1662a3b693cb0a7cc973e3759b5e840271146e63"
X86_SHA256 = "e77de4f8d9dfca64d85d5f4438f973cad51162d6aef934afab6728b17bed6a5f"
ARM64_SHA256 = "e644052a3b365533bb1bd3d9952a21a99cdf58fe6a98561801146a528393d24a"
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "reports/private/reconstruction/2581/visual-recovery"
MAP_UUID = "39ddb0fa-fe9f-493e-aa51-856cbaab230d"
HOME_UUID = "66486e54-8600-4a54-9020-f484ed3880cc"
TXT_UUID = "fdcc102d-7050-4ee0-92bb-f77e9e1df06d"
POINTER_UUID = "693f44be-e4a0-442d-a7f9-87bd8e9ecc3d"
FRAME_UUIDS = ["5910e3e8-05d2-4344-8af1-470ff67aa91d", "51dc1da2-6a61-44a8-8077-4a1bb32e2b9e"]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(relative, data):
    path = OUT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_bytes() != data:
        path.write_bytes(data)
    return {"path": path.relative_to(ROOT).as_posix(), "sha256": digest(data), "bytes": len(data)}


def mapped_bytes(elf, address, length):
    """Read a known public resource-format literal through ELF PT_LOAD mapping."""
    if elf[:6] not in (b"\x7fELF\x01\x01", b"\x7fELF\x02\x01"):
        raise ValueError("Expected audited little-endian ELF")
    is64 = elf[4] == 2
    phoff = struct.unpack_from("<Q" if is64 else "<I", elf, 32 if is64 else 28)[0]
    entsize, count = struct.unpack_from("<HH", elf, 54 if is64 else 42)
    for index in range(count):
        fields = struct.unpack_from("<II6Q" if is64 else "<8I", elf, phoff + index * entsize)
        kind = fields[0]
        offset, vaddr, filesz = (fields[2], fields[3], fields[5]) if is64 else (fields[1], fields[2], fields[4])
        if kind == 1 and vaddr <= address and address + length <= vaddr + filesz:
            return elf[offset + address - vaddr:offset + address - vaddr + length]
    raise ValueError("Native resource literal address is not file-backed")


def validated_native_state(x86, arm64):
    x86_literal = mapped_bytes(x86, 0x70203B, 4) + mapped_bytes(x86, 0x702044, 2) + mapped_bytes(x86, 0x70204A, 1)
    arm64_literal = mapped_bytes(arm64, 0x15F30E4, 7)
    if x86_literal != arm64_literal or x86_literal[-1:] != b"\0" or not x86_literal[:-1].isdigit():
        raise ValueError("Original atoi inputs differ or cannot be translated exactly")
    value = int(x86_literal[:-1].decode("ascii"), 10)
    state = 0x1E7FE if value == 0x1B7C5 else 0x3038
    if state != 0x1E7FE:
        raise ValueError("Audited native branch changed; recovery must be re-reviewed")
    return state, {
        "operation": "Read original ELF-backed ASCII inputs, verify ABI equality, translate original atoi and conditional state selection",
        "x86LiteralInstructionAddresses": ["0x702037", "0x70203f", "0x702046"],
        "arm64LiteralAddress": "0x15f30e4",
        "literalSha256": digest(x86_literal),
        "selectedBranch": "equal-to-original-comparison-value",
        "loopBoundary": "offset=8; offset+8<size; stride=8; final eight bytes untouched",
        "boundaryEvidence": ["x86 0x7020c0..0x7020c9", "arm64 0x81fc04..0x81fc10"],
    }


def native_file_transform(source, initial_state):
    """Exact 0x702000..0x70214a branch of APK x86 Image::initWithImageFile.

    Header replacement is followed by deterministic eight-byte block half swaps.
    The loop includes the geometry block at byte 8, skips either grayscale
    three-byte half, and leaves the final eight bytes untouched. It is deliberately
    not a visual/channel heuristic.
    """
    if len(source) < 16 or source[:6] != b"PNG 10" or (len(source) - 8) % 8:
        raise ValueError("Not the supported original PNG 10 block container")
    data = bytearray(source)
    data[:3] = b"PKM"
    state = initial_state
    changed = 0
    for offset in range(8, len(data) - 8, 8):
        state = (state * 0x1D7 + 0xC091) % 0x174EF
        if state % 2 != 1:
            continue
        block = data[offset:offset + 8]
        if block[0] == block[1] == block[2] or block[4] == block[5] == block[6]:
            continue
        data[offset:offset + 8] = block[4:] + block[:4]
        changed += 1
    return bytes(data), changed


def invalid_etc1_blocks(payload):
    bad = 0
    for offset in range(0, len(payload), 8):
        high = int.from_bytes(payload[offset:offset + 4], "big")
        if high & 2:
            for shift in [24, 16, 8]:
                byte = (high >> shift) & 255
                delta = byte & 7
                delta = delta - 8 if delta > 3 else delta
                if not 0 <= (byte >> 3) + delta <= 31:
                    bad += 1
                    break
    return bad


def decode_texture(z, asset, shader_evidence, initial_state, remaining_output_bytes):
    natives = [n for n in asset["native"] if n["extension"] == "pkm"]
    if len(natives) != 1 or asset["textureSettings"]["pixelFormat"] != 1026:
        raise ValueError("Expected an explicit single ETC1 alpha-atlas texture")
    native = natives[0]
    source = z.read(native["sourceEntry"])
    if digest(source) != native["sha256"]:
        raise ValueError("Preserved source hash mismatch")
    restored, swaps = native_file_transform(source, initial_state)
    fmt, ew, eh, width, height = struct.unpack(">5H", restored[6:16])
    # Original etc1_pkm_is_valid accepts <4 padded pixels; get_width/get_height
    # read logical dimensions at bytes 12/14. Decode encoded blocks, then crop
    # each original RGB/alpha plane to the logical dimensions.
    if fmt != 0 or width <= 0 or height <= 0 or ew != (width + 3) // 4 * 4 or eh != (height + 3) // 4 * 4 or height % 8:
        raise ValueError("Unsupported original ETC1 geometry or alpha-plane alignment")
    if len(restored) != 16 + ew * eh // 2:
        raise ValueError("Payload size differs from native ETC1 container")
    bad = invalid_etc1_blocks(restored[16:])
    if bad:
        raise ValueError(f"Restored payload has {bad} invalid standard ETC1 blocks")
    if texture2ddecoder.__version__ != "1.0.6":
        raise ValueError("Only the existing pinned ETC decoder is supported")
    # texture2ddecoder's documented output is BGRA; this is byte-format handling.
    raw = texture2ddecoder.decode_etc1(restored[16:], ew, eh)
    sheet = Image.frombytes("RGBA", (ew, eh), raw, "raw", "BGRA")
    rgb = sheet.crop((0, 0, width, height // 2))
    alpha = sheet.crop((0, height // 2, width, height)).getchannel("R")
    rgb.putalpha(alpha)
    import io
    buffer = io.BytesIO()
    rgb.save(buffer, format="PNG")
    if len(buffer.getvalue()) > remaining_output_bytes:
        raise ValueError("Explicit output-byte budget exceeded before writing PNG")
    output = save(f"textures/{asset['uuid']}.png", buffer.getvalue())
    return rgb, {
        "uuid": asset["uuid"], "logicalIds": asset.get("logicalIds", []),
        "source": {"apkMember": native["sourceEntry"], "sha256": digest(source), "bytes": len(source)},
        "descriptor": {"apkMember": asset["importEntry"], "sha256": digest(z.read(asset["importEntry"])),
                       "pixelFormat": 1026, "serialized": asset["textureSettings"]["serialized"]},
        "operation": "native-file-level PNG-to-PKM block permutation; standard ETC1; original alpha-atlas GLSL red plane",
        "transformedContainerSha256": digest(restored), "swappedBlocks": swaps,
        "invalidDifferentialBlocksAfter": bad,
        "width": rgb.width, "height": rgb.height, "encodedWidth": ew, "encodedHeight": eh,
        "alphaEvidence": shader_evidence,
        "output": output,
        "confidence": "source-derived-native-format; original-display-comparison-pending",
        "status": "recovered-pixels-not-gameplay-validated",
    }


def main():
    global OUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--objdump", type=Path, required=True)
    parser.add_argument("--scope", choices=["samples", "expanded", "all-1026"], default="samples")
    parser.add_argument("--uuid", action="append", help="Further narrow the chosen scope to explicit source UUIDs")
    parser.add_argument("--max-output-bytes", type=int, default=2_200_000_000)
    args = parser.parse_args()
    base_out = OUT
    prior_sample_path = base_out / "manifest.json"
    prior_sample = json.loads(prior_sample_path.read_text(encoding="utf8")) if prior_sample_path.exists() else None
    if args.scope == "all-1026":
        OUT = base_out / "all-1026"
    manifest = json.loads((ROOT / "assets/manifests/original-assets.json").read_text(encoding="utf8"))
    by_uuid = {a["uuid"]: a for a in manifest["assets"]}
    evidence = []
    with zipfile.ZipFile(args.apk) as z:
        elf_bytes = z.read("lib/x86/libcocos2djs.so")
        if digest(elf_bytes) != X86_SHA256:
            raise ValueError("The original native entry is not the audited APK engine")
        # A bounded original binary copy is retained as reproducible native evidence.
        engine = save("source/libcocos2djs-x86.so", elf_bytes)
        elf_path = ROOT / engine["path"]
        functions = [
            ("image-file", 0x701F20, 0x2AF),
            ("file-utils-android", 0x5A2AD0, 0x409),
            ("js-load-image", 0x6584A0, 0x375),
            ("jsb-global-load-image", 0x656A00, 0x1204),
        ]
        for name, address, length in functions:
            run = subprocess.run([str(args.objdump), "--disassemble", "--demangle",
                                  f"--start-address={address}", f"--stop-address={address + length}", str(elf_path)],
                                 check=True, capture_output=True)
            evidence.append({"kind": "original-native-disassembly", "name": name,
                             "apkMember": "lib/x86/libcocos2djs.so", "sourceSha256": X86_SHA256,
                             "address": hex(address), "size": length,
                             "output": save(f"evidence/{name}.asm", run.stdout)})
        arm64_bytes = z.read("lib/arm64-v8a/libcocos2djs.so")
        if digest(arm64_bytes) != ARM64_SHA256:
            raise ValueError("Target arm64 native entry differs from audited baseline")
        arm64_engine = save("source/libcocos2djs-arm64.so", arm64_bytes)
        initial_state, branch_evidence = validated_native_state(elf_bytes, arm64_bytes)
        evidence.append({"kind": "native-branch-and-loop-boundary", **branch_evidence})
        arm64_run = subprocess.run([
            str(args.objdump), "--disassemble", "--demangle",
            "--start-address=0x81fa54", "--stop-address=0x81fd18",
            str(ROOT / arm64_engine["path"]),
        ], check=True, capture_output=True)
        evidence.append({
            "kind": "original-native-disassembly", "name": "image-file-arm64",
            "apkMember": "lib/arm64-v8a/libcocos2djs.so", "sourceSha256": ARM64_SHA256,
            "address": "0x81fa54", "size": 0x2C4,
            "transformRange": "0x81fb10..0x81fc84", "downstreamCall": "0x81fcb8",
            "output": save("evidence/image-file-arm64.asm", arm64_run.stdout),
            "observedParity": "same header replacement, branch-selected initial state, recurrence, block offset/stride, parity test, grayscale skip, and half swap as x86",
            "scope": "manual static instruction comparison; neither engine executed",
        })
        shader_member = "assets/assets/internal/import/28/2874f8dd-416c-4440-81b7-555975426e93.json"
        shader = z.read(shader_member)
        if b"v_uv0 + vec2(0, 0.5)" not in shader or b"CC_USE_ALPHA_ATLAS_texture" not in shader:
            raise ValueError("Original shader evidence no longer establishes the alpha sampling rule")
        shader_info = {"apkMember": shader_member, "sha256": digest(shader),
                       "output": save("source/builtin-sprite-effect.json", shader),
                       "rule": "texture_tmp.a *= texture(texture, v_uv0 + vec2(0, 0.5)).r"}
        evidence.append(shader_info)
        wanted = [MAP_UUID, HOME_UUID]
        if args.scope == "expanded":
            wanted += [TXT_UUID, POINTER_UUID]
        elif args.scope == "all-1026":
            wanted = [a["uuid"] for a in manifest["assets"]
                      if a.get("type") == "cc.Texture2D"
                      and a.get("textureSettings", {}).get("pixelFormat") == 1026]
            # The expansion has an independent output tree; no rejected paths are reused.
        if args.uuid:
            unknown = set(args.uuid) - set(wanted)
            if unknown:
                raise ValueError(f"Requested UUIDs are outside the selected source scope: {sorted(unknown)}")
            wanted = [uid for uid in wanted if uid in args.uuid]
        textures = {}
        results = []
        failures = []
        output_bytes = 0
        cached = {r["uuid"]: r for r in prior_sample.get("textures", [])} if prior_sample else {}
        checkpoint = {
            "schemaVersion": 1, "baseline": 2581, "sourceApkSha256": APK_SHA256,
            "status": "recovery-in-progress", "scope": args.scope, "requestedUuidCount": len(wanted),
            "sourceManifestSha256": digest((ROOT / "assets/manifests/original-assets.json").read_bytes()),
            "evidence": evidence, "textures": results, "failures": failures,
            "limitBytes": args.max_output_bytes,
        }
        for position, uid in enumerate(wanted):
            try:
                asset = by_uuid[uid]
                source_descriptor = z.read(asset["importEntry"])
                preserved_descriptor = json.loads((ROOT / asset["descriptor"]["path"]).read_text(encoding="utf8"))
                if preserved_descriptor["serialized"] != json.loads(source_descriptor):
                    raise ValueError("Preserved descriptor differs from original APK serialization")
                previous = cached.get(uid) if args.scope == "all-1026" else None
                if previous:
                    if not prior_sample.get("method", {}).get("loopBoundaryCorrected"):
                        raise ValueError("Sample result predates corrected original loop boundary")
                    data = (ROOT / previous["output"]["path"]).read_bytes()
                    if digest(data) != previous["output"]["sha256"]:
                        raise ValueError("Sample output hash changed")
                    if digest(z.read(previous["source"]["apkMember"])) != previous["source"]["sha256"]:
                        raise ValueError("Sample source hash differs from original member")
                    if len(data) > args.max_output_bytes - output_bytes:
                        raise ValueError("Explicit output-byte budget exceeded before copying sample")
                    result = dict(previous)
                    result["output"] = save(f"textures/{uid}.png", data)
                    result["operationReuse"] = "Copy SHA-verified corrected sample pixels; no duplicate decode"
                    image = None
                else:
                    image, result = decode_texture(z, asset, shader_info, initial_state, args.max_output_bytes - output_bytes)
                output_bytes += result["output"]["bytes"]
                if output_bytes > args.max_output_bytes:
                    raise ValueError("Explicit output-byte budget exceeded; no further textures attempted")
                if args.scope != "all-1026":
                    textures[uid] = image
                results.append(result)
                if args.scope == "all-1026" and image is not None:
                    image.close()
            except (ValueError, RuntimeError) as error:
                failures.append({"uuid": uid, "status": "unrecovered", "reason": str(error),
                                 "sourceMembers": [{"apkMember": n["sourceEntry"], "sha256": n["sha256"]}
                                                   for n in by_uuid[uid].get("native", [])]})
                if "output-byte budget" in str(error):
                    failures.append({"status": "remaining-scope-not-attempted", "reason": "output-byte-budget"})
                    break
                if args.scope != "all-1026":
                    raise
            checkpoint["processedUuidCount"] = position + 1
            checkpoint["textureOutputBytes"] = output_bytes
            save("manifest.json", (json.dumps(checkpoint, ensure_ascii=False, indent=2) + "\n").encode("utf8"))
        sprites = []
        for uid in FRAME_UUIDS:
            asset = by_uuid[uid]
            texture_uuid = asset["references"][0]["uuid"]
            if texture_uuid not in textures:
                continue
            frame = asset["spriteFrame"]
            x, y, w, h = frame["rect"]
            image = textures[texture_uuid]
            rw, rh = (h, w) if frame.get("rotated") else (w, h)
            if x < 0 or y < 0 or x + rw > image.width or y + rh > image.height:
                raise ValueError("Original SpriteFrame is outside recovered texture")
            sprite = image.crop((x, y, x + rw, y + rh))
            if frame.get("rotated"):
                sprite = sprite.transpose(Image.Transpose.ROTATE_90)
            import io
            buffer = io.BytesIO()
            sprite.save(buffer, format="PNG")
            sprites.append({"uuid": uid, "name": frame["name"], "textureUuid": texture_uuid,
                            "originalSpriteFrame": frame,
                            "source": {"apkMember": asset["importEntry"], "sha256": digest(z.read(asset["importEntry"]))},
                            "operation": "original SpriteFrame rectangular crop and Cocos rotated-atlas undo",
                            "output": save(f"sprites/{uid}.png", buffer.getvalue()),
                            "confidence": "source-derived; rotation-original-display-comparison-pending"})
        boundary_correction = None
        if prior_sample and args.scope != "all-1026":
            old_by_uuid = {r["uuid"]: r for r in prior_sample.get("textures", [])}
            boundary_correction = {
                "oldMethod": "range(8,size,8)",
                "correctedMethod": "range(8,size-8,8); original atoi inputs checked through both ELF mappings",
                "evidence": branch_evidence,
                "samples": [{"uuid": r["uuid"], "initialOutput": old_by_uuid[r["uuid"]]["output"],
                             "correctedOutput": r["output"],
                             "outputHashChanged": old_by_uuid[r["uuid"]]["output"]["sha256"] != r["output"]["sha256"],
                             "transformedContainerHashChanged": old_by_uuid[r["uuid"]]["transformedContainerSha256"] != r["transformedContainerSha256"]}
                            for r in results if r["uuid"] in old_by_uuid],
            }
            save("evidence/initial-sample-boundary-audit.json",
                 (json.dumps(boundary_correction, ensure_ascii=False, indent=2) + "\n").encode("utf8"))
        skeleton_index = []
        recovered_ids = {r["uuid"] for r in results}
        for asset in manifest["assets"]:
            spine = asset.get("spine")
            if not spine or not any(t.get("uuid") in recovered_ids for t in spine.get("textures", [])):
                continue
            descriptor_bytes = z.read(asset["importEntry"])
            skeleton_index.append({
                "uuid": asset["uuid"], "logicalIds": asset.get("logicalIds", []),
                "sourceDescriptor": {"apkMember": asset["importEntry"], "sha256": digest(descriptor_bytes)},
                "originalSkeleton": [{"apkMember": n["sourceEntry"], "sha256": n["sha256"], "preservedPath": n["path"]}
                                     for n in asset.get("native", [])],
                "spineVersion": spine["version"], "atlasText": spine["atlasText"],
                "pages": spine["pages"], "textures": spine["textures"],
                "status": "source-association-only; no animation frames generated",
            })
        skeleton_output = save("skeleton-texture-index.json",
                               (json.dumps(skeleton_index, ensure_ascii=False, indent=2) + "\n").encode("utf8"))
        report = {
            "schemaVersion": 1, "baseline": 2581, "sourceApkSha256": APK_SHA256,
            "apkFingerprintHandling": "Known baseline fingerprint reused; no redundant full-APK hash",
            "scope": {"selection": args.scope, "requestedUuidCount": len(wanted), "sourceManifest": "assets/manifests/original-assets.json",
                      "sourceManifestSha256": digest((ROOT / "assets/manifests/original-assets.json").read_bytes()),
                      "maxOutputBytes": args.max_output_bytes, "textureOutputBytes": output_bytes},
            "status": "native-PNG10-transform-recovered; original-display-and-runtime-validation-pending",
            "method": {"entry": "cocos2d::Image::initWithImageFile", "apkMember": "lib/x86/libcocos2djs.so",
                       "sourceSha256": X86_SHA256, "address": "0x701f20", "transformRange": "0x702000..0x70214a",
                       "downstream": "Image::initWithImageData at call 0x702184; standard ETC1 validator and payload",
                       "description": "Translate only the original file-level deterministic eight-byte permutation and original alpha GLSL; do not invoke engine or game JS",
                       "decoder": "texture2ddecoder==1.0.6", "pillow": PIL.__version__},
            "evidence": evidence, "engineSource": engine, "textures": results, "sprites": sprites, "failures": failures,
            "comparisonConditions": [
                "Compare map1/map_111 only after uniquely matching original 2581 reference scene and source map geometry.",
                "Compare ButtonTeam/home_btn_biandui1 and txt_home_biandui at native scale with source LayoutMain nodes, preserving original material/tint/opacity/rotation.",
                "Compare map-pointer atlas against matching original skeleton/atlas; do not substitute a baked frame from the rejected catalog.",
                "Validate native runtime invocation before integrating recovered assets; both ABI transforms are statically documented.",
            ],
            "limitations": [
                "No original device, account, server, build, test, lint, or gameplay execution performed.",
                "No fresh original screenshot comparison; dimensions and native format evidence are not full UI/map behavior acceptance.",
                "No animation frames restored; original skeleton remains necessary for live animation.",
                "x86 and target arm64 file-level transforms were both inspected statically; native runtime invocation remains unverified.",
                "Only the explicitly selected manifest scope was recovered; no old rejected asset/manifest/formats modifications.",
            ],
            "unrecovered": ["other textures outside the explicit bounded set", "rendered maps", "animation playback and baked frames", "original-reference pixel comparison", "native runtime invocation"],
        }
        report["method"]["loopBoundaryCorrected"] = True
        report["method"]["branchEvidence"] = branch_evidence
        report["boundaryCorrection"] = boundary_correction
        report["skeletonTextureIndex"] = skeleton_output
        save("manifest.json", (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf8"))
        print(json.dumps({"manifest": (OUT / "manifest.json").relative_to(ROOT).as_posix(),
                          "textures": len(results), "sprites": len(sprites), "invalidEtcBlocks": sum(r["invalidDifferentialBlocksAfter"] for r in results)}))


if __name__ == "__main__":
    main()
