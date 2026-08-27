import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_NODE_QUICK_ACTIONS } from "../quick-actions";
import { SettingsModal } from "./SettingsModal";

test("settings modal exposes the four Codex permission modes", () => {
  const html = renderToStaticMarkup(
    <SettingsModal
      open
      data={{
        transport: "codex-app-server",
        modelSelectionSupported: true,
        permissionSelectionSupported: true,
        model: null,
        reasoningEffort: null,
        permissionMode: "request-approval",
        quickActions: [...DEFAULT_NODE_QUICK_ACTIONS],
        models: [],
        catalogError: null
      }}
      loading={false}
      saving={false}
      error=""
      onClose={() => {}}
      onSave={() => {}}
    />
  );

  assert.match(html, /应如何批准 Codex 操作？/);
  assert.match(html, /请求批准/);
  assert.match(html, /替我审批/);
  assert.match(html, /完全访问权限/);
  assert.match(html, /自定义 \(config\.toml\)/);
  assert.match(html, /<select id="permission-mode"/);
  assert.doesNotMatch(html, /type="radio"/);
  assert.doesNotMatch(html, /原生 Codex/);
  assert.match(html, /<strong>快捷操作<\/strong><small>节点操作与提示词<\/small>/);
  assert.match(html, /class="settingsCategoryPanel hidden"/);
  assert.match(html, /节点快捷操作/);
  assert.doesNotMatch(html, />添加操作<\/button>/);
  assert.match(html, /aria-label="快捷操作 1 名称"/);
  assert.match(html, /value="发散"/);
  assert.match(html, /删除快捷操作 发散/);
});

test("settings modal renders model selection as a dropdown", () => {
  const html = renderToStaticMarkup(
    <SettingsModal
      open
      data={{
        transport: "codex-app-server",
        modelSelectionSupported: true,
        permissionSelectionSupported: true,
        model: null,
        reasoningEffort: null,
        permissionMode: "request-approval",
        quickActions: [...DEFAULT_NODE_QUICK_ACTIONS],
        models: [{
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          description: "Frontier model",
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: []
        }],
        catalogError: null
      }}
      loading={false}
      saving={false}
      error=""
      onClose={() => {}}
      onSave={() => {}}
    />
  );

  assert.match(html, /<select id="codex-model"/);
  assert.match(html, /跟随 Codex 默认/);
  assert.match(html, /GPT-5\.6 Sol（默认）/);
});

test("permission mode remains saveable when only the model catalog is unavailable", () => {
  const html = renderToStaticMarkup(
    <SettingsModal
      open
      data={{
        transport: "codex-app-server",
        modelSelectionSupported: true,
        permissionSelectionSupported: true,
        model: null,
        reasoningEffort: null,
        permissionMode: "request-approval",
        quickActions: [...DEFAULT_NODE_QUICK_ACTIONS],
        models: [],
        catalogError: "Codex is temporarily unavailable"
      }}
      loading={false}
      saving={false}
      error=""
      onClose={() => {}}
      onSave={() => {}}
    />
  );

  assert.match(html, /<button type="submit" class="primaryButton">保存设置<\/button>/);
});
