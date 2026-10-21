// Host 侧装配：在官方 attachments 提供者的请求图投影上挂一层可撤销的装饰。
//
// 边界：只做 DSH 接线与副作用（装饰与还原、缓存 IO、限流、时间预算、回退与日志）；
// 判据与编码在 src/core/。这里不接管服务、不复制官方存储、准入、校验、文件读写职责。
//
// 接入契约（DSH 0.2.1-rc.2）：`ctx.attachments` 仍由官方 `attachment-local` 行提供，
// 本行只在其实例上替换 `readImageRequest`，并用 `ctx.effect` 注册还原。于是：
// - 本 bundle 不 provide 任何服务，启用/停用/卸载它都不会让 `ctx.attachments` 消失；
// - 提供者缺席或没有该方法时本插件不激活、只记一条 warn（fail-open）；
// - 服务换成另一个实现时，声明式 `inject` 会让 cordis 重新执行本插件的 apply，
//   旧装饰随 fiber 卸载还原，新装饰挂到新实例上。

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { alphaCompatible, decodeRaster, encodeCandidate, probeImage, rasterEqual, renderRaster, requestPipeline } from '../core/codec.js'
import { skipReason } from '../core/plan.js'
import { candidateKinds, cacheKeyFor, DEFAULT_POLICY, resolvePolicy, variantIdFor } from '../core/policy.js'
import { chooseSmallest, smallestBytes } from '../core/select.js'

/** 稳定包名；同时作为日志作用域。 */
export const name = 'dsh-image-request-preprocess'

/** 装饰的前提是官方提供者在位；服务换实现时 cordis 会重新执行 apply。 */
export const inject = ['attachments']

/** 本行配置：只描述无损候选策略，官方附件字段仍归 `attachment-local` 行。 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_POLICY.enabled),
  webpLossless: Schema.boolean().default(DEFAULT_POLICY.webpLossless),
  pngOptimize: Schema.boolean().default(DEFAULT_POLICY.pngOptimize),
  minBytes: Schema.natural().default(DEFAULT_POLICY.minBytes),
  effort: Schema.natural().min(0).max(6).default(DEFAULT_POLICY.effort),
  tryJpegSources: Schema.boolean().default(DEFAULT_POLICY.tryJpegSources),
  concurrency: Schema.natural().min(1).max(8).default(DEFAULT_POLICY.concurrency),
  budgetMs: Schema.natural().min(1).default(DEFAULT_POLICY.budgetMs),
})

/** 装饰标记：重复 apply 时不再叠一层包装。 */
const DECORATED = Symbol.for('dsh-image-request-preprocess.decorated')

/** 判定为"无收益/失败/超预算"后暂时不再重算的身份上限。 */
const NEGATIVE_CACHE_LIMIT = 2048

/**
 * 造一个"中止即拒绝"的守卫 promise，并可摘掉监听。
 * @param {AbortSignal} signal 已合并预算与调用方取消的信号
 * @returns {{promise: Promise<never>, detach: () => void}} 守卫
 */
function abortGuard(signal) {
  let detach = () => {}
  const promise = new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    detach = () => signal.removeEventListener('abort', onAbort)
  })
  return { promise, detach }
}

/**
 * 在官方 `readImageRequest` 之上尝试更小的严格无损编码。
 *
 * 只依赖提供者实例的两件公开能力：`readImageRequest`（比较基准）与 `readImage`
 * （读回已校验的规范化字节）。
 */
export class ImageRequestPreprocessor {
  /**
   * @param {object} store 官方 attachments 提供者实例
   * @param {object} [options] 归一化前的配置（策略字段 + 可选的 cacheRoot/logger）
   */
  constructor(store, options = {}) {
    this.store = store
    // 构造时抓住官方实现：apply 之后实例上的同名方法已被本插件替换，运行时再查会自我递归。
    this.readBaseline = store.readImageRequest.bind(store)
    this.policy = resolvePolicy(options)
    this.logger = options.logger
    this.preprocessRoot = join(options.cacheRoot ?? dshCachePath('attachments'), 'request-image-preprocess')
    this.negative = new Map()
    this.active = 0
    this.waiters = []
  }

  /**
   * 生成或读取一个请求版本；没有严格更小的等价候选时返回原生结果。
   * @param {{attachmentId: string, mediaType: string, bytes: number, width: number, height: number}} ref 规范化附件引用
   * @param {{width: number, height: number, maxBytes: number}} target 路由选择的目标
   * @param {AbortSignal} [signal] 调用方取消
   * @returns {Promise<object>} 请求图片版本
   */
  async readImageRequest(ref, target, signal) {
    signal?.throwIfAborted()
    const baseline = await this.readBaseline(ref, target, signal)
    if (skipReason(this.policy, { baselineBytes: baseline.bytes, sourceMediaType: baseline.attachment.mediaType }) !== undefined) {
      return baseline
    }
    const baseKey = String(baseline.variantId)
    if (this.negative.has(baseKey)) return baseline
    const variantId = variantIdFor(this.policy, baseKey)

    const cached = await this.readCached(variantId, baseline, signal)
    if (cached !== undefined) return cached

    const version = await this.optimize(variantId, ref, target, baseline, signal, baseKey)
    return version ?? baseline
  }

  /**
   * 在单图时间预算内执行一次优化；超预算或失败一律回退原生结果。
   *
   * 预算覆盖"排队 + 读源 + 编码 + 校验"全程，并且是**不依赖被调用方配合**的：
   * 原生解码/编码不接受取消，预算到期后这里直接不再等待它，请求路径不跟着卡住。
   * @param {string} variantId 派生身份
   * @param {object} ref 规范化附件引用
   * @param {object} target 请求目标
   * @param {object} baseline 原生请求版本
   * @param {AbortSignal} [callerSignal] 调用方取消
   * @param {string} baseKey 原生 variantId
   * @returns {Promise<object|undefined>} 优化后的版本
   */
  async optimize(variantId, ref, target, baseline, callerSignal, baseKey) {
    const budget = AbortSignal.timeout(this.policy.budgetMs)
    const signal = callerSignal === undefined ? budget : AbortSignal.any([callerSignal, budget])
    const work = this.limit(() => this.build(variantId, ref, target, baseline, signal), signal)
    // 放弃等待后仍可能迟到的拒绝：接住它，避免变成未处理拒绝。
    work.catch(() => {})
    const guard = abortGuard(signal)
    try {
      return await Promise.race([work, guard.promise])
    } catch (error) {
      callerSignal?.throwIfAborted()
      // 超预算：本次放弃，本进程内也不再为同一身份重复付出代价。
      if (budget.aborted) this.rememberNegative(baseKey)
      this.debug(`budget/fallback ${String(baseline.attachment.attachmentId)}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    } finally {
      guard.detach()
    }
  }

  /**
   * 在并发上限内执行一次重编码；排队期间同样响应取消与截止时间。
   *
   * 槽位在信号中止时立刻归还：原生调用可能永远不返回，占着槽位会让后续请求排队到死。
   * 代价是极端情况下同时运行的重编码可能超过 `concurrency`，这是有意的取舍。
   * @param {() => Promise<any>} task 任务
   * @param {AbortSignal} signal 已合并预算与调用方取消的信号
   * @returns {Promise<any>} 任务结果
   */
  async limit(task, signal) {
    if (this.active >= this.policy.concurrency) {
      await new Promise((resolve, reject) => {
        const wake = () => {
          cleanup()
          resolve()
        }
        const abort = () => {
          cleanup()
          reject(signal.reason ?? new Error('image request preprocess aborted while queued'))
        }
        const cleanup = () => {
          signal.removeEventListener('abort', abort)
          const index = this.waiters.indexOf(wake)
          if (index >= 0) this.waiters.splice(index, 1)
        }
        this.waiters.push(wake)
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    this.active += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.active -= 1
      const next = this.waiters.shift()
      if (next !== undefined) next()
    }
    const onAbort = () => release()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await task()
    } finally {
      signal.removeEventListener('abort', onAbort)
      release()
    }
  }

  /**
   * 重编码并校验；任何失败都返回 undefined，由调用方回退原生结果。
   * @param {string} variantId 派生身份
   * @param {object} ref 规范化附件引用
   * @param {object} target 请求目标
   * @param {object} baseline 原生请求版本
   * @param {AbortSignal} signal 已合并预算与调用方取消的信号
   * @returns {Promise<object|undefined>} 优化后的版本
   */
  async build(variantId, ref, target, baseline, signal) {
    try {
      const source = await this.store.readImage(ref, signal)
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
        signal.throwIfAborted()
        const encoded = await encodeCandidate(pipeline, kind, this.policy)
        // 不小于已知最小者就不可能入选：省掉这次完整解码校验。
        if (encoded.data.byteLength >= smallestBytes(baseline, candidates)) continue
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
      signal.throwIfAborted()
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
      this.logger?.debug?.(`${name}: ${message}`)
    } catch {
      // 日志是旁路：任何失败都不得影响请求。
    }
  }
}

/**
 * 把无损候选装饰挂到官方提供者实例上；随 fiber 卸载还原。
 * @param {object} ctx Host 插件上下文（已注入 attachments）
 * @param {object} [config] Loader 按 Config 校验并填默认后的配置
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const store = ctx.attachments
  const current = store?.readImageRequest
  if (typeof current !== 'function') {
    ctx.logger?.warn?.(`${name}: attachments 提供者没有 readImageRequest，跳过接管`)
    return
  }
  if (current[DECORATED] === true) return
  const preprocessor = new ImageRequestPreprocessor(store, { ...config, logger: ctx.logger })
  const decorator = function readImageRequest(ref, target, signal) {
    return preprocessor.readImageRequest(ref, target, signal)
  }
  decorator[DECORATED] = true
  ctx.effect(() => {
    store.readImageRequest = decorator
    return () => {
      store.readImageRequest = current
    }
  }, `${name}.decorate`)
}
