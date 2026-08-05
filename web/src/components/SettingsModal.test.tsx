import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

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
  assert.match(html, /name="codex-permission-mode"/);
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
