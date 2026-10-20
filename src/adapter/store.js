// Host 侧装配：以本地附件提供者的子类接管模型请求图片。
//
// 边界：只做 DSH 接线与副作用（服务注册、缓存 IO、限流、回退与日志）；判据与编码在
// src/core/。这里不复制官方存储、准入、校验、文件读写等职责，只重写 readImageRequest。
//
// 接入契约（DSH 0.2.1-rc.2）：ctx.attachments 是唯一提供者的服务，同名服务不能二次
// provide；本插件取代官方 attachment-local 行自己提供该服务，其余方法全部继承。

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { alphaCompatible, decodeRaster, encodeCandidate, probeImage, rasterEqual, renderRaster, requestPipeline } from '../core/codec.js'
import { skipReason } from '../core/plan.js'
import { candidateKinds, cacheKeyFor, DEFAULT_POLICY, resolvePolicy, variantIdFor } from '../core/policy.js'
import { chooseSmallest } from '../core/select.js'

/** 官方提供者的基础配置字段；本行取代 attachment-local 后必须继续暴露它们。 */
const BASE_CONFIG_FIELDS = LocalAttachmentStore.Config?.dict ?? {}

/** 本插件 Loader 行的配置 schema：官方附件字段 + 无损候选策略。 */
export const Config = Schema.object({
  ...BASE_CONFIG_FIELDS,
  enabled: Schema.boolean().default(DEFAULT_POLICY.enabled),
  webpLossless: Schema.boolean().default(DEFAULT_POLICY.webpLossless),
  pngOptimize: Schema.boolean().default(DEFAULT_POLICY.pngOptimize),
  minBytes: Schema.natural().default(DEFAULT_POLICY.minBytes),
  effort: Schema.natural().min(0).max(6).default(DEFAULT_POLICY.effort),
  tryJpegSources: Schema.boolean().default(DEFAULT_POLICY.tryJpegSources),
  concurrency: Schema.natural().min(1).max(8).default(DEFAULT_POLICY.concurrency),
})

/** 判定为"无收益/失败"后暂时不再重算的身份上限。 */
const NEGATIVE_CACHE_LIMIT = 2048

/** 本地附件提供者 + 无损请求图优化。 */
export class ImageRequestPreprocessStore extends LocalAttachmentStore {
  /** Loader 行配置 schema。 */
  static Config = Config

  /**
   * @param {object} ctx Host 插件上下文
   * @param {object} [config] Loader 按 Config 校验并填默认后的配置
   */
  constructor(ctx, config = {}) {
    super(ctx, config)
    this.policy = resolvePolicy(config)
    this.preprocessRoot = join(dshCachePath({ dshHome: config.dshHome }, 'attachments'), 'request-image-preprocess')
    this.negative = new Map()
    this.active = 0
    this.waiters = []
  }

  /**
   * 生成或读取一个请求版本；无损候选没有严格更小且像素等价时返回原生结果。
   * @param {{attachmentId: string, mediaType: string, bytes: number, width: number, height: number}} ref 规范化附件引用
   * @param {{width: number, height: number, maxBytes: number}} target 路由选择的目标
   * @param {AbortSignal} [signal] 调用方取消
   * @returns {Promise<object>} 请求图片版本
   */
  async readImageRequest(ref, target, signal) {
    signal?.throwIfAborted()
    const baseline = await super.readImageRequest(ref, target, signal)
    if (skipReason(this.policy, { baselineBytes: baseline.bytes, sourceMediaType: baseline.attachment.mediaType }) !== undefined) {
      return baseline
    }
    const baseKey = String(baseline.variantId)
    if (this.negative.has(baseKey)) return baseline
    const variantId = variantIdFor(this.policy, baseKey)

    const cached = await this.readCached(variantId, baseline, signal)
    if (cached !== undefined) return cached

    const version = await this.limit(() => this.build(variantId, ref, target, baseline, signal))
    return version ?? baseline
  }

  /**
   * 在并发上限内执行一次重编码。
   * @param {() => Promise<any>} task 任务
   * @returns {Promise<any>} 任务结果
   */
  async limit(task) {
    if (this.active >= this.policy.concurrency) {
      await new Promise(resolve => this.waiters.push(resolve))
    }
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      const next = this.waiters.shift()
      if (next !== undefined) next()
    }
  }

  /**
   * 重编码并校验；任何失败都返回 undefined，由调用方回退原生结果。
   * @param {string} variantId 派生身份
   * @param {object} ref 规范化附件引用
   * @param {object} target 请求目标
   * @param {object} baseline 原生请求版本
   * @param {AbortSignal} [signal] 调用方取消
   * @returns {Promise<object|undefined>} 优化后的版本
   */
  async build(variantId, ref, target, baseline, signal) {
    try {
      const source = await this.readImage(ref, signal)
      const info = await probeImage(source.data)
      const facts = {
        baselineBytes: baseline.bytes,
        sourceMediaType: baseline.attachment.mediaType,
        sourcePages: info.pages,
        depth: info.depth,
        space: info.space,
      }
      if (skipReason(this.policy, facts) !== undefined) return undefined

      // 请求栅格与官方流水线同构：同一解码、同一 sRGB、同一长边缩放。
      const pipeline = requestPipeline(source.data, baseline.attachment, target)
      const intended = await renderRaster(pipeline)
      if (intended.width !== baseline.width || intended.height !== baseline.height) return undefined

      const candidates = []
      for (const kind of candidateKinds(this.policy)) {
        signal?.throwIfAborted()
        const encoded = await encodeCandidate(pipeline, kind, this.policy)
        const probe = await probeImage(encoded.data)
        if (probe.width !== intended.width || probe.height !== intended.height) continue
        if (probe.mediaType !== encoded.mediaType) continue
        if (!alphaCompatible(info.hasAlpha, probe)) continue
        const decoded = await decodeRaster(encoded.data)
        if (!rasterEqual(decoded, intended)) continue
        candidates.push({
          data: encoded.data,
          mediaType: encoded.mediaType,
          width: probe.width,
          height: probe.height,
          hasAlpha: probe.hasAlpha,
          bytes: encoded.data.byteLength,
        })
      }

      const chosen = chooseSmallest(baseline, candidates)
      if (chosen === undefined) {
        this.rememberNegative(String(baseline.variantId))
        return undefined
      }
      await this.writeCached(variantId, chosen.data)
      this.debug(`optimized ${String(baseline.attachment.attachmentId)} ${baseline.bytes} -> ${chosen.bytes} ${chosen.mediaType}`)
      return this.versionOf(baseline, chosen, variantId)
    } catch (error) {
      signal?.throwIfAborted()
      this.rememberNegative(String(baseline.variantId))
      this.debug(`fallback ${String(baseline.attachment.attachmentId)}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * 组装一个请求图片版本。
   * @param {object} baseline 原生版本
   * @param {{data: Uint8Array, mediaType: string, width: number, height: number, hasAlpha: boolean, bytes: number}} chosen 选中的候选
   * @param {string} variantId 派生身份
   * @returns {object} 请求图片版本
   */
  versionOf(baseline, chosen, variantId) {
    return {
      variantId,
      attachment: baseline.attachment,
      data: chosen.data,
      mediaType: chosen.mediaType,
      bytes: chosen.bytes,
      width: chosen.width,
      height: chosen.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: chosen.hasAlpha,
    }
  }

  /** 本插件缓存文件路径：与官方 request-images 并列，不写进持久附件树。 */
  cachePath(variantId) {
    const key = cacheKeyFor(variantId)
    return join(this.preprocessRoot, key.slice(0, 2), key)
  }

  /**
   * 读取已写入的候选；元数据不符或文件损坏都按未命中处理。
   * @param {string} variantId 派生身份
   * @param {object} baseline 原生版本
   * @param {AbortSignal} [signal] 调用方取消
   * @returns {Promise<object|undefined>} 命中的版本
   */
  async readCached(variantId, baseline, signal) {
    try {
      const data = new Uint8Array(await readFile(this.cachePath(variantId), { signal }))
      if (data.byteLength >= baseline.bytes) return undefined
      const probe = await probeImage(data)
      if (probe.mediaType !== 'image/webp' && probe.mediaType !== 'image/png') return undefined
      if (probe.width !== baseline.width || probe.height !== baseline.height) return undefined
      if (!alphaCompatible(baseline.hasAlpha === true, probe)) return undefined
      return this.versionOf(baseline, {
        data,
        mediaType: probe.mediaType,
        width: probe.width,
        height: probe.height,
        hasAlpha: probe.hasAlpha,
        bytes: data.byteLength,
      }, variantId)
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted()
      return undefined
    }
  }

  /**
   * 原子写入候选缓存。
   * @param {string} variantId 派生身份
   * @param {Uint8Array} data 编码字节
   * @returns {Promise<void>} 写入完成
   */
  async writeCached(variantId, data) {
    const path = this.cachePath(variantId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  /**
   * 记录一次"无收益"判定，避免每个请求重复付出编码代价。
   * @param {string} baseKey 原生 variantId
   * @returns {void}
   */
  rememberNegative(baseKey) {
    this.negative.set(baseKey, true)
    if (this.negative.size <= NEGATIVE_CACHE_LIMIT) return
    const oldest = this.negative.keys().next().value
    if (oldest !== undefined) this.negative.delete(oldest)
  }

  /**
   * 写一条调试日志；日志不可用时静默。
   * @param {string} message 文案
   * @returns {void}
   */
  debug(message) {
    try {
      const logger = this.ctx?.logger
      const scoped = typeof logger === 'function' ? logger('image-request-preprocess') : logger
      scoped?.debug?.(message)
    } catch {
      // 日志是旁路：任何失败都不得影响请求。
    }
  }
}

export default ImageRequestPreprocessStore
