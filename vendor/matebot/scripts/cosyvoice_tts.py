#!/usr/bin/env python3
"""CosyVoice TTS 合成：text → wav。

bridge（.venv python 3.13）用 subprocess 调本脚本（.cosyvoice/bin/python 3.10），
因为 CosyVoice 官方推荐 Python 3.10 + 独立依赖栈。

用法:
    .cosyvoice/bin/python scripts/cosyvoice_tts.py --text "你好" --out /tmp/x.wav
"""

import argparse
import os
import sys

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vendor", "cosyvoice")
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "third_party", "Matcha-TTS"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True, help="要合成的文本")
    ap.add_argument("--out", required=True, help="输出 wav 路径")
    ap.add_argument("--spk", default="中文女", help="SFT 说话人（首选）")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    from cosyvoice.cli.cosyvoice import AutoModel
    import torch
    import torchaudio

    model_dir = os.path.join(REPO, "pretrained_models", "CosyVoice2-0.5B")
    if not os.path.exists(model_dir):
        print("下载 CosyVoice2-0.5B（ModelScope）...", flush=True)
        from modelscope import snapshot_download
        model_dir = snapshot_download("iic/CosyVoice2-0.5B")
        print("模型已下载:", model_dir, flush=True)

    model = AutoModel(model_dir=model_dir)

    chunks = []
    # 首选 SFT（无参考音频）；CosyVoice2 若报错则回退 zero_shot（仓库自带参考音色）
    try:
        for ch in model.inference_sft(args.text, spk_id=args.spk):
            chunks.append(ch["tts_speech"])
    except Exception as e:
        print(f"inference_sft 失败({e})，回退 zero_shot", flush=True)
        prompt = os.path.join(REPO, "asset", "zero_shot_prompt.wav")
        prompt_text = "希望你以后能够做的比我还好呦。"
        for ch in model.inference_zero_shot(args.text, prompt_text, prompt):
            chunks.append(ch["tts_speech"])

    if not chunks:
        print("TTS 无输出", file=sys.stderr)
        return 1

    wav = torch.cat(chunks, dim=1)
    torchaudio.save(args.out, wav, model.sample_rate)
    print(f"OK {args.out} sr={model.sample_rate} dur={wav.shape[1] / model.sample_rate:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
