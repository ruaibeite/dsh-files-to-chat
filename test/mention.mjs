/**
 * 纯函数回归测试：在 node 里加载真正的客户端入口，只取它导出的 `__test` 钩子。
 *
 * 浏览器模块顶部就要 `window.__ModuleLoader__`，所以这里造一个假的加载器，并在
 * 工厂函数里塞进最小的 `react` / `react-dom` 替身——被测的路径与引用语法都是纯
 * 函数，不碰 React。
 *
 * 用法：node test/mention.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8');

let entry = null;
const fakeWindow = {
  __ModuleLoader__: {
    load: (value) => {
      entry = value;
    }
  }
};

const requireStub = (id) => {
  if (id === 'react') return { createElement: () => null, Fragment: 'Fragment' };
  if (id === 'react-dom') return { createPortal: () => null };
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
  throw new Error(`unexpected require: ${id}`);
};

// eslint-disable-next-line no-new-func
new Function('window', source)(fakeWindow);
assert.notEqual(entry, null, '客户端入口必须调用 __ModuleLoader__.load');
assert.equal(entry.id, '@ruaibeite/dsh-files-to-chat');

const plugin = entry.factory(requireStub);
assert.equal(typeof plugin.apply, 'function', 'apply 是插件的挂载入口');
assert.deepEqual(plugin.inject, ['slots', 'remote'], '注入插槽注册表与 remote 服务');

const { pathBasename, relativizeToCwd, formatFileMention, buildReference, buildReferences, interpolate, translate, openRequest, probeNativeOpen, openNatively, MODIFIER } = plugin.__test;

const CWD = '/Users/ruaibeite/Desktop';

// ── pathBasename ────────────────────────────────────────────────────────────
assert.equal(pathBasename('/a/b/report.docx'), 'report.docx');
assert.equal(pathBasename('/a/b/notes/'), 'notes');
assert.equal(pathBasename('plain.txt'), 'plain.txt');

// ── relativizeToCwd ─────────────────────────────────────────────────────────
assert.equal(relativizeToCwd(`${CWD}/iwcc/iwcc.sql`, CWD), 'iwcc/iwcc.sql');
assert.equal(relativizeToCwd(`${CWD}/iwcc/iwcc.sql`, `${CWD}/`), 'iwcc/iwcc.sql');
assert.equal(relativizeToCwd('/tmp/elsewhere.txt', CWD), '/tmp/elsewhere.txt');
assert.equal(relativizeToCwd('/tmp/elsewhere.txt', undefined), '/tmp/elsewhere.txt');
assert.equal(relativizeToCwd('/tmp/elsewhere.txt', ''), '/tmp/elsewhere.txt');
// 前缀相同但不是同一条路径：不能误判成工作区内
assert.equal(relativizeToCwd('/Users/ruaibeite/Desktop2/x.txt', CWD), '/Users/ruaibeite/Desktop2/x.txt');

// ── formatFileMention ───────────────────────────────────────────────────────
assert.equal(formatFileMention({ path: 'src/app.ts', kind: 'file' }, false), '@src/app.ts');
assert.equal(formatFileMention({ path: 'src/app.ts', kind: 'directory' }, false), '@src/app.ts/');
assert.equal(formatFileMention({ path: 'my docs/a b.md', kind: 'file' }, false), '@"my docs/a b.md"');
assert.equal(formatFileMention({ path: 'my docs/sub', kind: 'directory' }, false), '@"my docs/sub/"');
assert.equal(formatFileMention({ path: 'src/app.ts', kind: 'file' }, true), '@"src/app.ts"');
// 语法无法安全表示的路径（控制字符、引号）必须拒绝，而不是拼出坏引用
assert.equal(formatFileMention({ path: 'bad"name.ts', kind: 'file' }, false), undefined);
assert.equal(formatFileMention({ path: 'bad\u0007name.ts', kind: 'file' }, false), undefined);

// ── buildReference / buildReferences ───────────────────────────────────────
assert.deepEqual(buildReference(`${CWD}/iwcc/iwcc.sql`, 'file', CWD), {
  source: 'reference',
  ref: '@iwcc/iwcc.sql',
  label: 'iwcc.sql',
  appearance: 'file',
  clipboardText: '@iwcc/iwcc.sql'
});
assert.deepEqual(buildReference(`${CWD}/ba docs`, 'directory', CWD), {
  source: 'reference',
  ref: '@"ba docs/"',
  label: 'ba docs/',
  appearance: 'folder',
  clipboardText: '@"ba docs/"'
});
// 工作区外的文件保留绝对形式，仍然是合法引用
assert.equal(buildReference('/tmp/outside.txt', 'file', CWD).ref, '@/tmp/outside.txt');
assert.equal(buildReference(`${CWD}/bad"name.ts`, 'file', CWD), undefined);

const batch = buildReferences([
  { path: `${CWD}/a.ts`, kind: 'file' },
  { path: `${CWD}/nested`, kind: 'directory' },
  { path: `${CWD}/a.ts`, kind: 'file' },
  { path: `${CWD}/bad"name.ts`, kind: 'file' },
  { path: `${CWD}/with space.md`, kind: 'file' }
], CWD);
assert.deepEqual(batch.map((reference) => reference.clipboardText), [
  '@a.ts',
  '@nested/',
  '@"with space.md"'
], '保序、去重、跳过无法表示的条目');

// ── interpolate ─────────────────────────────────────────────────────────────
assert.equal(interpolate('已添加 {count} 项', { count: 3 }), '已添加 3 项');
assert.equal(interpolate('保留 {missing}', { count: 1 }), '保留 {missing}');

// ── translate：框架的 t 只替换它收到的参数 ──────────────────────────────────
/** 模仿框架 `t`：用收到的参数替换 `{name}`，没有对应参数就原样留下。 */
const frameworkT = (key, params) => {
  const table = { 'menu.hint': '{modifier}+点击多选，Shift+点击连选', 'menu.add': '添加到对话' };
  const template = table[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/gu, (match, name) => (params !== undefined && name in params ? String(params[name]) : match));
};

// 回归：`menu.hint` 的 modifier 是本插件内部补的，必须一起交给框架的 t，
// 否则界面上会原样显示 `{modifier}`（线上就是这么出的）。
assert.equal(translate(frameworkT, 'menu.hint'), `${MODIFIER}+点击多选，Shift+点击连选`);
assert.ok(!translate(frameworkT, 'menu.hint').includes('{modifier}'), '不能把占位符画到界面上');
assert.equal(translate(frameworkT, 'menu.add'), '添加到对话');
// 框架 t 缺席或返回键名时，退回自带中文表并且同样完成插值
assert.equal(translate(undefined, 'menu.addMany', { count: 2 }), '添加所选 2 项到对话');
assert.equal(translate((key) => key, 'menu.addMany', { count: 2 }), '添加所选 2 项到对话');
assert.ok(!translate(undefined, 'menu.hint').includes('{modifier}'));

// ── 原生打开：请求体与响应信封 ──────────────────────────────────────────────
// 省略 action = 按文件类型关联打开；显式 reveal = 文件管理器导航。
// 这两个形状必须与官方 OpenInAppPathController 一致，否则宿主会拒绝。
assert.deepEqual(openRequest('/w/a.ts', 'open'), { path: '/w/a.ts' });
assert.deepEqual(openRequest('/w/a.ts', 'reveal'), { path: '/w/a.ts', action: 'reveal' });
assert.ok(!('action' in openRequest('/w/a.ts', 'open')), 'open 不能带 action 字段');

// 能力探测是**三态**：只有宿主成功应答 value:false 才算「明确不支持」。
// 其余（没有命名空间、调用失败、抛错、信封不完整）都是 unknown —— unknown 照样把
// 菜单项画出来，否则探测的一次抖动就会把功能永久藏掉（线上就是这么翻车的）。
await (async () => {
  assert.equal(await probeNativeOpen(undefined), 'unknown', '命名空间缺席 ≠ 不支持');
  assert.equal(await probeNativeOpen({}), 'unknown', '没有该方法 ≠ 不支持');
  assert.equal(await probeNativeOpen({ canOpenWorkspacePath: async () => ({ ok: true, value: true }) }), 'yes');
  assert.equal(await probeNativeOpen({ canOpenWorkspacePath: async () => ({ ok: true, value: false }) }), 'no', '明确回答不支持');
  assert.equal(await probeNativeOpen({ canOpenWorkspacePath: async () => ({ ok: false, error: {} }) }), 'unknown', '调用失败 ≠ 不支持');
  assert.equal(await probeNativeOpen({ canOpenWorkspacePath: async () => undefined }), 'unknown');
  assert.equal(await probeNativeOpen({ canOpenWorkspacePath: async () => { throw new Error('boom'); } }), 'unknown');
  assert.equal(await probeNativeOpen({ canOpenWorkspacePath: async () => true }), 'unknown', '裸布尔不是信封，不能当作回答');

  // 执行：请求体必须原样到达宿主，失败（拒绝 / 抛错 / 无能力）一律回答 false
  const seen = [];
  const session = {
    openWorkspacePath: async (request) => {
      seen.push(request);
      return { ok: true, value: null };
    }
  };
  assert.equal(await openNatively(session, '/w/dir', 'reveal'), true);
  assert.equal(await openNatively(session, '/w/a.ts', 'open'), true);
  assert.deepEqual(seen, [{ path: '/w/dir', action: 'reveal' }, { path: '/w/a.ts' }]);
  assert.equal(await openNatively(undefined, '/w/a.ts', 'open'), false);
  assert.equal(await openNatively({ openWorkspacePath: async () => ({ ok: false, error: {} }) }, '/w/a.ts', 'open'), false);
  assert.equal(await openNatively({ openWorkspacePath: async () => { throw new Error('nope'); } }, '/w/a.ts', 'open'), false);
})();

// ── apply：插槽注册 ─────────────────────────────────────────────────────────
/** 造一个够用的客户端根上下文；`sessions` / `remote` 按用例注入。 */
function makeCtx({ scoped, remote } = {}) {
  const state = { injectedInto: null, definitions: [], components: [], effects: 0 };
  const ctx = {
    get: (name) => {
      if (name === 'locale') return { register: () => {} };
      if (name === 'remote') return remote;
      if (name === 'sessions') return scoped === undefined ? undefined : { scope: () => scoped };
      return undefined;
    },
    effect: (fn) => {
      state.effects += 1;
      fn();
    },
    slots: {
      inject: (name, callback) => {
        state.injectedInto = name;
        callback();
      },
      register: (definition, component) => {
        state.definitions.push(definition);
        state.components.push(component);
        return () => {};
      }
    }
  };
  return { ctx, state };
}

const first = makeCtx();
plugin.apply(first.ctx);
assert.equal(first.state.injectedInto, 'sidebar.right.tab.files.actions', '挂在文件树表头槽上');
assert.equal(first.state.definitions.length, 1);
assert.equal(first.state.definitions[0].id, 'files-to-chat');
assert.equal(first.state.definitions[0].locale, 'filesToChat');
assert.equal(typeof first.state.components[0], 'function');
const face = first.state.definitions[0].inject();
assert.equal(typeof face.insertReferences, 'function');
assert.equal(typeof face.probeNatively, 'function');
assert.equal(typeof face.openNatively, 'function');
// 没有 remote 服务 → unknown：菜单项照常出现，点下去由宿主当场回答
assert.equal(await face.probeNatively(), 'unknown');
assert.equal(await face.openNatively('/w/a.ts', 'open'), false);

// 桌面宿主：业务面把 session 远程原样接出去
const openCalls = [];
const desktopCtx = makeCtx({
  remote: {
    session: {
      canOpenWorkspacePath: async () => ({ ok: true, value: true }),
      openWorkspacePath: async (request) => {
        openCalls.push(request);
        return { ok: true, value: null };
      }
    }
  }
});
plugin.apply(desktopCtx.ctx);
const desktopFace = desktopCtx.state.definitions[0].inject();
assert.equal(await desktopFace.probeNatively(), 'yes');
assert.equal(await desktopFace.openNatively('/w/dir', 'reveal'), true);
assert.deepEqual(openCalls, [{ path: '/w/dir', action: 'reveal' }]);

const REFS = [
  { source: 'reference', ref: '@a.ts', label: 'a.ts', appearance: 'file', clipboardText: '@a.ts' },
  { source: 'reference', ref: '@nested/', label: 'nested/', appearance: 'folder', clipboardText: '@nested/' }
];

// ── 插入：chip 通道 ─────────────────────────────────────────────────────────
const chipCalls = [];
const textCalls = [];
const chipCtx = makeCtx({
  scoped: {
    bail: (event, payload) => {
      chipCalls.push([event, payload]);
      return true;
    }
  }
});
plugin.apply(chipCtx.ctx);
const chipFace = chipCtx.state.definitions[0].inject();
const inputActions = {
  captureInsertion: () => ({ start: 0, end: 0, draftRev: 7 }),
  insertText: (text, span) => {
    textCalls.push([text, span.draftRev]);
    return true;
  }
};
assert.deepEqual(chipFace.insertReferences('session-1', REFS, inputActions), { ok: true, mode: 'chip', copied: false });
assert.deepEqual(chipCalls.map(([event, payload]) => [event, payload.reference.ref]), [
  ['slash/input-insert-reference', '@a.ts'],
  ['slash/input-insert-reference', '@nested/']
], '每条引用都走官方的插入事件（顺序不变）');
assert.equal(textCalls.length, 0, 'chip 通道成功时不写纯文本');

// ── 插入：事件通道不可用时降级为纯文本 ──────────────────────────────────────
const fallbackCtx = makeCtx({ scoped: { bail: () => undefined } });
plugin.apply(fallbackCtx.ctx);
const fallbackFace = fallbackCtx.state.definitions[0].inject();
textCalls.length = 0;
assert.deepEqual(fallbackFace.insertReferences('session-1', REFS, inputActions), { ok: true, mode: 'text', copied: false });
assert.deepEqual(textCalls.map(([text]) => text), ['@a.ts ', '@nested/ '], '降级后逐条插入纯文本 mention');

// ── 插入：第二条发现路径（作用域输入机），不依赖插槽下发 inputActions ────────
const machineCalls = [];
const machine = {
  captureInsertion: () => ({ start: 2, end: 2, draftRev: 11 }),
  insertReference: (reference, span) => {
    machineCalls.push(['chip', reference.ref, span.draftRev]);
    return true;
  },
  insertText: (text, span) => {
    machineCalls.push(['text', text, span.draftRev]);
    return true;
  }
};
const machineCtx = makeCtx({ scoped: { get: () => ({ input: { for: () => machine } }) } });
plugin.apply(machineCtx.ctx);
const machineFace = machineCtx.state.definitions[0].inject();
assert.deepEqual(machineFace.insertReferences('session-1', REFS, undefined), { ok: true, mode: 'chip', copied: false });
assert.deepEqual(machineCalls, [
  ['chip', '@a.ts', 11],
  ['chip', '@nested/', 11]
], '没有 inputActions 时直连作用域输入机插 chip');

// ── 插入：输入机拒绝 chip 时落到它的纯文本插入 ─────────────────────────────
machineCalls.length = 0;
const refusing = {
  captureInsertion: () => ({ start: 0, end: 0, draftRev: 3 }),
  insertReference: () => false,
  insertText: (text, span) => {
    machineCalls.push(['text', text, span.draftRev]);
    return true;
  }
};
const refuseCtx = makeCtx({ scoped: { get: () => ({ input: { for: () => refusing } }) } });
plugin.apply(refuseCtx.ctx);
const refuseFace = refuseCtx.state.definitions[0].inject();
assert.deepEqual(refuseFace.insertReferences('session-1', REFS, undefined), { ok: true, mode: 'text', copied: false });
assert.deepEqual(machineCalls.map(([, text]) => text), ['@a.ts ', '@nested/ ']);

// ── 插入：草稿正忙（无 scope）→ 剪贴板降级 ──────────────────────────────────
const copied = [];
const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: (text) => copied.push(text) } },
  configurable: true
});
try {
  const busyCtx = makeCtx();
  plugin.apply(busyCtx.ctx);
  const busyFace = busyCtx.state.definitions[0].inject();
  const busyActions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => false };
  assert.deepEqual(busyFace.insertReferences('session-1', REFS, busyActions), { ok: false, mode: 'text', copied: true });
  assert.deepEqual(copied, ['@a.ts @nested/ '], '写不进草稿时整批引用落到剪贴板');
  assert.deepEqual(busyFace.insertReferences('session-1', REFS, undefined), { ok: false, mode: 'none', copied: true });
} finally {
  if (previousNavigator === undefined) delete globalThis.navigator;
  else Object.defineProperty(globalThis, 'navigator', previousNavigator);
}

console.log('dsh-files-to-chat: 全部纯函数测试通过');
