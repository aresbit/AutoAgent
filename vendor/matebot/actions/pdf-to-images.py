---
name: pdf-to-images
description: 把 PDF 逐页渲染成图片（pdftoppm），供多模态读图用。args: path=<PDF,必填>, out=<目录,默认 ~/yysdl/pdfimg/<stem>>, dpi=110, fmt=jpeg|png, pages=3-7|5, gray=1
language: python
---

#!/usr/bin/env python3
"""把 PDF 逐页渲染成图片（jpeg/png）。Action 正文，不带 frontmatter。"""
import os
import re
import shutil
import subprocess

a = _ACTION_ARGS

path = (a.get("path") or "").strip()
if not path:
    print("ERR 缺 path。用法: pdf-to-images path=<PDF> [out=<目录>] [dpi=110] "
          "[fmt=jpeg|png] [pages=3-7|5] [gray=1]")
    raise SystemExit(1)

if not os.path.isfile(path):
    print("ERR 文件不存在: %s" % path)
    raise SystemExit(1)
if os.path.splitext(path)[1].lower() != ".pdf":
    print("ERR 只接受 .pdf，收到: %s" % path)
    raise SystemExit(1)
if not shutil.which("pdftoppm"):
    print("ERR 找不到 pdftoppm（装 poppler-utils）")
    raise SystemExit(1)

fmt = (a.get("fmt") or "jpeg").strip().lower()
if fmt in ("jpg", "jpeg"):
    fmt, ext = "jpeg", ".jpg"
elif fmt == "png":
    ext = ".png"
else:
    print("ERR fmt 只支持 jpeg | png，收到 %r" % fmt)
    raise SystemExit(1)

try:
    dpi = int(a.get("dpi") or 110)
except ValueError:
    print("ERR dpi 必须是整数")
    raise SystemExit(1)
if not 20 <= dpi <= 600:
    print("ERR dpi 超出合理范围 20–600")
    raise SystemExit(1)

stem = os.path.splitext(os.path.basename(path))[0]
out = (a.get("out") or "").strip() or os.path.join(
    os.path.expanduser("~"), "yysdl", "pdfimg", stem)
os.makedirs(out, exist_ok=True)

cmd = ["pdftoppm", "-r", str(dpi), "-" + fmt]
if str(a.get("gray") or "").strip() in ("1", "true", "yes"):
    cmd.append("-gray")

pages = (a.get("pages") or "").strip()
if pages:
    m = re.fullmatch(r"(\d+)\s*(?:-\s*(\d+))?", pages)
    if not m:
        print("ERR pages 格式应为 N 或 N-M，收到 %r" % pages)
        raise SystemExit(1)
    first = int(m.group(1))
    last = int(m.group(2)) if m.group(2) else first
    if last < first:
        print("ERR pages 区间反了: %s" % pages)
        raise SystemExit(1)
    cmd += ["-f", str(first), "-l", str(last)]

cmd += [path, os.path.join(out, "pg")]

p = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
if p.returncode != 0:
    print("ERR pdftoppm 返回 %d\n%s" % (p.returncode, (p.stderr or "").strip()[-500:]))
    raise SystemExit(1)

imgs = sorted(f for f in os.listdir(out) if f.startswith("pg") and f.endswith(ext))
if not imgs:
    print("ERR 没渲染出任何图（检查 pages 是否超出页数）")
    raise SystemExit(1)

total = sum(os.path.getsize(os.path.join(out, f)) for f in imgs)
print("OK  目录 = %s" % out)
print("OK  张数 = %d  (%s → %s)" % (len(imgs), imgs[0], imgs[-1]))
print("OK  参数 = dpi=%d fmt=%s%s" % (dpi, fmt, "  pages=" + pages if pages else ""))
print("OK  体积 = %.1f MB" % (total / 1024 / 1024))
