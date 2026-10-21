// 插件装载的副作用测试：导入入口不得初始化原生图像库。

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import * as plugin from '../index.js'

describe('装载副作用', () => {
  it('导入插件入口不加载 sharp 原生模块', () => {
    const loaded = Object.keys(createRequire(import.meta.url).cache)
      .filter(path => /[\\/]sharp[\\/]/.test(path))
    assert.deepEqual(loaded, [], '装载插件（含 patch 应用）不允许触发原生图像库初始化')
    assert.equal(typeof plugin.apply, 'function')
  })
})
