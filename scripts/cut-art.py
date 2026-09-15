#!/usr/bin/env python3
"""把 AI 生成的透明底 PNG 切成「居中的正方形图标」。

用法：
  python3 scripts/cut-art.py 素材/原图/三餐.png --names 早餐 午餐 晚餐 --out public/art --size 256
  python3 scripts/cut-art.py 素材/原图/信用卡.png --names credit --out public/brand --size 256 --erase 1040,0,1268,530

做的事（顺序不能换）：
  1. 清边：ChatGPT 抠图会留一圈 alpha 在 1~20 之间的黑色残留，肉眼看不见，但会把
     外接框撑大——早餐那张第一次切出来整体偏下 10 像素就是它闹的。alpha < 24 的一律归零。
  2. 切开：一张图里几个物件，按「整列都透明」的位置分开。
  3. 居中：每个物件按实心像素的外接框，放到正方形画布的正中央，四周留 3% 空白。
     居中是算出来的，不是眼睛调的；src/lib/png.test.ts 会再验一遍产物。
  4. 缩到 --size，LANCZOS。

--erase x0,y0,x1,y1 可以先把原图某个区域抹掉（比如信用卡右上角那两道闪光）。
文件名带 -vN 由调用方自己写在 --names 里（如 credit-v1）。
"""
import argparse
import os

import numpy as np
from PIL import Image

ALPHA_FLOOR = 24
PAD = 0.03


def clean(im: Image.Image) -> Image.Image:
    a = np.array(im.split()[3])
    a[a < ALPHA_FLOOR] = 0
    im.putalpha(Image.fromarray(a))
    return im


def split_columns(im: Image.Image, min_width: int = 40) -> list[tuple[int, int]]:
    cols = (np.array(im.split()[3]) > 0).any(axis=0)
    runs, start = [], None
    for x, v in enumerate(cols):
        if v and start is None:
            start = x
        if not v and start is not None:
            runs.append((start, x))
            start = None
    if start is not None:
        runs.append((start, len(cols)))
    return [r for r in runs if r[1] - r[0] >= min_width]


def square(obj: Image.Image, size: int) -> Image.Image:
    w, h = obj.size
    s = int(max(w, h) * (1 + PAD * 2))
    canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    canvas.paste(obj, ((s - w) // 2, (s - h) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def report(path: str) -> None:
    a = np.array(Image.open(path).convert('RGBA').split()[3])
    ys, xs = np.where(a >= ALPHA_FLOOR)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    mid = (a.shape[1] - 1) / 2
    print(f'  {os.path.basename(path)}  框中心 ({cx:.1f}, {cy:.1f})  画布中心 {mid}  偏差 ({cx - mid:+.1f}, {cy - mid:+.1f})')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--names', nargs='+', required=True, help='从左到右每个物件的输出名（不含 .png）')
    ap.add_argument('--out', required=True)
    ap.add_argument('--size', type=int, default=256)
    ap.add_argument('--erase', help='x0,y0,x1,y1，切之前先把这块抹成透明')
    args = ap.parse_args()

    im = clean(Image.open(args.src).convert('RGBA'))
    if args.erase:
        x0, y0, x1, y1 = map(int, args.erase.split(','))
        a = np.array(im.split()[3])
        a[y0:y1, x0:x1] = 0
        im.putalpha(Image.fromarray(a))
    runs = split_columns(im)
    if len(runs) != len(args.names):
        raise SystemExit(f'切出来 {len(runs)} 个物件，但给了 {len(args.names)} 个名字：{runs}')
    os.makedirs(args.out, exist_ok=True)
    for (x0, x1), name in zip(runs, args.names):
        part = im.crop((x0, 0, x1, im.size[1]))
        obj = part.crop(part.split()[3].getbbox())
        path = os.path.join(args.out, f'{name}.png')
        square(obj, args.size).save(path, optimize=True)
        report(path)


if __name__ == '__main__':
    main()
