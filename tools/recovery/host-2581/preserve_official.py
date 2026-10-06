"""Preserve only the public 2.4.3-generation Android host; never install or build it."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'reports/private/reconstruction/2581/host-recovery'
COMMIT = '3abfe1b3c97bf34786ad9c1cbc8b5efd511d8d74'
BASE = f'https://raw.githubusercontent.com/cocos/engine-native/{COMMIT}/'
PROXY = 'http://127.0.0.1:7890'
JAVA = ['CanvasRenderingContext2DImpl', 'Cocos2dxAccelerometer', 'Cocos2dxActivity',
        'Cocos2dxAudioFocusManager', 'Cocos2dxDownloader', 'Cocos2dxEditBox',
        'Cocos2dxGLSurfaceView', 'Cocos2dxHandler', 'Cocos2dxHelper',
        'Cocos2dxHttpURLConnection', 'Cocos2dxJavascriptJavaBridge',
        'Cocos2dxLocalStorage', 'Cocos2dxOrientationHelper', 'Cocos2dxReflectionHelper',
        'Cocos2dxRenderer', 'Cocos2dxTypefaces', 'Cocos2dxVideoHelper',
        'Cocos2dxVideoView', 'Cocos2dxWebView', 'Cocos2dxWebViewHelper', 'Utils']
FILES = [f'cocos/platform/android/java/src/org/cocos2dx/lib/{name}.java' for name in JAVA]
FILES += [f'cocos/platform/android/java/libs/{name}' for name in
          ['com.android.vending.expansion.zipfile.jar', 'okhttp-3.12.7.jar', 'okio-1.15.0.jar']]
FILES += [f'cocos/platform/android/jni/{name}' for name in
          ['JniImp.cpp', 'JniImp.h', 'JniHelper.cpp', 'JniHelper.h']]


def main():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY}))
    records = []
    failure = None
    for member in FILES:
        path = OUT / 'official-source' / member
        url = BASE + member
        if path.exists():
            data = path.read_bytes()
        else:
            # Preserve partial provenance and stop on failure; never retry or connect directly.
            try:
                with opener.open(urllib.request.Request(url, headers={'User-Agent': '2581-static-host-recovery'}), timeout=45) as response:
                    data = response.read()
            except Exception as error:
                failure = {'member': member, 'error': str(error)}
                break
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        records.append({'path': path.relative_to(ROOT).as_posix(), 'source': url,
                        'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                        'gitBlobSha1': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()})
    manifest = {'repository': 'https://github.com/cocos/engine-native',
                'branch': 'v2.4.3-bufang', 'commit': COMMIT, 'proxy': PROXY,
                'scope': 'Unmodified public Java host, dependent public jars and four JNI reference files only',
                'license': 'MIT notices retained verbatim in source headers; third-party jar notices retained inside jars',
                'versionLimit': 'Retained official 2.4.3-generation branch, not proof of original APK native source commit',
                'files': records}
    manifest['status'] = 'blocked-download' if failure else 'preserved'
    manifest['failure'] = failure
    manifest['remaining'] = [member for member in FILES if not (OUT / 'official-source' / member).exists()]
    (OUT / 'official-source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'files': len(records), 'bytes': sum(r['bytes'] for r in records), 'commit': COMMIT}))
    if failure:
        raise SystemExit('Public source preservation stopped at proxy/download failure; partial provenance retained.')


if __name__ == '__main__':
    main()
