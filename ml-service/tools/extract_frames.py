"""Extract JPEG frames from a video for the local evaluation dataset."""

import argparse
from pathlib import Path

import cv2


def main():
    parser = argparse.ArgumentParser(description="Sample JPEG frames from a video.")
    parser.add_argument("--video", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--fps", type=float, default=2)
    parser.add_argument("--max-frames", type=int, default=60)
    parser.add_argument("--jpeg-quality", type=int)
    args = parser.parse_args()
    if args.fps <= 0 or args.max_frames < 1:
        parser.error("--fps must be positive and --max-frames must be at least 1")
    if args.jpeg_quality is not None and not 1 <= args.jpeg_quality <= 100:
        parser.error("--jpeg-quality must be between 1 and 100")

    output_dir = Path(args.out)
    output_dir.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(args.video)
    if not capture.isOpened():
        parser.error(f"Could not open video: {args.video}")
    source_fps = capture.get(cv2.CAP_PROP_FPS)
    if not source_fps or source_fps <= 0:
        capture.release()
        parser.error("Video does not report a valid frame rate")
    step = max(1, round(source_fps / args.fps))
    frame_index = saved = 0
    try:
        while saved < args.max_frames:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % step == 0:
                target = output_dir / f"frame_{saved + 1:04d}.jpg"
                options = [] if args.jpeg_quality is None else [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality]
                if not cv2.imwrite(str(target), frame, options):
                    raise RuntimeError(f"Could not write extracted frame {target}")
                saved += 1
            frame_index += 1
    finally:
        capture.release()
    print(f"Saved {saved} JPEG frames to {output_dir}")


if __name__ == "__main__":
    main()
