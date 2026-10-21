# dsh-image-request-preprocess

DSH 图片请求预处理插件：在图片进入模型请求时，为它选择**更小的严格无损编码**（WebP Lossless 或优化 PNG）；没有更小的有效候选、失败或超出单图时间预算时，原样保留官方编码。

- 目标是减少多图片长会话里重复发送的字节，不改变分辨率、不改写会话历史、不删除图片。
- 不处理语义历史压缩（那是 ACP 的范围），也不接管任何代理或独立服务。

## 它做了什么

DSH 的 `ctx.attachments.readImageRequest(ref, target)` 负责生成"这一张图、这个路由、这个尺寸预算"下的模型请求版本。原生实现只有两种情况：尺寸与字节都满足时原样透传，否则按 `[85, 75, 60]` 质量阶梯重编码（透明图走有损 WebP，其余走 JPEG）。

本插件在**官方提供者实例**上装饰这个方法，额外尝试两个候选：

1. **WebP Lossless**（`lossless: true` + `exact: true`，不是 `quality: 100`）；
2. **优化 PNG**（只提高压缩级别，不启用量化）。

候选必须**逐像素等于请求栅格**、alpha 语义兼容，并且**严格小于原生字节**才会被采用；否则返回原生结果。请求栅格的解码、sRGB 转换与长边缩放和原生实现同构，因此替换不会改变模型看到的尺寸与内容。

这个装饰发生在模型请求的关键路径上，所以成本是有上界的：单图 `budgetMs` 硬预算（默认 2.5 s，含排队）、单槽并发（默认 1）、只对"可能入选"的候选做逐像素校验，预算耗尽或原生调用卡住都直接回退原生结果。

## 接入方式

`cordis.patch.yml` 只插入本插件自己的一行：

```yaml
- insert:
    - id: image-request-preprocess
      name: dsh-image-request-preprocess
```

`ctx.attachments` **仍由官方 `attachment-local` 行提供**。本插件声明 `inject: ['attachments']`，在其实例上用 `ctx.effect` 注册"替换 + 还原"，因此：

- 启用、停用、卸载本 bundle 都不会让 `ctx.attachments` 消失，也不会改动官方行的配置；
- 提供者缺席或没有 `readImageRequest` 时本插件不激活，只记一条 warn（失败即不优化，附件功能照常）；
- `attachments` 换成另一个实现时，cordis 会重新执行本插件的 `apply`：旧装饰随 fiber 卸载还原，新装饰挂到新实例上。

> 早先版本曾用"禁用 `attachment-local` 行 + 自己 provide `attachments`"的接管方案，在 test 实例上启用/停用该 bundle 时两次导致宿主进程在本轮内退出（2026-10-20，见 `docs/技术设计与接入点.md` §七）。现在的装饰方案不碰服务提供者，爆炸半径只剩"优化不生效"。

## 配置

本行配置只描述无损候选策略；官方附件字段（`maxImageBytes`、`normalizedImageMaxPixels`、`imageCompressionConcurrency` 等）仍归 `attachment-local` 行。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后完全走原生路径 |
| `webpLossless` | `true` | 是否尝试 WebP Lossless 候选 |
| `pngOptimize` | `true` | 是否尝试无损重压缩 PNG |
| `minBytes` | `65536` | 原生请求版本小于该字节数时不介入 |
| `effort` | `2` | WebP 无损编码 effort（0–6）；越高越慢、通常更小 |
| `tryJpegSources` | `false` | 是否对 JPEG 来源也尝试无损候选（通常无收益） |
| `concurrency` | `1` | 同时进行的重编码数量上限 |
| `budgetMs` | `2500` | 单图时间预算；超时回退原生结果，本进程内不再重试该图 |

## 已知边界

- **与官方提供者耦合**：装饰的是 `ctx.attachments` 实例上的 `readImageRequest`，并调用它的 `readImage` 读回规范化字节。官方改这两个方法的名字或语义时本插件必须跟着改；`readImageRequest` 不存在时插件不激活（fail-open）。
- **非官方扩展点**：这是"装饰一个服务的实例方法 + `ctx.effect` 还原"，不是 DSH 文档化的 service seam。选它是因为唯一官方可行的替代方案（接管整个 `attachments` 服务）在实例上实测会让宿主进程退出。判据与取舍见 `docs/技术设计与接入点.md`。
- **路由兼容性**：WebP 依赖目标路由接受 `image/webp` data URL。DSH 原生对透明图已经发送有损 WebP，但这是弱证据；不接受时把 `webpLossless` 设为 `false`（PNG 候选仍然无损可用）。
- **可能改变请求表示**：同一张图启用插件后得到的 `variantId` 与原生不同，这是有意的（缓存与上传身份必须区分）。历史事件仍引用同一规范化附件。
- **跳过的输入**：GIF（不改变动画语义）、多帧图、非 8 位或非 sRGB、JPEG 来源（默认）。
- **失败即回退**：任何解码、编码、校验、缓存写入错误或超预算都返回原生结果，不抛给调用方；只有调用方自己的取消按官方语义抛出。
- **本插件自带一份 sharp**：`link:` 安装下它和官方附件实现各自解析到自己的 `sharp` 副本（同一版本、不同物理路径），因此单图编码会实际占用两份原生库中的一份。实测 4 MP 截图单候选 100 ms 量级；`budgetMs` 与 `concurrency` 仍是主要护栏。

## 验证状态

- 离线测试通过（`pnpm test`，26 项）：像素等价、确定性、取小、缓存命中、禁用、失败回退、**原生调用卡住时按预算回退**、调用方取消语义、装饰可撤销、重复 apply 不叠层。测试用合成图与临时 HOME，不接触运行实例。
- **实例激活未验证**（2026-10-20 起该插件在 test 实例被停用）：装饰是否在真实请求上生效、真实路由对 WebP 的接受度、以及启用/停用本 bundle 时宿主是否稳定，都需要一次受控实测。见 `docs/技术设计与接入点.md` 的验收清单。

## 开发

```bash
pnpm install
pnpm test
# 仓库根：分层与注释终止检查
node tools/plugin-layering-check.mjs plugins/dsh-image-request-preprocess
```
