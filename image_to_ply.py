"""이미지 경로를 입력받아 ml-sharp으로 3D Gaussian Splatting .ply 파일을 생성.

사용 예:
    python image_to_ply.py path/to/image.jpg
    python image_to_ply.py path/to/image.jpg -o output_dir
    python image_to_ply.py path/to/folder -o output_dir
    python image_to_ply.py path/to/image.jpg --device cpu
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
ML_SHARP_SRC = THIS_DIR / "ml-sharp" / "src"
if ML_SHARP_SRC.exists() and str(ML_SHARP_SRC) not in sys.path:
    sys.path.insert(0, str(ML_SHARP_SRC))

import torch

from sharp.cli.predict import predict_image
from sharp.models import PredictorParams, create_predictor
from sharp.utils import io
from sharp.utils import logging as logging_utils
from sharp.utils.gaussians import save_ply

DEFAULT_MODEL_URL = "https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt"

LOGGER = logging.getLogger("image_to_ply")


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch, "mps") and torch.mps.is_available():
        return "mps"
    return "cpu"


def collect_image_paths(input_path: Path) -> list[Path]:
    extensions = io.get_supported_image_extensions()
    if input_path.is_file():
        return [input_path] if input_path.suffix in extensions else []
    paths: list[Path] = []
    for ext in extensions:
        paths.extend(input_path.glob(f"**/*{ext}"))
    return sorted(set(paths))


def load_predictor(checkpoint_path: Path | None, device: str):
    t0 = time.perf_counter()
    if checkpoint_path is None:
        LOGGER.info("Downloading default model: %s", DEFAULT_MODEL_URL)
        state_dict = torch.hub.load_state_dict_from_url(DEFAULT_MODEL_URL, progress=True)
    else:
        LOGGER.info("Loading checkpoint: %s", checkpoint_path)
        state_dict = torch.load(checkpoint_path, weights_only=True)

    predictor = create_predictor(PredictorParams())
    predictor.load_state_dict(state_dict)
    predictor.eval()
    predictor.to(device)
    LOGGER.info("Model ready (%.2fs).", time.perf_counter() - t0)
    return predictor


def convert(
    input_path: Path,
    output_dir: Path,
    checkpoint_path: Path | None = None,
    device: str = "auto",
) -> list[Path]:
    image_paths = collect_image_paths(input_path)
    if not image_paths:
        raise FileNotFoundError(f"No supported images found at: {input_path}")

    device = pick_device(device)
    LOGGER.info("Using device: %s", device)
    LOGGER.info("Processing %d image(s).", len(image_paths))

    predictor = load_predictor(checkpoint_path, device)
    output_dir.mkdir(parents=True, exist_ok=True)
    LOGGER.info("Output dir: %s", output_dir.resolve())

    saved_paths: list[Path] = []
    total_start = time.perf_counter()
    for idx, image_path in enumerate(image_paths, start=1):
        LOGGER.info("[%d/%d] → %s", idx, len(image_paths), image_path)

        t_load = time.perf_counter()
        image, _, f_px = io.load_rgb(image_path)
        height, width = image.shape[:2]
        load_sec = time.perf_counter() - t_load

        t_infer = time.perf_counter()
        gaussians = predict_image(predictor, image, f_px, torch.device(device))
        if device == "cuda":
            torch.cuda.synchronize()
        infer_sec = time.perf_counter() - t_infer

        t_save = time.perf_counter()
        out_path = output_dir / f"{image_path.stem}.ply"
        save_ply(gaussians, f_px, (height, width), out_path)
        save_sec = time.perf_counter() - t_save

        size_mb = out_path.stat().st_size / (1024 * 1024)
        LOGGER.info(
            "   saved: %s (%.1f MB) — load %.2fs / infer %.2fs / save %.2fs",
            out_path,
            size_mb,
            load_sec,
            infer_sec,
            save_sec,
        )
        saved_paths.append(out_path)

    total_sec = time.perf_counter() - total_start
    LOGGER.info(
        "Processed %d image(s) in %.2fs (avg %.2fs/img).",
        len(image_paths),
        total_sec,
        total_sec / max(len(image_paths), 1),
    )
    return saved_paths


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert a 2D image (or folder of images) into 3D Gaussian Splatting .ply files using ml-sharp."
    )
    parser.add_argument("input", type=Path, help="입력 이미지 파일 또는 폴더 경로")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=THIS_DIR / "ply_outputs",
        help="결과 .ply 저장 폴더 (기본값: ./ply_outputs)",
    )
    parser.add_argument(
        "-c",
        "--checkpoint",
        type=Path,
        default=None,
        help="체크포인트(.pt) 경로. 지정하지 않으면 Apple CDN에서 자동 다운로드.",
    )
    parser.add_argument(
        "--device",
        choices=["auto", "cpu", "cuda", "mps"],
        default="auto",
        help="추론 디바이스 (기본값: auto)",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="디버그 로그 출력")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging_utils.configure(logging.DEBUG if args.verbose else logging.INFO)

    if not args.input.exists():
        LOGGER.error("입력 경로를 찾을 수 없습니다: %s", args.input)
        return 1

    try:
        saved = convert(
            input_path=args.input,
            output_dir=args.output,
            checkpoint_path=args.checkpoint,
            device=args.device,
        )
    except Exception as exc:
        LOGGER.exception("변환 실패: %s", exc)
        return 1

    LOGGER.info("완료: %d개 .ply 생성 → %s", len(saved), args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
