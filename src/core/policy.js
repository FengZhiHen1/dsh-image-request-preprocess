// 策略归一化与确定性身份。
//
// 边界：纯领域逻辑。不导入 cordis 或任何 @deepseek-ai/* 包，不引用 adapter；
// 可裸 node 单测。编码策略版本是身份的一部分：改动候选集合或编码参数必须提升
// POLICY_VERSION，否则旧缓存会被错误复用。

import { createHash } from 'node:crypto'

/** 候选集合与编码参数的语义版本；进入每个请求版本的 variantId。 */
export const POLICY_VERSION = 'v1'

/** 未配置时的默认策略：无损候选全开，只在有明显字节量时介入。 */
export const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  webpLossless: true,
  pngOptimize: true,
  minBytes: 64 * 1024,
  effort: 4,
  tryJpegSources: false,
  concurrency: 2,
})

/**
 * 归一化并校验策略。
 * @param {object} [input] 来自插件 Loader 行的配置
 * @returns {Readonly<object>} 冻结后的策略
 * @throws {Error} 字段类型或取值范围非法时
 */
export function resolvePolicy(input = {}) {
  const policy = { ...DEFAULT_POLICY }
  for (const key of Object.keys(DEFAULT_POLICY)) {
    if (input[key] !== undefined) policy[key] = input[key]
  }
  for (const key of ['enabled', 'webpLossless', 'pngOptimize', 'tryJpegSources']) {
    if (typeof policy[key] !== 'boolean') throw new Error(`image-request-preprocess: ${key} must be a boolean`)
  }
  if (!Number.isSafeInteger(policy.minBytes) || policy.minBytes < 0) {
    throw new Error('image-request-preprocess: minBytes must be a non-negative integer')
  }
  if (!Number.isSafeInteger(policy.effort) || policy.effort < 0 || policy.effort > 6) {
    throw new Error('image-request-preprocess: effort must be an integer from 0 through 6')
  }
  if (!Number.isSafeInteger(policy.concurrency) || policy.concurrency < 1 || policy.concurrency > 8) {
    throw new Error('image-request-preprocess: concurrency must be an integer from 1 through 8')
  }
  return Object.freeze(policy)
}

/**
 * 本策略启用的无损候选，按尝试顺序排列。
 * @param {object} policy 归一化策略
 * @returns {string[]} 候选种类
 */
export function candidateKinds(policy) {
  const kinds = []
  if (policy.webpLossless) kinds.push('webp-lossless')
  if (policy.pngOptimize) kinds.push('png')
  return kinds
}

/**
 * 由原生 variantId 与本策略派生新的请求版本身份。
 *
 * 同一附件、同一目标、同一原生结果与同一策略必须得到同一身份；策略或原生编码
 * 参数变化必须得到不同身份，避免复用旧字节。
 * @param {object} policy 归一化策略
 * @param {string} baseVariantId 原生 readImageRequest 返回的 variantId
 * @returns {string} 新的 variantId（`sha256:<hex>`）
 */
export function variantIdFor(policy, baseVariantId) {
  const descriptor = JSON.stringify({
    plugin: 'dsh-image-request-preprocess',
    policyVersion: POLICY_VERSION,
    baseVariantId: String(baseVariantId),
    candidates: candidateKinds(policy),
    effort: policy.effort,
  })
  return `sha256:${createHash('sha256').update(descriptor).digest('hex')}`
}

/**
 * 把 variantId 转成缓存文件名（去掉算法前缀）。
 * @param {string} variantId 本插件派生的身份
 * @returns {string} 十六进制摘要
 */
export function cacheKeyFor(variantId) {
  const value = String(variantId)
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
}
