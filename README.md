# dsh-image-request-preprocess

DSH 图片请求预处理插件：在图片进入模型请求时，为它选择**更小的严格无损编码**（WebP Lossless 或优化 PNG）；没有更小的有效候选就原样保留官方编码。

- 目标是减少多图片长会话里重复发送的字节，不改变分辨率、不改写会话历史、不删除图片。
- 不处理语义历史压缩（那是 ACP 的范围），也不接管任何代理或独立服务。

## 它做了什么

DSH 的 `ctx.attachments.readImageRequest(ref, target)` 负责生成"这一张图、这个路由、这个尺寸预算"下的模型请求版本。原生实现只有两种情况：尺寸与字节都满足时原样透传，否则按 `[85, 75, 60]` 质量阶梯重编码（透明图走有损 WebP，其余走 JPEG）。

本插件接管这个方法，额外尝试两个候选：

1. **WebP Lossless**（`lossless: true` + `exact: true`，不是 `quality: 100`）；
2. **优化 PNG**（只提高压缩级别，不启用量化）。

候选必须**逐像素等于请求栅格**、alpha 语义兼容，并且**严格小于原生字节**才会被采用；否则返回原生结果。请求栅格的解码、sRGB 转换与长边缩放和原生实现同构，因此替换不会改变模型看到的尺寸与内容。

## 接入方式

`ctx.attachments` 是单提供者服务：cordis 不允许同名服务二次 `provide`，所以本插件**取代**官方 `attachment-local` 行，用它自己的子类提供该服务；存储、准入、校验、读取、文件等职责全部继承官方实现，只重写 `readImageRequest`。

`cordis.patch.yml`：

```yaml
- id: attachment-local
  disabled: true
- insert:
    - id: image-request-preprocess
      name: dsh-image-request-preprocess
```

禁用行与插入行是一组：只留其一会让 `ctx.attachments` 缺失。卸载本 bundle 后官方行恢复。

## 配置

Loader 行配置同时保留官方 `attachment-local` 的全部字段（`maxImageBytes`、`normalizedImageMaxPixels`、`imageCompressionConcurrency` 等），并新增：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后完全走原生路径 |
| `webpLossless` | `true` | 是否尝试 WebP Lossless 候选 |
| `pngOptimize` | `true` | 是否尝试无损重压缩 PNG |
| `minBytes` | `65536` | 原生请求版本小于该字节数时不介入 |
| `effort` | `4` | WebP 无损编码 effort（0–6）；越高越慢、通常更小 |
| `tryJpegSources` | `false` | 是否对 JPEG 来源也尝试无损候选（通常无收益） |
| `concurrency` | `2` | 同时进行的重编码数量上限 |

## 已知边界

- **与官方提供者耦合**：继承 `LocalAttachmentStore`（构造签名、`Config` 字段、`readImageRequest` 语义）。官方改这些契约时本插件必须跟着改。
- **路由兼容性**：WebP 依赖目标路由接受 `image/webp` data URL。DSH 原生对透明图已经发送有损 WebP，但这是弱证据；需要在真实路由上确认。不接受时把 `webpLossless` 设为 `false`（PNG 候选仍然无损可用）。
- **可能改变请求表示**：同一张图启用插件后得到的 `variantId` 与原生不同，这是有意的（缓存与上传身份必须区分）。历史事件仍引用同一规范化附件。
- **跳过的输入**：GIF（不改变动画语义）、多帧图、非 8 位或非 sRGB、JPEG 来源（默认）。
- **失败即回退**：任何解码、编码、校验、缓存或写入错误都返回原生结果，不抛给调用方。

## 验证状态

- 单元与集成测试通过（`pnpm test`，20 项）：像素等价、确定性、取小、缓存命中、禁用、失败回退。测试用合成图，不接触运行实例。
- **实例激活未验证**：patch 覆盖 `attachment-local`、链接安装下的 peer 解析、真实路由对 WebP 的接受度，都还没有在 `test` 实例实测。见 `docs/技术设计与接入点.md` 的验收清单。

## 开发

```bash
pnpm install
pnpm test
# 仓库根：分层与注释终止检查
node tools/plugin-layering-check.mjs plugins/dsh-image-request-preprocess
```
