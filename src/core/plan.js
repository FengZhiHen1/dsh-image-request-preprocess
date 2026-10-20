// 是否介入的判据。
//
// 边界：纯函数，输入是可观察的事实，输出是跳过原因或 undefined。
// 这里的每个理由都会被 adapter 原样用于"返回原生结果"，不产生任何副作用。

/**
 * 判断本次请求是否应当跳过无损候选重编码。
 *
 * 只依据已解码规范化附件的已知事实，不做"看起来像截图"的外观分类：
 * 无损候选对任何 RGB 栅格都成立，收益由字节比较决定，不靠分类决定。
 * @param {object} policy 归一化策略
 * @param {object} facts 事实
 * @param {number} facts.baselineBytes 原生请求版本字节数
 * @param {string} facts.sourceMediaType 规范化附件的媒体类型
 * @param {number} facts.sourcePages 帧数（1 表示静止图）
 * @param {string|undefined} facts.depth 解码样本深度
 * @param {string|undefined} facts.space 解码色彩空间
 * @returns {string|undefined} 跳过原因；undefined 表示继续
 */
export function skipReason(policy, facts) {
  if (!policy.enabled) return 'disabled'
  if (policy.webpLossless !== true && policy.pngOptimize !== true) return 'no-candidates'
  if (facts.baselineBytes < policy.minBytes) return 'below-min-bytes'
  if (facts.sourceMediaType === 'image/gif') return 'gif-source'
  if (facts.sourceMediaType === 'image/jpeg' && policy.tryJpegSources !== true) return 'jpeg-source'
  if ((facts.sourcePages ?? 1) > 1) return 'animated-source'
  if (facts.depth !== undefined && facts.depth !== 'uchar') return 'unsupported-depth'
  if (facts.space !== undefined && facts.space !== 'srgb') return 'unsupported-colorspace'
  return undefined
}
