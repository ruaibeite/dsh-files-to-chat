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
assert.deepEqual(plugin.inject, ['slots'], '只注入插槽注册表');

const { pathBasename, relativizeToCwd, formatFileMention, buildReference, buildReferences, interpolate } = plugin.__test;

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

// ── apply：插槽注册 ─────────────────────────────────────────────────────────
/** 造一个够用的客户端根上下文；`sessions` 按用例注入。 */
function makeCtx({ scoped } = {}) {
  const state = { injectedInto: null, definitions: [], components: [], effects: 0 };
  const ctx = {
    get: (name) => {
      if (name === 'locale') return { register: () => {} };
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
