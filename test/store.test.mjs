// 提供者子类的集成测试：真实 LocalAttachmentStore + 隔离临时 HOME，不接触运行实例。

import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { after, describe, it } from 'node:test'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import sharp from 'sharp'
import { ImageRequestPreprocessStore } from '../src/adapter/store.js'
import { decodeRaster, rasterEqual, renderRaster, requestPipeline } from '../src/core/codec.js'
import { fakeContext, noisePng, screenshotLikePng, tempHome } from './helpers.mjs'

const homes = []

after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true })
})

/**
 * 建一对共享同一 HOME 的原生存储与插件存储。
 * @param {object} [config] 插件配置
 * @returns {Promise<{home: string, native: object, store: object}>} 环境
 */
async function fixtures(config = {}) {
  const home = await tempHome()
  homes.push(home)
  const native = new LocalAttachmentStore(fakeContext(), { dshHome: home })
  const store = new ImageRequestPreprocessStore(fakeContext(), {
    dshHome: home,
    minBytes: 0,
    ...config,
  })
  return { home, native, store }
}

/**
 * 保存一张合成截图并返回引用。
 * @param {object} store 任一提供者
 * @returns {Promise<object>} 规范化引用
 */
async function saveScreenshot(store) {
  const png = await screenshotLikePng()
  return await store.saveImage({ data: png, mediaType: 'image/png' })
}

describe('attachments 提供者接管', () => {
  it('无损候选严格更小时替换请求版本，并保持像素等价', async () => {
    const { native, store } = await fixtures()
    const ref = await saveScreenshot(store)
    const target = { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 }

    const baseline = await native.readImageRequest(ref, target)
    const optimized = await store.readImageRequest(ref, target)

    assert.notEqual(optimized.variantId, baseline.variantId)
    assert.ok(optimized.bytes < baseline.bytes, `expected ${optimized.bytes} < ${baseline.bytes}`)
    assert.ok(optimized.mediaType === 'image/webp' || optimized.mediaType === 'image/png')
    assert.deepEqual(optimized.attachment, baseline.attachment)
    assert.equal(optimized.width, baseline.width)
    assert.equal(optimized.height, baseline.height)
    assert.equal(rasterEqual(await decodeRaster(optimized.data), await decodeRaster(baseline.data)), true)
  })

  it('无收益时原样返回原生结果', async () => {
    const { native, store } = await fixtures({ tryJpegSources: true, pngOptimize: false })
    // 来源已是高压缩的 JPEG：无损候选必然更大，应完整回退原生结果。
    const jpeg = await sharp(await noisePng()).jpeg({ quality: 30 }).toBuffer()
    const ref = await store.saveImage({ data: jpeg, mediaType: 'image/jpeg' })
    const target = { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 }

    const baseline = await native.readImageRequest(ref, target)
    const result = await store.readImageRequest(ref, target)

    assert.equal(String(result.variantId), String(baseline.variantId))
    assert.equal(Buffer.compare(Buffer.from(result.data), Buffer.from(baseline.data)), 0)
  })

  it('禁用后完全走原生路径', async () => {
    const { native, store } = await fixtures({ enabled: false })
    const ref = await saveScreenshot(store)
    const target = { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 }

    const baseline = await native.readImageRequest(ref, target)
    const result = await store.readImageRequest(ref, target)

    assert.equal(String(result.variantId), String(baseline.variantId))
    assert.equal(Buffer.compare(Buffer.from(result.data), Buffer.from(baseline.data)), 0)
  })

  it('重复请求命中缓存，字节与身份恒定', async () => {
    const { store } = await fixtures()
    const ref = await saveScreenshot(store)
    const target = { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 }

    const first = await store.readImageRequest(ref, target)
    const second = await store.readImageRequest(ref, target)

    assert.equal(String(first.variantId), String(second.variantId))
    assert.equal(Buffer.compare(Buffer.from(first.data), Buffer.from(second.data)), 0)
  })

  it('原生走有损阶梯时，返回的候选仍等于同尺寸请求栅格且严格更小', async () => {
    const { native, store } = await fixtures()
    const ref = await saveScreenshot(store)
    const target = { width: 900, height: 600, maxBytes: 40 * 1024 }

    const baseline = await native.readImageRequest(ref, target)
    const result = await store.readImageRequest(ref, target)

    if (String(result.variantId) !== String(baseline.variantId)) {
      assert.ok(result.bytes < baseline.bytes)
      const source = await store.readImage(ref)
      const intended = await renderRaster(requestPipeline(source.data, ref, target))
      assert.equal(intended.width, result.width)
      assert.equal(intended.height, result.height)
      assert.equal(rasterEqual(await decodeRaster(result.data), intended), true)
    } else {
      // 无损候选没有更小：必须与原生结果完全一致，不允许"差不多"的替换。
      assert.equal(Buffer.compare(Buffer.from(result.data), Buffer.from(baseline.data)), 0)
    }
  })

  it('缓存写入失败时回退原生结果而不是抛错', async () => {
    const { native, store } = await fixtures()
    const ref = await saveScreenshot(store)
    const target = { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 }
    const baseline = await native.readImageRequest(ref, target)

    const original = store.writeCached.bind(store)
    store.writeCached = async () => { throw new Error('disk full') }
    try {
      const result = await store.readImageRequest(ref, target)
      assert.equal(String(result.variantId), String(baseline.variantId))
      assert.equal(Buffer.compare(Buffer.from(result.data), Buffer.from(baseline.data)), 0)
    } finally {
      store.writeCached = original
    }
  })
})
