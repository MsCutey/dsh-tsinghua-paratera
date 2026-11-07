import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../lib/errors.mjs';

test('delete outcome messages distinguish visible keys from unknown outcomes without assigning blame', () => {
  assert.match(errorMessage('key-delete-not-deleted'), /完整列表仍显示/);
  assert.match(errorMessage('key-delete-unconfirmed'), /不要直接重复删除/);
  for (const code of ['key-delete-not-deleted', 'key-delete-unconfirmed']) {
    assert.match(errorMessage(code), /刷新密钥列表/);
    assert.doesNotMatch(errorMessage(code), /与插件请求格式无关|解析数据失败|平台故障/);
  }
});
