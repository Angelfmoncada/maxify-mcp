"""Headless Chrome screenshot helper.

usage: python shot.py <input.html|svg> <out.png> <width> <height> [scale]
"""
import pathlib
import subprocess
import sys
import tempfile

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"


def shot(src: str, out: str, w: int, h: int, scale: float = 1.0) -> None:
    src_uri = pathlib.Path(src).resolve().as_uri()
    out_path = pathlib.Path(out).resolve()
    with tempfile.TemporaryDirectory() as profile:
        cmd = [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            f"--user-data-dir={profile}",
            f"--force-device-scale-factor={scale}",
            f"--window-size={w},{h}",
            "--virtual-time-budget=1500",
            f"--screenshot={out_path}",
            src_uri,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if not out_path.exists():
        sys.stderr.write(res.stderr[-2000:])
        raise SystemExit(f"screenshot failed: {out}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    a = sys.argv
    shot(a[1], a[2], int(a[3]), int(a[4]), float(a[5]) if len(a) > 5 else 1.0)
