// 无损候选的编解码与像素等价校验。
//
// 边界：只依赖 sharp 与 node 内建模块，不导入 cordis 或 @deepseek-ai/*，不引用 adapter。
// 请求栅格的构造与官方 attachment-local 的 request-image 流水线保持一致：
// 同一解码器、同一 sRGB 转换、同一长边缩放（不放大）。候选编码之后必须逐像素等于
// 该栅格，否则整张图回退原生编码。
//
// sharp 是**首次使用时才加载**的原生模块：插件被装载（以及实例上 patch 的应用）不允许
// 触发第二份 libvips 的初始化，任何加载失败也只落在请求路径的 try/catch 里。

import { createRequire } from 'node:module'

const requireSharp = createRequire(import.meta.url)
let sharpEntry

/**
 * 取 sharp 入口；第一次调用才真正加载原生模块。
 * @returns {any} sharp 可调用入口
 */
function sharp() {
  sharpEntry ??= requireSharp('sharp')
  return sharpEntry
}

/**
 * 用已编码字节建一条 sharp 流水线。
 * @param {Uint8Array} bytes 编码字节
 * @param {object} options sharp 输入选项
 * @returns {import('sharp').Sharp} 流水线
 */
function image(bytes, options) {
  return sharp()(bytes, options)
}

const MEDIA_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * 按官方口径构造一张请求栅格的编码流水线。
 * @param {Uint8Array} sourceBytes 已校验的规范化附件字节
 * @param {{width: number, height: number}} ref 规范化附件的引用尺寸
 * @param {{width: number, height: number}} target 路由选择的目标尺寸
 * @returns {import('sharp').Sharp} 未编码的流水线
 */
export function requestPipeline(sourceBytes, ref, target) {
  const byWidth = ref.width >= ref.height
  const resize = byWidth
    ? { width: target.width, withoutEnlargement: true }
    : { height: target.height, withoutEnlargement: true }
  return image(sourceBytes, { failOn: 'error', limitInputPixels: false })
    .toColourspace('srgb')
    .resize(resize)
}

/**
 * 读取一张编码表象的元数据，不逐像素解码。
 * @param {Uint8Array} bytes 编码字节
 * @returns {Promise<{mediaType: string|undefined, width: number, height: number, hasAlpha: boolean, pages: number, depth: string|undefined, space: string|undefined}>} 元数据
 */
export async function probeImage(bytes) {
  const metadata = await image(bytes, { failOn: 'error', limitInputPixels: false }).metadata()
  return {
    mediaType: MEDIA_TYPES[metadata.format],
    width: metadata.width,
    height: metadata.height,
    hasAlpha: metadata.hasAlpha === true,
    pages: metadata.pages ?? 1,
    depth: metadata.depth,
    space: metadata.space,
  }
}

/**
 * 把流水线渲染成用于比对的 8 位 RGBA 栅格。
 * @param {import('sharp').Sharp} pipeline 请求栅格流水线
 * @returns {Promise<{data: Uint8Array, width: number, height: number, channels: number}>} 栅格
 */
export async function renderRaster(pipeline) {
  const { data, info } = await pipeline.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), width: info.width, height: info.height, channels: info.channels }
}

/**
 * 解码一张编码表象为用于比对的 8 位 RGBA 栅格。
 * @param {Uint8Array} bytes 编码字节
 * @returns {Promise<{data: Uint8Array, width: number, height: number, channels: number}>} 栅格
 */
export async function decodeRaster(bytes) {
  const { data, info } = await image(bytes, { failOn: 'error', limitInputPixels: false })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), width: info.width, height: info.height, channels: info.channels }
}

/**
 * 两张栅格是否逐像素相同。
 *
 * 直接比较底层字节视图，不复制：4 MP 栅格是 16 MiB，复制一次就多一份垃圾。
 * @param {{data: Uint8Array, width: number, height: number, channels: number}} left 左
 * @param {{data: Uint8Array, width: number, height: number, channels: number}} right 右
 * @returns {boolean} 尺寸、通道与像素字节全部相同
 */
export function rasterEqual(left, right) {
  if (left.width !== right.width || left.height !== right.height || left.channels !== right.channels) return false
  if (left.data.byteLength !== right.data.byteLength) return false
  return Buffer.compare(view(left.data), view(right.data)) === 0
}

/**
 * 把栅格字节包成零拷贝的 Buffer 视图。
 * @param {Uint8Array} data 栅格字节
 * @returns {Buffer} 同一段内存上的 Buffer
 */
function view(data) {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * 编码一个无损候选。
 *
 * WebP 必须使用 `lossless: true` 且 `exact: true`：前者是真正的无损模式，后者保留
 * 全透明像素下的 RGB，两者共同才能做到逐像素等价；`quality: 100` 不是无损。
 * PNG 只提升压缩级别，不启用量化（`palette: false`），因此不改变任何像素。
 * @param {import('sharp').Sharp} pipeline 请求栅格流水线
 * @param {'webp-lossless'|'png'} kind 候选种类
 * @param {{effort: number}} policy 归一化策略
 * @returns {Promise<{data: Uint8Array, mediaType: 'image/webp'|'image/png'}>} 候选字节
 */
export async function encodeCandidate(pipeline, kind, policy) {
  const encoded = kind === 'webp-lossless'
    ? pipeline.clone().webp({ lossless: true, effort: policy.effort, exact: true })
    : pipeline.clone().png({ compressionLevel: 9, palette: false })
  const data = new Uint8Array(await encoded.toBuffer())
  return { data, mediaType: kind === 'webp-lossless' ? 'image/webp' : 'image/png' }
}

/**
 * 候选的 alpha 元数据是否与来源事实兼容。
 *
 * 规则照抄官方 `encodedAlphaIsCompatible`：libvips 可能省略全不透明的 alpha 平面，
 * 因此 WebP 少了 alpha 平面仍可接受；其它增减都视为不可信。
 * @param {boolean} sourceHasAlpha 来源是否声明 alpha 平面
 * @param {{mediaType: string|undefined, hasAlpha: boolean}} candidate 候选元数据
 * @returns {boolean} 是否兼容
 */
export function alphaCompatible(sourceHasAlpha, candidate) {
  return candidate.hasAlpha === sourceHasAlpha
    || (sourceHasAlpha && !candidate.hasAlpha && candidate.mediaType === 'image/webp')
}
