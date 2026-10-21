// 候选比较。
//
// 边界：纯函数。只做"在通过无损校验的候选里取最小者"这一件事；
// 不存在更小的候选时返回 undefined，调用方必须回退原生结果。

/**
 * 在已通过校验的候选里选择体积最小者。
 *
 * 候选必须已证明逐像素等价于请求栅格；任何候选不小于原生字节数时都不应入选，
 * 因为比原生更大就没有收益，还会改变既有的请求表示。
 * @param {{bytes: number}} baseline 原生请求版本，只需字节数
 * @param {Array<{bytes: number}>} candidates 通过校验的候选
 * @returns {object|undefined} 最小候选；没有严格更小的候选时为 undefined
 */
export function chooseSmallest(baseline, candidates) {
  let best
  for (const candidate of candidates) {
    if (candidate.bytes >= baseline.bytes) continue
    if (best === undefined || candidate.bytes < best.bytes) best = candidate
  }
  return best
}

/**
 * 一个候选还必须低于多少字节才有资格入选。
 *
 * 用于省掉注定落选的候选的解码校验：既然比较基准是"原生字节与已通过校验候选"里的
 * 最小者，编码结果不小于它就不可能被选中，也就不必逐像素比对。
 * @param {{bytes: number}} baseline 原生请求版本，只需字节数
 * @param {Array<{bytes: number}>} candidates 已通过校验的候选
 * @returns {number} 入选所需的严格上界
 */
export function smallestBytes(baseline, candidates) {
  let smallest = baseline.bytes
  for (const candidate of candidates) {
    if (candidate.bytes < smallest) smallest = candidate.bytes
  }
  return smallest
}
