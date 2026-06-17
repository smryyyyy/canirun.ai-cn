<div align="center">

<img src="public/favicon.svg" alt="CanIRun.ai" width="80" height="80" />

# CanIRun.ai

**在几秒钟内找出你的硬件能在本地运行哪些 AI 模型。**

你的浏览器会自动检测 CPU、内存和 GPU。\
无需安装、无需基准测试、无需猜测。

[**canirun.ai**](https://canirun.ai) · [报告 Bug](https://github.com/midudev/canirun.ai/issues) · [请求模型](https://github.com/midudev/canirun.ai/issues)

[🇺🇸 English](README.md)

</div>

---

## 为什么

云端 AI API 费用高昂、有速率限制，并且会将你的数据发送给第三方。在本地运行模型给你**隐私、速度和零代币成本**——但前提是你的硬件要够用。

CanIRun.ai 即时回答这个问题。打开网站，让它检测你的硬件，查看 **68+ 个开源权重模型**的个性化兼容性报告，评级从 S 到 F。

## 工作原理

```
浏览器 API → 硬件检测 → 模型匹配 → 个性化评级
```

1. **硬件检测**完全在客户端运行，使用 WebGL、WebGPU、`navigator.deviceMemory` 和轻量级 CPU 微基准测试。
2. 每个模型的 VRAM 需求根据参数量在 **7 个量化级别**（Q2_K → F16）上进行计算。
3. 评分算法将运行状态、估计每秒代币数、内存余量和模型大小结合成一个**字母评级（S–F）**。
4. 结果即时显示——没有任何数据发送到服务器。

### 支持的硬件

|| 平台 | 检测方法 |
||---|---|
|| **NVIDIA** RTX 30xx / 40xx / 50xx, A100, H100 | WebGL 渲染器字符串 + GPU 数据库 |
|| **AMD** RX 6xxx / 7xxx / 9xxx | WebGL 渲染器字符串 + GPU 数据库 |
|| **Intel** Arc A 系列 | WebGL 渲染器字符串 + GPU 数据库 |
|| **Apple Silicon** M1–M4（Pro, Max, Ultra）| WebGL + 统一内存查询 |
|| **移动端**（iOS / Android）| 屏幕分辨率、基准测试、Adreno/Mali/Immortalis 数据库 |

## 功能特性

- **零安装硬件检测** — 从浏览器识别 CPU 核心数、内存、GPU 型号、显存和内存带宽
- **68+ AI 模型** — 从 TinyLlama 1.1B 到 Llama 4 Maverick 128E 和 Qwen3 Coder 480B
- **每个模型 7 个量化级别** — Q2_K、Q3_K_M、Q4_K_M、Q5_K_M、Q6_K、Q8_0、F16，已计算显存大小
- **S–F 评级系统** — 根据你的硬件与模型需求即时给出字母评级
- **每秒 Token 数估算** — 从内存带宽数据估算推理速度
- **筛选器** — 按用途（对话、编程、推理、视觉）、厂商、架构（稠密 / MoE）、功能（工具调用、思维）
- **搜索和键盘快捷键** — `/` 搜索，`j`/`k` 导航，`Enter` 打开，`v` 切换视图
- **三种视图模式** — 紧凑网格、详细网格和列表
- **分级列表** — 可分享的 S–F 分级列表，可导出为图片
- **模型详情页** — 每个量化的兼容表，一键获取 Ollama / LM Studio / llama.cpp 安装命令
- **OG 图像** — 为每个模型动态生成的社交预览图
- **SEO** — Schema.org 结构化数据、网站地图、语义化 HTML
- **视图过渡** — 通过 Astro Client Router 实现平滑页面动画

## 模型目录

来自 **Meta、Google、阿里巴巴、DeepSeek、Mistral AI、Microsoft、NVIDIA、Liquid AI** 和社区的模型：

|| 系列 | 模型 |
||---|---|
|| Llama | 3.1 8B, 3.1 405B, 3.2 1B/3B/11B-Vision, 3.3 70B, 4 Scout, 4 Maverick |
|| Qwen | 2.5 7B–72B, 2.5 Coder, 3 1.7B–235B, 3.5 0.8B–397B, 3 Coder 480B |
|| Gemma | 2 2B/9B/27B, 3 1B/4B/12B/27B |
|| DeepSeek | R1 1.5B–32B, V3.1, V3.2 |
|| Mistral | 7B, Nemo 12B, Small 24B, Mixtral 8x7B/8x22B, Devstral |
|| Phi | 3.5 Mini, 4 14B, 4 Mini Reasoning |
|| 其他 | Nemotron, GLM-4, OLMo 2, SmolLM3, LFM2, EXAONE, Kimi K2, GPT-OSS |

## 技术栈

|| | 技术 | 用途 |
||---|---|---|
|| 🚀 | [Astro 5](https://astro.build) | 岛屿架构的静态站点生成 |
|| 🎨 | [Tailwind CSS 4](https://tailwindcss.com) | 实用优先的样式 |
|| 🔤 | [Geist](https://vercel.com/font) | Sans、Mono 和 Pixel 字体 |
|| 🖼️ | [Satori](https://github.com/vercel/satori) + [resvg](https://github.com/nicolo-ribaudo/resvg-js) | OG 图像生成（JSX → SVG → PNG）|
|| 📸 | [@zumer/snapdom](https://github.com/nicolo-ribaudo/snapdom) | 分级列表导出为图片 |
|| 🗺️ | [@astrojs/sitemap](https://docs.astro.build/en/guides/integrations-guide/sitemap/) | 自动生成网站地图 |

## 快速开始

**前置条件：** [Node.js](https://nodejs.org) 18+ 和 [pnpm](https://pnpm.io)

```bash
# 克隆仓库
git clone https://github.com/midudev/canirun.ai.git
cd canirun.ai

# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

打开 [localhost:4321](http://localhost:4321) 查看网站。

## 命令

|| 命令 | 操作 |
||---|---|
|| `pnpm dev` | 在 `localhost:4321` 启动开发服务器 |
|| `pnpm build` | 构建生产站点到 `./dist/` |
|| `pnpm preview` | 本地预览生产构建 |
|| `pnpm scrape` | 从 HuggingFace 获取模型统计 |

## 项目结构

```
src/
├── data/
│   ├── models.ts          # 68+ AI 模型定义及量化计算
│   └── hf-stats.json      # HuggingFace 下载/点赞统计
├── lib/
│   ├── hardware.ts         # 客户端硬件检测引擎
│   └── og.ts               # OG 图像生成工具
├── pages/
│   ├── index.astro         # 首页 — 带筛选和搜索的模型网格
│   ├── tier.astro          # 分级列表 — S–F 排名及图片导出
│   ├── model/[id].astro    # 模型详情 — 量化、兼容性、安装
│   └── og/                 # 动态 OG 图像接口
├── components/
│   └── NavHeader.astro     # 网站导航
├── layouts/
│   └── Layout.astro        # 基础布局，含 SEO、字体、过渡
├── icons/                  # SVG 图标组件
└── styles/
    └── global.css          # 主题变量、Geist 字体、暗色模式
```

## 贡献

欢迎贡献！以下是一些参与方式：

- **添加模型** — 按照现有模式在 `src/data/models.ts` 中添加条目
- **改进硬件检测** — 扩展 `src/lib/hardware.ts` 中的 GPU/Apple/移动数据库
- **报告不准确的结果** — 提交 issue，附上你的硬件信息和有问题的模型
- **修复 bug 或改进 UI** — 欢迎 PR

## 作者

由 [**midudev**](https://midu.dev) 创建 · [@midudev](https://twitter.com/midudev)

## 许可证

MIT
