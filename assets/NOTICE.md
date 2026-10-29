# 默认素材署名（NOTICE）

本目录 `assets/*.webp` 共 **12 个 animated WebP**，尺寸 **128×107**，24fps 派生自上游帧序列。
上游仓库：[`QCYTSN/dsh-dafeiyu`](https://github.com/QCYTSN/dsh-dafeiyu)，精确路径 `assets/pet/<目录>/<目录>_NNN.webp`（逐帧 PNG/WebP 序列）——**MIT 许可，需署名**。
上游这些素材文件自身未单独标注许可证，按仓库整体 MIT 处理，待上游确认后修正。
本项目对这些文件做了什么：按 **隔帧抽样** 降帧 + **缩放至 128px 宽** + **重新编码为 animated WebP**（有损，非原始字节）。
逐文件 sha256（本仓库内 `assets/<name>` 实际字节）：

| 文件 | bytes | sha256 |
| --- | --- | --- |
| `eat_token.webp` | 212474 | `5160bf4f206ad05762ccd46403fb0179faf4fc4ed2ddf773df42ebfbb7873e23` |
| `error.webp` | 203618 | `e14c2cfa1de95413fecf09e53af791b7b7bbc6c5a7079ee2fd0057c86074c7d3` |
| `head_pat.webp` | 353054 | `2f5e52deb08ed6039d59c7641b57abf37b0d280b20c0369b75a02260bf2ea120` |
| `idle.webp` | 180946 | `d5772d1be9a52ce1037a2a44c1d65c75eb96f153709f39c726037324aa13d391` |
| `poke.webp` | 186626 | `db8f523e95b97458a1f832c760aca46b022ec56c0ca7b6648464b9f5b6b73c84` |
| `success.webp` | 205410 | `d0bf8584a8def03ea82dfdd0928a3ae99358820700870ab28dac0081050daab4` |
| `tail.webp` | 207284 | `0c3d66a4fdae50a1ccdc0d4e53736aeeb80763b53f21978e44f245394274cd40` |
| `thinking.webp` | 266092 | `b6654313bf3047b618e40a875be31f4c3d45bc3df744166ec5ca24b236ab1655` |
| `waiting.webp` | 343856 | `f120b573bda15ca93862dc3dc0621c2b7c3c53c612ed938fa08822018d2625cd` |
| `working_command.webp` | 210130 | `6a53e0ab89e16627adc056c5f38e0288a2dae1f878120e77b214856e33520d48` |
| `working_search.webp` | 249060 | `2f3bc2d68a82b40eaba325c3709abfcbd2128448670347b23ee0ff0edfb95f0f` |
| `working.webp` | 262202 | `2a76e3c243c60591e1b91f63f7467028472bb16a6bdd87bb844761ee11c520c1` |

合计 12 个文件 / 2880752 字节（2.75 MiB）。MIT 许可全文见仓库根 `LICENSE` 与上游仓库。
