// 测试辅助：合成图片与最小上下文。图片内容全部程序生成，不依赖外部素材。

import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

/**
 * 供 LocalAttachmentStore 构造用的最小上下文：服务注册是唯一被调用的能力。
 * @returns {object} 假 ctx
 */
export function fakeContext() {
  return {
    reflect: { provide: () => () => {} },
    fiber: { effect: () => () => {} },
    logger: Object.assign(() => ({ debug() {} }), { debug() {} }),
  }
}

/**
 * 建一个隔离的临时 DSH HOME。
 * @returns {Promise<string>} 绝对路径
 */
export async function tempHome() {
  return await mkdtemp(join(tmpdir(), 'irp-'))
}

/**
 * 生成一张"截图样"RGB 图：侧栏、平色面板、渐变条、硬边横线，以及大量小字块。
 * 小字块让熵接近真实 IDE / 终端截图，避免纯平色图给出失真的压缩率。
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {Promise<Buffer>} PNG 字节
 */
export async function screenshotLikePng(width = 1200, height = 800) {
  const channels = 3
  const data = Buffer.alloc(width * height * channels)
  let seed = 0x2f6bff
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return (seed >>> 8) / 0x1000000
  }
  const glyphs = []
  for (let y = 96; y < height - 40; y += 21) {
    for (let x = 64; x < width * 0.68; x += 9) {
      if (random() < 0.52) continue
      glyphs.push({ x, y, w: 3 + Math.floor(random() * 5), h: random() < 0.25 ? 2 : 6 })
    }
  }
  const glyph = new Uint8Array(width * height)
  for (const { x, y, w, h } of glyphs) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const gx = x + dx
        const gy = y + dy
        if (gx < width && gy < height) glyph[gy * width + gx] = 1
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels
      let r
      let g
      let b
      if (y < 48) {
        r = 32; g = 34; b = 38
      } else if (x < width * 0.4) {
        const t = (y - 48) / (height - 48)
        r = Math.round(246 - 40 * t); g = Math.round(248 - 30 * t); b = Math.round(250 - 10 * t)
      } else if (x < width * 0.72) {
        r = 250; g = 250; b = 250
        if (y % 26 < 3 && y > 80) { r = 40; g = 44; b = 52 }
      } else {
        const stripe = Math.floor((x - width * 0.72) / 24) % 2 === 0
        r = stripe ? 24 : 232; g = stripe ? 96 : 236; b = stripe ? 210 : 244
      }
      if (glyph[y * width + x] === 1) {
        r = Math.max(0, r - 150); g = Math.max(0, g - 140); b = Math.max(0, b - 130)
      }
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
    }
  }
  return await sharp(data, { raw: { width, height, channels } }).png().toBuffer()
}

/**
 * 生成高熵 PNG：无损候选不可能比它更小。
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {Promise<Buffer>} PNG 字节
 */
export async function noisePng(width = 600, height = 400) {
  const channels = 3
  const data = randomBytes(width * height * channels)
  return await sharp(data, { raw: { width, height, channels } }).png().toBuffer()
}
