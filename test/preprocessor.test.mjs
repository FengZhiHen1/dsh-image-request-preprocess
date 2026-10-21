// 装饰层的集成测试：真实 LocalAttachmentStore + 隔离临时 HOME，不接触运行实例。

import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { after, describe, it } from 'node:test'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import Schema from '@deepseek-ai/schemastery'
import sharp from 'sharp'
import { apply, Config, ImageRequestPreprocessor, inject, name } from '../index.js'
import { decodeRaster, rasterEqual, renderRaster, requestPipeline } from '../src/core/codec.js'
import { fakeContext, noisePng, screenshotLikePng, tempHome } from './helpers.mjs'

const homes = []

after(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true })
})

/**
 * 建一个原生存储与挂在它上面的预处理器。
 * @param {object} [config] 预处理器配置
 * @returns {Promise<{native: object, store: object, cacheRoot: string}>} 环境
 */
async function fixtures(config = {}) {
  const home = await tempHome()
  homes.push(home)
  const native = new LocalAttachmentStore(fakeContext(), { dshHome: home })
  const cacheRoot = `${home}/cache/attachments`
  const store = new ImageRequestPreprocessor(native, { minBytes: 0, cacheRoot, ...config })
  return { home, native, store, cacheRoot }
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

/**
 * 一个"原生调用永不返回"的提供者：模拟卡死的原生解码。
 * @returns {object} 假提供者
 */
function hangingProvider() {
  const baseline = {
    variantId: 'sha256:base',
    attachment: { attachmentId: 'sha256:img', mediaType: 'image/png', bytes: 1024 * 1024, width: 1200, height: 800 },
    data: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png',
    bytes: 1024 * 1024,
    width: 1200,
    height: 800,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
  const provider = {
    reads: 0,
    async readImageRequest() {
      return baseline
    },
    readImage() {
      provider.reads += 1
      return new Promise(() => {})
    },
  }
  return provider
}

describe('插件导出面', () => {
  it('导出 Host 插件的 apply/Config/inject/name', () => {
    assert.equal(typeof apply, 'function')
    assert.equal(name, 'dsh-image-request-preprocess')
    assert.deepEqual(inject, ['attachments'])
    assert.equal(typeof Config, 'function')
  })

  it('配置 schema 只描述本插件的策略字段', () => {
    for (const field of ['enabled', 'webpLossless', 'pngOptimize', 'minBytes', 'effort', 'tryJpegSources', 'concurrency', 'budgetMs']) {
      assert.ok(Config.dict[field], `缺少字段 ${field}`)
    }
    assert.equal(Config.dict.maxImageBytes, undefined, '官方附件字段归 attachment-local 行')
    const [resolved] = Schema.resolve({}, Config)
    assert.equal(resolved.enabled, true)
    assert.equal(resolved.webpLossless, true)
    assert.equal(resolved.pngOptimize, true)
    assert.equal(resolved.effort, 2)
    assert.equal(resolved.concurrency, 1)
    assert.equal(resolved.budgetMs, 2500)
  })
})

describe('请求图优化', () => {
  it('无损候选严格更小时替换请求版本，并保持像素等价', async () => {
    const { native, store } = await fixtures()
    const ref = await saveScreenshot(native)
    const target = { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 }

    const baseline = await native.readImageRequest(ref, target)
    const optimized = await store.readImageRequest(ref, target)

    assert.notEqual(String(optimized.variantId), String(baseline.variantId))
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
    const ref = await native.saveImage({ data: jpeg, mediaType: 'image/jpeg' })
    const target = { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 }

    const baseline = await native.readImageRequest(ref, target)
    const result = await store.readImageRequest(ref, target)

    assert.equal(String(result.variantId), String(baseline.variantId))
    assert.equal(Buffer.compare(Buffer.from(result.data), Buffer.from(baseline.data)), 0)
  })

  it('禁用后完全走原生路径', async () => {
    const { native, store } = await fixtures({ enabled: false })
    const ref = await saveScreenshot(native)
    const target = { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 }

    const baseline = await native.readImageRequest(ref, target)
    const result = await store.readImageRequest(ref, target)

    assert.equal(String(result.variantId), String(baseline.variantId))
    assert.equal(Buffer.compare(Buffer.from(result.data), Buffer.from(baseline.data)), 0)
  })

  it('重复请求命中缓存，字节与身份恒定', async () => {
    const { native, store } = await fixtures()
    const ref = await saveScreenshot(native)
    const target = { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 }

    const first = await store.readImageRequest(ref, target)
    const second = await store.readImageRequest(ref, target)

    assert.equal(String(first.variantId), String(second.variantId))
    assert.equal(Buffer.compare(Buffer.from(first.data), Buffer.from(second.data)), 0)
  })

  it('原生走有损阶梯时，返回的候选仍等于同尺寸请求栅格且严格更小', async () => {
    const { native, store } = await fixtures()
    const ref = await saveScreenshot(native)
    const target = { width: 900, height: 600, maxBytes: 40 * 1024 }

    const baseline = await native.readImageRequest(ref, target)
    const result = await store.readImageRequest(ref, target)

    if (String(result.variantId) !== String(baseline.variantId)) {
      assert.ok(result.bytes < baseline.bytes)
      const source = await native.readImage(ref)
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
    const ref = await saveScreenshot(native)
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

describe('请求路径的预算保护', () => {
  it('原生调用卡住时按预算回退原生结果，并记账不再重试', async () => {
    const provider = hangingProvider()
    const store = new ImageRequestPreprocessor(provider, { minBytes: 0, budgetMs: 60, cacheRoot: `${(await tempHome())}/cache/attachments` })
    const ref = { attachmentId: 'sha256:img', mediaType: 'image/png', bytes: 1024 * 1024, width: 1200, height: 800 }
    const target = { width: 1200, height: 800, maxBytes: 4 * 1024 * 1024 }

    const started = performance.now()
    const first = await store.readImageRequest(ref, target)
    const elapsed = performance.now() - started

    assert.equal(String(first.variantId), 'sha256:base', '卡住时必须原样返回原生结果')
    assert.ok(elapsed < 2000, `预算没有生效：耗时 ${elapsed.toFixed(0)}ms`)
    assert.equal(provider.reads, 1)
    assert.equal(store.active, 0, '超预算后不得继续占用并发槽位')

    const second = await store.readImageRequest(ref, target)
    assert.equal(String(second.variantId), 'sha256:base')
    assert.equal(provider.reads, 1, '已记账的失败身份不应再次付出代价')
  })

  it('调用方取消按官方语义抛错，而不是回退', async () => {
    const provider = hangingProvider()
    const store = new ImageRequestPreprocessor(provider, { minBytes: 0, budgetMs: 5000, cacheRoot: `${(await tempHome())}/cache/attachments` })
    const ref = { attachmentId: 'sha256:img', mediaType: 'image/png', bytes: 1024 * 1024, width: 1200, height: 800 }
    const target = { width: 1200, height: 800, maxBytes: 4 * 1024 * 1024 }
    const controller = new AbortController()
    const pending = store.readImageRequest(ref, target, controller.signal)
    controller.abort(new Error('cancelled by caller'))

    await assert.rejects(pending, /cancelled by caller/)
  })
})

describe('装饰与还原', () => {
  /**
   * 极简 ctx：只提供 apply 用到的 effect/logger 与 attachments。
   * @param {object} attachments 提供者实例
   * @returns {{ctx: object, disposers: Function[]}} 上下文与已注册的清理函数
   */
  function fakeHost(attachments) {
    const disposers = []
    const ctx = {
      attachments,
      logger: { debug() {}, warn() {} },
      effect(factory) {
        const dispose = factory()
        disposers.push(dispose)
        return dispose
      },
    }
    return { ctx, disposers }
  }

  it('替换后还原，且重复 apply 不叠层', async () => {
    const { native } = await fixtures()
    const original = native.readImageRequest
    const { ctx, disposers } = fakeHost(native)

    apply(ctx, { minBytes: 0 })
    const decorated = native.readImageRequest
    assert.notEqual(decorated, original)
    assert.equal(disposers.length, 1)

    apply(ctx, { minBytes: 0 })
    assert.equal(native.readImageRequest, decorated, '重复 apply 不得把包装层叠起来')
    assert.equal(disposers.length, 1)

    disposers.pop()()
    assert.equal(native.readImageRequest, original, '卸载后必须还原官方实现')
  })

  it('装饰后的方法走优化路径而不是自我递归', async () => {
    const { native } = await fixtures()
    const ref = await saveScreenshot(native)
    const target = { width: ref.width, height: ref.height, maxBytes: 4 * 1024 * 1024 }
    const baseline = await native.readImageRequest(ref, target)
    const { ctx } = fakeHost(native)

    apply(ctx, { minBytes: 0 })
    const decorated = await native.readImageRequest(ref, target)

    assert.notEqual(String(decorated.variantId), String(baseline.variantId))
    assert.ok(decorated.bytes < baseline.bytes)
  })

  it('提供者没有 readImageRequest 时不接管也不抛错', () => {
    const { ctx, disposers } = fakeHost({})
    assert.doesNotThrow(() => apply(ctx, {}))
    assert.equal(disposers.length, 0)
  })
})
