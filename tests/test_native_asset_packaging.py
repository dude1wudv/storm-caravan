import copy
import io
from pathlib import Path
import sys
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools/native-host'))
from probe import runtime_asset_compression
from repack import copy_runtime_entry


class NativeAssetPackagingTest(unittest.TestCase):
    def round_trip(self, name, compression):
        payload = b'ZIP-contract fixture bytes, not playable audio.\x00' * 100
        source = io.BytesIO()
        with zipfile.ZipFile(source, 'w') as archive:
            archive.writestr(name, payload, compress_type=compression, compresslevel=9)
        raw_source = source.getvalue()
        target = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw_source)) as incoming, zipfile.ZipFile(target, 'w') as outgoing:
            old = incoming.getinfo(name)
            repair = copy_runtime_entry(incoming, io.BytesIO(raw_source), outgoing, old)
        with zipfile.ZipFile(io.BytesIO(target.getvalue())) as archive:
            new = archive.getinfo(name)
            self.assertEqual(archive.read(name), payload)
            self.assertEqual(new.CRC, old.CRC)
            self.assertIsNone(archive.testzip())
        return repair, old, new, raw_source, target.getvalue()

    def test_generation_policy_stores_mp3_and_leaves_other_assets_compressed(self):
        for name in ('assets/bundle/native/button.mp3', 'assets/bundle/native/MUSIC.MP3'):
            self.assertEqual(runtime_asset_compression(name), zipfile.ZIP_STORED)
        for name in ('alloy/bootstrap.js', 'assets/bundle/native/texture.pkm', 'assets/config.json'):
            self.assertEqual(runtime_asset_compression(name), zipfile.ZIP_DEFLATED)

    def test_incremental_package_repairs_compressed_audio_without_changing_bytes(self):
        repair, old, new, _, _ = self.round_trip('assets/assets/bundle/native/button.mp3', zipfile.ZIP_DEFLATED)
        self.assertEqual(old.compress_type, zipfile.ZIP_DEFLATED)
        self.assertEqual(new.compress_type, zipfile.ZIP_STORED)
        self.assertEqual(new.file_size, new.compress_size)
        self.assertEqual(repair['previousCompressionMethod'], zipfile.ZIP_DEFLATED)
        self.assertEqual(repair['bytes'], new.file_size)
        self.assertEqual(len(repair['sha256']), 64)

    def test_already_stored_audio_does_not_require_repair(self):
        repair, _, new, _, _ = self.round_trip('assets/assets/bundle/native/button.mp3', zipfile.ZIP_STORED)
        self.assertIsNone(repair)
        self.assertEqual(new.compress_type, zipfile.ZIP_STORED)

    def test_non_audio_compressed_local_record_is_reused_verbatim(self):
        repair, old, new, source, target = self.round_trip('assets/alloy/bootstrap.js', zipfile.ZIP_DEFLATED)
        self.assertIsNone(repair)
        record_size = 30 + len(old.filename.encode('utf-8')) + len(old.extra) + old.compress_size
        self.assertEqual(source[old.header_offset:old.header_offset + record_size],
                         target[new.header_offset:new.header_offset + record_size])

    def test_data_descriptor_and_zip64_remain_rejected(self):
        original = zipfile.ZipInfo('assets/bundle/native/button.mp3')
        for attribute, value in (('flag_bits', 8), ('file_size', 0xffffffff), ('compress_size', 0xffffffff)):
            invalid = copy.copy(original)
            setattr(invalid, attribute, value)
            with self.subTest(attribute=attribute), self.assertRaisesRegex(RuntimeError, 'Unsupported raw APK entry encoding'):
                copy_runtime_entry(None, None, None, invalid)


if __name__ == '__main__':
    unittest.main()
