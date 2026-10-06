"""Public ETC block decoding only; stdin payload -> stdout RGBA, no files/devices."""
import argparse
import importlib.metadata
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--codec', choices=('etc1', 'etc2'), required=True)
    parser.add_argument('--width', type=int, required=True)
    parser.add_argument('--height', type=int, required=True)
    args = parser.parse_args()
    if args.width <= 0 or args.height <= 0 or args.width % 4 or args.height % 4:
        raise ValueError('ETC decoder requires positive block-aligned geometry')
    if args.width * args.height > 128_000_000:
        raise ValueError('ETC decoder input exceeds pixel limit')
    if importlib.metadata.version('texture2ddecoder') != '1.0.6':
        raise ValueError('Required decoder version: texture2ddecoder==1.0.6')
    import texture2ddecoder
    data = sys.stdin.buffer.read()
    if len(data) != args.width * args.height // 2:
        raise ValueError('ETC RGB8 payload length differs from geometry')
    decode = texture2ddecoder.decode_etc2 if args.codec == 'etc2' else texture2ddecoder.decode_etc1
    bgra = decode(data, args.width, args.height)
    if len(bgra) != args.width * args.height * 4:
        raise ValueError('Standard decoder returned invalid pixel length')
    rgba = bytearray(bgra)
    rgba[0::4] = bgra[2::4]
    rgba[2::4] = bgra[0::4]
    sys.stdout.buffer.write(rgba)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No traceback or absolute Python/package paths enter the asset manifest.
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(2)
