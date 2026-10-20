// 核心编解码与选择规则的单元测试：不接触 DSH 服务，只用 sharp 与合成图。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  alphaCompatible,
  decodeRaster,
  encodeCandidate,
  probeImage,
  rasterEqual,
  renderRaster,
  requestPipeline,
} from '../src/core/codec.js'
import { skipReason } from '../src/core/plan.js'
import { candidateKinds, resolvePolicy, variantIdFor } from '../src/core/policy.js'
import { chooseSmallest } from '../src/core/select.js'
import { noisePng, screenshotLikePng } from './helpers.mjs'

const POLICY = resolvePolicy({ minBytes: 0, effort: 4 })
/** 默认阈值策略：用于验证"过小不介入"。 */
const GATED = resolvePolicy({ effort: 4 })

describe('无损候选', () => {
  it('WebP Lossless 解码后逐像素等于请求栅格', async () => {
    const source = await screenshotLikePng()
    const ref = { width: 1200, height: 800 }
    const pipeline = requestPipeline(source, ref, { width: 1200, height: 800 })
    const intended = await renderRaster(pipeline)
    const encoded = await encodeCandidate(pipeline, 'webp-lossless', POLICY)

    assert.equal(encoded.mediaType, 'image/webp')
    const decoded = await decodeRaster(encoded.data)
    assert.equal(rasterEqual(decoded, intended), true)
  })

  it('优化 PNG 解码后逐像素等于请求栅格', async () => {
    const source = await screenshotLikePng()
    const ref = { width: 1200, height: 800 }
    const pipeline = requestPipeline(source, ref, { width: 1200, height: 800 })
    const intended = await renderRaster(pipeline)
    const encoded = await encodeCandidate(pipeline, 'png', POLICY)

    assert.equal(encoded.mediaType, 'image/png')
    assert.equal(rasterEqual(await decodeRaster(encoded.data), intended), true)
  })

  it('同一输入与策略产生相同字节（确定性）', async () => {
    const source = await screenshotLikePng()
    const ref = { width: 1200, height: 800 }
    const first = await encodeCandidate(requestPipeline(source, ref, ref), 'webp-lossless', POLICY)
    const second = await encodeCandidate(requestPipeline(source, ref, ref), 'webp-lossless', POLICY)
    assert.equal(Buffer.compare(Buffer.from(first.data), Buffer.from(second.data)), 0)
  })

  it('缩小到目标尺寸时仍以该尺寸栅格为准', async () => {
    const source = await screenshotLikePng()
    const ref = { width: 1200, height: 800 }
    const target = { width: 600, height: 400 }
    const pipeline = requestPipeline(source, ref, target)
    const intended = await renderRaster(pipeline)
    assert.deepEqual({ width: intended.width, height: intended.height }, { width: 600, height: 400 })
    const encoded = await encodeCandidate(pipeline, 'webp-lossless', POLICY)
    assert.equal(rasterEqual(await decodeRaster(encoded.data), intended), true)
  })

  it('alpha 兼容规则与官方口径一致', async () => {
    assert.equal(alphaCompatible(true, { mediaType: 'image/webp', hasAlpha: false }), true)
    assert.equal(alphaCompatible(false, { mediaType: 'image/webp', hasAlpha: true }), false)
    assert.equal(alphaCompatible(true, { mediaType: 'image/png', hasAlpha: false }), false)
    assert.equal(alphaCompatible(false, { mediaType: 'image/png', hasAlpha: false }), true)
  })
})

describe('候选选择', () => {
  it('只接受严格更小的候选', () => {
    assert.equal(chooseSmallest({ bytes: 100 }, [{ bytes: 100 }, { bytes: 120 }]), undefined)
    assert.deepEqual(chooseSmallest({ bytes: 100 }, [{ bytes: 90 }, { bytes: 80 }]), { bytes: 80 })
  })

  it('没有候选时返回 undefined', () => {
    assert.equal(chooseSmallest({ bytes: 10 }, []), undefined)
  })
})

describe('介入判据', () => {
  it('默认策略两种无损候选都启用', () => {
    assert.deepEqual(candidateKinds(POLICY), ['webp-lossless', 'png'])
  })

  it('按事实跳过：GIF、动图、JPEG 来源、过小、非 8 位', () => {
    const base = { baselineBytes: 1024 * 1024, sourceMediaType: 'image/png', sourcePages: 1, depth: 'uchar', space: 'srgb' }
    assert.equal(skipReason(GATED, base), undefined)
    assert.equal(skipReason(GATED, { ...base, sourceMediaType: 'image/gif' }), 'gif-source')
    assert.equal(skipReason(GATED, { ...base, sourcePages: 2 }), 'animated-source')
    assert.equal(skipReason(GATED, { ...base, sourceMediaType: 'image/jpeg' }), 'jpeg-source')
    assert.equal(skipReason(GATED, { ...base, baselineBytes: 1 }), 'below-min-bytes')
    assert.equal(skipReason(GATED, { ...base, depth: 'ushort' }), 'unsupported-depth')
  })

  it('tryJpegSources 打开后不再跳过 JPEG 来源', () => {
    const policy = resolvePolicy({ minBytes: 0, tryJpegSources: true })
    const facts = { baselineBytes: 1024 * 1024, sourceMediaType: 'image/jpeg', sourcePages: 1, depth: 'uchar', space: 'srgb' }
    assert.equal(skipReason(policy, facts), undefined)
  })
})

describe('身份', () => {
  it('同一原生身份与策略派生出同一 variantId', () => {
    assert.equal(variantIdFor(POLICY, 'sha256:abc'), variantIdFor(POLICY, 'sha256:abc'))
  })

  it('策略变化会派生不同身份', () => {
    const other = resolvePolicy({ minBytes: 0, effort: 5 })
    assert.notEqual(variantIdFor(POLICY, 'sha256:abc'), variantIdFor(other, 'sha256:abc'))
  })

  it('原始 variantId 不同则派生身份不同', () => {
    assert.notEqual(variantIdFor(POLICY, 'sha256:abc'), variantIdFor(POLICY, 'sha256:def'))
  })
})

describe('高熵图', () => {
  it('无损 WebP 对高熵图通常更大，比较结果应拒绝它', async () => {
    const source = await noisePng()
    const ref = { width: 600, height: 400 }
    const pipeline = requestPipeline(source, ref, ref)
    const intended = await renderRaster(pipeline)
    const encoded = await encodeCandidate(pipeline, 'webp-lossless', POLICY)
    const probe = await probeImage(encoded.data)
    assert.equal(probe.mediaType, 'image/webp')
    // 逐像素仍等价；是否更小由 chooseSmallest 决定，这里只验证校验链不误判。
    assert.equal(rasterEqual(await decodeRaster(encoded.data), intended), true)
  })
})
