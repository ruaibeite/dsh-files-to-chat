/**
 * @ruaibeite/dsh-files-to-chat — 浏览器半边（client half）。
 *
 * 在右侧栏「文件」标签的文件树行上挂一个右键菜单：把文件/文件夹作为 `@` 引用
 * 添加到当前会话的输入框（composer 草稿）。按住 ⌘/Ctrl 点击可以多选，Shift 点击
 * 连选，然后一次把整批引用插进草稿。
 *
 * ## 为什么用这种接法
 *
 * 官方 `dsh-client-ui-sidebar-files` 的行是只读渲染：
 * `<li data-files-entry="file|directory|other" data-files-path="…">` 包一个
 * `<button>`，没有行级插槽；该标签只为表头声明了 Session 作用域的
 * `sidebar.right.tab.files.actions` 列表槽（`ui-open-in-app` 就在那里放工作区目录
 * 打开按钮）。所以本插件：
 *
 * 1. 注册进表头插槽，从而拿到 `sessionId`、`inputActions` 与所属标签的
 *    `absolutePath`（= 该树显示的根，也就是该会话 cwd）；
 * 2. 从自己在表头渲染的锚点向上找到本标签的树根 `[data-files-root]`，用捕获阶段
 *    的 `contextmenu` / `click` / `keydown` 监听增强行行为——普通点击仍然完全是树
 *    自己的打开/展开语义，只有带修饰键的点击被本插件接管；
 * 3. 选中的行靠给自己打的 `data-files-to-chat-selected` 标记属性 + 一张注入的
 *    样式表显示，因此不需要改写官方组件的渲染。
 *
 * ## 插入走官方通道，按可用性降级
 *
 * 输入面有两条互为备份的发现路径：框架交给 Session 作用域组件的标准 prop
 * `inputActions`；它缺席时退回 `ctx.sessions.scope(sessionId).get('conversation')
 * .input.for(scope)`——那就是输入机本身，`slash/input-insert-reference` 的监听器调用
 * 的同一个对象（见 `resolvePort`）。
 *
 * 引用形态同样逐级降级：
 *
 * - 直连输入机的 `insertReference`，或官方在 Session 作用域上监听的
 *   `slash/input-insert-reference` 事件（`@` 补全菜单 pick 的同一条路径）。载荷形状
 *   与 `ui-reference` 的 pick 产物一致，因此得到的是**真正的原子引用 chip**：图标、
 *   整块删除、剪贴板投影都由官方负责。
 * - 两者都不可用时插入纯文本 `@path`（`inputActions.insertText(mention, span)`，官方
 *   Voice Input 插件正在用的公开面）。按 `dsh-file-reference` 的说明，`@path` 本身
 *   就是引用的序列化形式，两种形态在模型侧语义相同（引用**不会**附带文件内容，模型
 *   仍要用文件工具去读）。
 *
 * 每条引用都用 `captureInsertion()` 的 `draftRev` 做 CAS：插入期间用户改了草稿就失败，
 * 此时把剩余的引用文本复制到剪贴板并提示，而不是静默丢掉。
 *
 * 本文件是**手写的**预构建客户端入口，不需要任何打包步骤：浏览器端
 * `__ModuleLoader__` 会执行它，工厂函数拿到宿主的 `require`（React、react-dom 与
 * 官方客户端包都由宿主提供）。
 */
window.__ModuleLoader__.load({
  id: '@ruaibeite/dsh-files-to-chat',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const ReactDOM = require('react-dom');

    /** Stable Loader/module identity. */
    const name = 'files-to-chat';
    /** 本插件拥有的 locale 命名空间。 */
    const NS = 'filesToChat';
    /**
     * 客户端服务：只需要插槽注册表。`sessions` / `locale` 都在用到时经 `ctx.get`
     * 惰性读取，免得给加载顺序增加无谓的约束。
     */
    const inject = ['slots'];

    /** 注入样式表的 id（每页一张）。 */
    const STYLE_ID = 'dsh-files-to-chat-style';
    /** 菜单估算宽度，用于贴边收拢。 */
    const MENU_WIDTH = 268;
    /** 菜单行高，用于估算高度并贴边收拢。 */
    const ITEM_HEIGHT = 30;

    //#region 纯函数：路径与 `@` 引用语法
    /**
     * 取路径最后一段（去掉尾随分隔符）。
     * @param path - 绝对或相对路径。
     * @returns 最后一段；路径为空时返回原值。
     */
    function pathBasename(path) {
      const trimmed = path.replace(/[/\\]+$/u, '');
      const match = /[^/\\]*$/u.exec(trimmed);
      return match === null ? trimmed : match[0];
    }

    /**
     * 把工作区内的绝对路径缩成相对形式（只影响显示与引用文本）。
     *
     * 与 Conversation 的实现保持一致：只剥掉 cwd 前缀，不做 `..` 计算。
     * @param text - 待缩短的路径。
     * @param cwd - 会话工作区根；缺失或为空时原样返回。
     * @returns 相对工作区根的路径，或原路径（不在该根下时）。
     */
    function relativizeToCwd(text, cwd) {
      if (cwd === undefined || cwd === null || cwd === '') return text;
      const root = cwd.replace(/[/\\]+$/u, '');
      if (root === '') return text;
      if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1);
      return text;
    }

    /**
     * 把一条路径写成共享 `@` 引用语法的文本。
     *
     * 语义与 `ui-reference` 的 `formatFileMention` 相同，只有一处刻意的差别：目录也
     * 使用**闭合**引号（`@"dir name/"`）。官方对目录返回未闭合的 `@"dir/`，因为它那
     * 个分支是「继续下钻」的中间态；本插件插入的是一条完整引用，闭合形式才是合法且
     * 无歧义的。
     * @param candidate - `{ path, kind }`，`kind` 为 `file` 或 `directory`。
     * @param preserveQuote - 即使用户没有需要也保留引号（此处恒为 false）。
     * @returns mention 文本；编辑器语法无法安全表示时返回 undefined。
     */
    function formatFileMention(candidate, preserveQuote) {
      const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path;
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
      if (!(preserveQuote === true || /\s/u.test(path))) return `@${path}`;
      return `@"${path}"`;
    }

    /**
     * 把一条文件树条目变成一枚引用 chip 的完整载荷。
     *
     * 字段与 `ui-reference` 的 pick 产物逐字一致，因此 Conversation 的 chip 渲染、
     * owner codec（`serialize` / `clipboardText` 都返回 `ref` 本身）都能直接吃下。
     * @param absolutePath - 条目的绝对路径。
     * @param kind - `file` 或 `directory`。
     * @param cwd - 会话工作区根，用于相对化。
     * @returns 引用载荷；无法表示时返回 undefined。
     */
    function buildReference(absolutePath, kind, cwd) {
      const relative = relativizeToCwd(absolutePath, cwd);
      const mention = formatFileMention({ path: relative, kind }, false);
      if (mention === undefined) return undefined;
      const base = pathBasename(absolutePath);
      const directory = kind === 'directory';
      return {
        source: 'reference',
        ref: mention,
        label: directory ? `${base}/` : base,
        appearance: directory ? 'folder' : 'file',
        clipboardText: mention
      };
    }

    /**
     * 按选择顺序构建一批引用：保序、按路径去重、跳过无法表示的条目。
     * @param items - `{ path, kind }` 列表。
     * @param cwd - 会话工作区根。
     * @returns 引用载荷数组。
     */
    function buildReferences(items, cwd) {
      const references = [];
      const seen = new Set();
      for (const item of items) {
        if (item === undefined || item === null) continue;
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        const reference = buildReference(item.path, item.kind, cwd);
        if (reference !== undefined) references.push(reference);
      }
      return references;
    }

    /**
     * 把一段文本写进剪贴板（降级路径用）。
     * @param text - 待复制文本。
     * @returns 是否成功发起复制。
     */
    function copyText(text) {
      const clipboard = globalThis.navigator === undefined ? undefined : globalThis.navigator.clipboard;
      if (clipboard === undefined || typeof clipboard.writeText !== 'function') return false;
      try {
        void clipboard.writeText(text);
        return true;
      } catch (error) {
        return false;
      }
    }
    //#endregion

    //#region 插入
    /**
     * 把一批引用插进当前会话草稿。
     *
     * 逐条插入并各自取一次 `captureInsertion()`：chip 通道每插一条都会推进草稿修订
     * 号，复用同一个 span 会被 CAS 拒绝。chip 通道某一条失败就整体降级为纯文本，避免
     * 同一批里两种形态混排。
     * @param ctx - 客户端根上下文。
     * @param sessionId - 目标会话。
     * @param references - 引用载荷（顺序即插入顺序）。
     * @param inputActions - 输入动作面（`captureInsertion` / `insertText`）。
     * @returns `{ ok, mode, copied }`；失败且已复制到剪贴板时 `copied` 为 true。
     */
    function insertReferences(ctx, sessionId, references, inputActions) {
      const port = resolvePort(ctx, sessionId, inputActions);
      const whole = `${references.map((reference) => reference.clipboardText).join(' ')} `;
      if (!port.hasChip && !port.hasText) return { ok: false, mode: 'none', copied: copyText(whole) };
      let chips = port.hasChip;
      for (let index = 0; index < references.length; index += 1) {
        const reference = references[index];
        if (chips) {
          if (port.insertChip(reference) === true) continue;
          chips = false;
        }
        if (port.insertText(`${reference.clipboardText} `) !== true) {
          const rest = `${references.slice(index).map((item) => item.clipboardText).join(' ')} `;
          return { ok: false, mode: chips ? 'chip' : 'text', copied: copyText(rest) };
        }
      }
      port.focus();
      return { ok: true, mode: chips ? 'chip' : 'text', copied: false };
    }

    /**
     * 取会话作用域上下文（`ctx.sessions.scope(sessionId)`），失败返回 undefined。
     * @param ctx - 客户端根上下文。
     * @param sessionId - 目标会话。
     * @returns Agent 作用域上下文，或 undefined（该会话没有保留的代际）。
     */
    function scopeOf(ctx, sessionId) {
      try {
        const sessions = ctx.get('sessions');
        if (sessions === undefined || typeof sessions.scope !== 'function') return undefined;
        return sessions.scope(sessionId) ?? undefined;
      } catch (error) {
        return undefined;
      }
    }

    /**
     * 解析插入端口。两条发现路径互为备份：
     *
     * 1. 框架交给 Session 作用域组件的标准 prop `inputActions`（公开面）；
     * 2. 作用域里的会话服务：`scope.get('conversation').input.for(scope)` 返回的就是
     *    输入机本身——`slash/input-insert-reference` 的监听器调用的是同一个对象，因此
     *    即使插槽没有下发 `inputActions`，本插件照样能插入。
     *
     * chip 优先直连输入机的 `insertReference`，再退回官方事件；纯文本优先用公开面的
     * `insertText`（Voice Input 用的那条），再退回输入机。两条通道都用
     * `captureInsertion()` 的 `draftRev` 做 CAS。
     * @param ctx - 客户端根上下文。
     * @param sessionId - 目标会话。
     * @param supplied - 标准 prop `inputActions`（可能缺席）。
     * @returns 端口：`capture` / `insertChip` / `insertText` 与两条通道的可用性。
     */
    function resolvePort(ctx, sessionId, supplied) {
      const scoped = scopeOf(ctx, sessionId);
      let machine;
      try {
        const conversation = scoped === undefined || typeof scoped.get !== 'function' ? undefined : scoped.get('conversation');
        const input = conversation === undefined || conversation === null ? undefined : conversation.input;
        machine = input !== undefined && typeof input.for === 'function' ? input.for(scoped) : undefined;
      } catch (error) {
        machine = undefined;
      }
      const actions = supplied === undefined || supplied === null ? undefined : supplied;
      const sources = [actions, machine];
      const capture = () => {
        for (const source of sources) {
          if (source !== undefined && typeof source.captureInsertion === 'function') {
            try {
              const span = source.captureInsertion();
              if (span !== undefined && span !== null) return span;
            } catch (error) {
              // 试下一个来源
            }
          }
        }
        return undefined;
      };
      const insertChip = (reference) => {
        const span = capture();
        if (span === undefined) return false;
        if (machine !== undefined && typeof machine.insertReference === 'function') {
          try {
            if (machine.insertReference(reference, span) === true) return true;
          } catch (error) {
            // 落到事件通道
          }
        }
        if (scoped === undefined || typeof scoped.bail !== 'function') return false;
        try {
          return scoped.bail('slash/input-insert-reference', { reference, span }) === true;
        } catch (error) {
          return false;
        }
      };
      const insertText = (text) => {
        const span = capture();
        if (span === undefined) return false;
        if (actions !== undefined && typeof actions.insertText === 'function') {
          try {
            if (actions.insertText(text, span) === true) return true;
          } catch (error) {
            // 落到输入机
          }
        }
        if (machine !== undefined && typeof machine.insertText === 'function') {
          try {
            return machine.insertText(text, span) === true;
          } catch (error) {
            return false;
          }
        }
        return false;
      };
      return {
        capture,
        insertChip,
        insertText,
        /** 把键盘交回 composer（插入完成后光标正好落在引用之后）。 */
        focus: () => {
          if (machine === undefined || typeof machine.focus !== 'function') return;
          try {
            machine.focus();
          } catch (error) {
            // 焦点只是顺手的体验，失败不影响插入结果
          }
        },
        hasChip: (machine !== undefined && typeof machine.insertReference === 'function')
          || (scoped !== undefined && typeof scoped.bail === 'function'),
        hasText: (actions !== undefined && typeof actions.insertText === 'function')
          || (machine !== undefined && typeof machine.insertText === 'function')
      };
    }
    //#endregion

    //#region 文案
    const zh = {
      'menu.add': '添加到对话',
      'menu.addMany': '添加所选 {count} 项到对话',
      'menu.copy': '复制路径',
      'menu.hint': '{modifier}+点击多选，Shift+点击连选',
      'menu.folder': '文件夹',
      'menu.file': '文件',
      'header.add': '添加到对话（{count}）',
      'header.title': '把选中的 {count} 项作为 @ 引用插入输入框',
      'header.clear': '清除选择',
      'toast.added': '已添加 {count} 项引用到对话',
      'toast.copied': '输入框正忙，引用已复制到剪贴板',
      'toast.copiedPath': '路径已复制',
      'toast.failed': '添加失败：无法写入输入框',
      'toast.empty': '这些条目无法表示成 @ 引用'
    };
    const en = {
      'menu.add': 'Add to conversation',
      'menu.addMany': 'Add {count} selected to conversation',
      'menu.copy': 'Copy path',
      'menu.hint': '{modifier}+click to multi-select, Shift+click for a range',
      'menu.folder': 'Folder',
      'menu.file': 'File',
      'header.add': 'Add to conversation ({count})',
      'header.title': 'Insert the {count} selected item(s) into the composer as @ references',
      'header.clear': 'Clear selection',
      'toast.added': 'Added {count} reference(s) to the conversation',
      'toast.copied': 'Composer is busy — references copied to the clipboard',
      'toast.copiedPath': 'Path copied',
      'toast.failed': 'Could not write into the composer',
      'toast.empty': 'These entries cannot be written as @ references'
    };

    /** 多选修饰键的显示形式（按平台）。 */
    const MODIFIER = (() => {
      const platform = globalThis.navigator === undefined ? '' : globalThis.navigator.platform ?? '';
      return /Mac|iPhone|iPad|iPod/u.test(platform) ? '⌘' : 'Ctrl';
    })();

    /**
     * 用参数替换 `{name}` 占位。
     * @param text - 模板。
     * @param params - 替换表。
     * @returns 替换后的文本。
     */
    function interpolate(text, params) {
      if (params === undefined) return text;
      return text.replace(/\{(\w+)\}/gu, (match, key) => (key in params ? String(params[key]) : match));
    }

    /**
     * `t` 的兜底：词典没注册、命名空间未绑定或键缺失时，退回本插件自带的中文表，
     * 而不是把 `menu.add` 这种键名画到界面上。
     * @param rawT - 框架绑定的 `t`（可能缺席）。
     * @param key - 词典键。
     * @param params - 插值参数。
     * @returns 最终文案。
     */
    function translate(rawT, key, params) {
      const extra = key === 'menu.hint' ? { modifier: MODIFIER, ...params } : params;
      if (typeof rawT === 'function') {
        try {
          // 注意传 `extra` 而不是 `params`：框架的 `t` 只替换它收到的参数，
          // 把内部补的 `modifier` 漏在外面就会把 `{modifier}` 原样画到界面上。
          const text = rawT(key, extra);
          if (typeof text === 'string' && text !== key) return text;
        } catch (error) {
          // 交给兜底表
        }
      }
      return interpolate(zh[key] ?? key, extra);
    }
    //#endregion

    //#region 样式
    const CSS = [
      /* 选中行：借用官方行按钮的悬停底色，再加一枚极小的标记点。 */
      'li[data-files-to-chat-selected="true"] > button{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3)}',
      'li[data-files-to-chat-selected="true"] > button > span:last-child::after{content:"";display:inline-block;width:6px;height:6px;margin-left:6px;border-radius:50%;background:var(--dsw-alias-label-primary);opacity:.5;vertical-align:middle}',
      /* 表头上的选中芯片。 */
      '.dsh-ftc-chipwrap{display:inline-flex;flex:none;align-items:center;gap:2px}',
      '.dsh-ftc-chip{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-content-font-size-secondary,12px);line-height:1;white-space:nowrap;cursor:pointer}',
      '.dsh-ftc-chip:hover{color:var(--dsw-alias-label-primary);filter:brightness(1.06)}',
      '.dsh-ftc-chip-clear{display:inline-flex;align-items:center;justify-content:center;width:20px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.dsh-ftc-chip-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      /*
       * 右键菜单：自绘的不透明卡片。
       *
       * 不借用 primitives 的 MenuSurface：它的材质是半透明填充
       * （--dsw-menu-surface-fill）+ backdrop-filter，只有靠 macOS 的**不透明衬底**
       * （.backing，用 CSS anchor 定位、放在 body 的 isolation 里、z-index -1、垫在整页
       * 内容之下）才不透视。本插件把菜单 portal 到 body 时衬底会落到菜单之上，结果就是
       * 菜单看起来「没在最上层」——页面内容从菜单里透出来。这里直接用主题的层级底色画
       * 一张不透明卡片，并把层级提到官方 portal 菜单（z 1100）之上。
       */
      '.dsh-ftc-menu{position:fixed;z-index:1200;box-sizing:border-box;min-width:248px;max-width:360px;padding:4px;border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base,#2b2d31));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l3,rgba(255,255,255,.12)));box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.28))}',
      '.dsh-ftc-item{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:6px 10px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.4;text-align:left;cursor:pointer}',
      '.dsh-ftc-item:hover,.dsh-ftc-item-active{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-ftc-item:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-ftc-item:disabled:hover{background:transparent}',
      '.dsh-ftc-item-hint{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      /* 提示条。 */
      '.dsh-ftc-toast{position:fixed;right:16px;bottom:16px;z-index:1200;max-width:340px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base,#2b2d31));color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.28));pointer-events:none}'
    ].join('\n');

    /**
     * 注入样式表：同一页只保留一张，且每次加载都换成当前这份。
     *
     * 后半句是必须的——客户端插件被 HMR 重载时（改文件即可触发），上一代模块留下的
     * 样式表还在 head 里；若此时直接 return，旧规则会继续生效，样式改动要刷新整页才
     * 看得见。先摘掉旧的再挂新的，规则集始终等于这份代码。
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      const existing = document.getElementById(STYLE_ID);
      if (existing !== null) existing.remove();
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    //#endregion

    //#region 组件
    /**
     * 文件树表头上的挂载点：一枚零宽锚点（用来定位本标签的树根）、选中态芯片、
     * 右键菜单与提示条。
     *
     * 组件本身不渲染树，也不持有树的状态；它只读 `data-files-*` 属性、给选中的行
     * 打标记，并把「添加到对话」这个动作接到官方插入通道上。
     * @param props - 框架 share（`sessionId`、`inputActions`、`t`…）+
     * 本插件 `inject` 的 `insertReferences`，以及所有者传入的 `absolutePath`。
     * @returns 锚点 + 可选菜单/提示条。
     */
    function FilesToChat(props) {
      const rawT = props.t;
      const t = React.useCallback((key, params) => translate(rawT, key, params), [rawT]);
      const sessionId = props.sessionId;
      const insert = props.insertReferences;
      const cwd = typeof props.absolutePath === 'string' ? props.absolutePath : undefined;

      const [selection, setSelection] = React.useState([]);
      const [menu, setMenu] = React.useState(null);
      const [toast, setToast] = React.useState(null);
      const anchorRef = React.useRef(null);
      const menuNodeRef = React.useRef(null);
      const toastTimerRef = React.useRef(null);
      /** 事件监听器读它们，免得每次选择/开合都重挂一遍监听。 */
      const selectionRef = React.useRef(selection);
      const menuStateRef = React.useRef(menu);
      selectionRef.current = selection;
      menuStateRef.current = menu;

      /** 本组件所属的文件树根：表头就在 `[data-files-root]` 里面。 */
      const treeRoot = React.useCallback(() => {
        const anchor = anchorRef.current;
        if (anchor === null || typeof anchor.closest !== 'function') return null;
        return anchor.closest('[data-files-root]');
      }, []);

      /** 当前树里可引用的行（文件与目录）。 */
      const rowsOf = React.useCallback(() => {
        const root = treeRoot();
        if (root === null) return [];
        return Array.from(root.querySelectorAll('[data-files-entry="file"][data-files-path], [data-files-entry="directory"][data-files-path]'));
      }, [treeRoot]);

      /** 行 → 条目快照。 */
      const itemOf = (row) => ({
        path: row.getAttribute('data-files-path'),
        kind: row.getAttribute('data-files-entry') === 'directory' ? 'directory' : 'file'
      });

      /** 把选择状态刷到 DOM 标记属性上（树重绘后需要重刷）。 */
      const paint = React.useCallback(() => {
        const selected = new Set(selectionRef.current.map((item) => item.path));
        for (const row of rowsOf()) {
          const path = row.getAttribute('data-files-path');
          if (path !== null && selected.has(path)) row.setAttribute('data-files-to-chat-selected', 'true');
          else row.removeAttribute('data-files-to-chat-selected');
        }
      }, [rowsOf]);

      React.useEffect(() => {
        paint();
      }, [paint, selection]);

      /** 展开目录、点刷新都会重建行，因此盯着树根的子节点变化重刷标记。 */
      React.useEffect(() => {
        const root = treeRoot();
        if (root === null || typeof MutationObserver !== 'function') return undefined;
        const observer = new MutationObserver(() => {
          paint();
        });
        observer.observe(root, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
        };
      }, [paint, treeRoot, cwd]);

      /** 卸载时擦掉自己打的标记（标签关闭 / 会话切换）。 */
      React.useEffect(() => () => {
        for (const row of document.querySelectorAll('[data-files-to-chat-selected]')) row.removeAttribute('data-files-to-chat-selected');
      }, []);

      /** 命中的行必须落在本标签的树里，否则交给别人（分栏时可能有多个树）。 */
      const hitOf = React.useCallback((target) => {
        if (!(target instanceof Element)) return null;
        const row = target.closest('[data-files-entry][data-files-path]');
        if (row === null) return null;
        const kind = row.getAttribute('data-files-entry');
        if (kind !== 'file' && kind !== 'directory') return null;
        const root = treeRoot();
        if (root === null || !root.contains(row)) return null;
        const path = row.getAttribute('data-files-path');
        if (path === null || path === '') return null;
        return { path, kind };
      }, [treeRoot]);

      /** 弹出提示条。 */
      const showToast = React.useCallback((text) => {
        setToast({ text, at: Date.now() });
        if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => {
          toastTimerRef.current = null;
          setToast(null);
        }, 2600);
      }, []);

      React.useEffect(() => () => {
        if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
      }, []);

      /** 把一批条目插进草稿，并按结果给反馈。 */
      const runInsert = React.useCallback((targets) => {
        setMenu(null);
        const references = buildReferences(targets, cwd);
        if (references.length === 0) {
          showToast(t('toast.empty'));
          return;
        }
        const outcome = typeof insert === 'function'
          ? insert(sessionId, references, props.inputActions)
          : { ok: false, copied: false };
        if (outcome.ok === true) {
          showToast(t('toast.added', { count: references.length }));
          setSelection([]);
          return;
        }
        if (outcome.copied === true) {
          showToast(t('toast.copied'));
          return;
        }
        showToast(t('toast.failed'));
      }, [cwd, insert, props.inputActions, sessionId, showToast, t]);

      /** 复制某一行的绝对路径。 */
      const runCopy = React.useCallback((target) => {
        setMenu(null);
        showToast(copyText(target.path) ? t('toast.copiedPath') : t('toast.failed'));
      }, [showToast, t]);

      /** 菜单条目：多选时是单条批量动作，单选时另有复制路径。 */
      const itemsOf = React.useCallback((targets) => {
        const items = targets.length > 1
          ? [{ id: 'add', label: t('menu.addMany', { count: targets.length }), run: () => runInsert(targets) }]
          : [
            { id: 'add', label: t('menu.add'), hint: targets[0].kind === 'directory' ? t('menu.folder') : t('menu.file'), run: () => runInsert(targets) },
            { id: 'copy', label: t('menu.copy'), run: () => runCopy(targets[0]) }
          ];
        items.push({ id: 'hint', label: t('menu.hint'), enabled: false });
        return items;
      }, [runCopy, runInsert, t]);

      /** 菜单与提示条出现的坐标/内容。 */
      const activate = React.useCallback((item) => {
        setMenu(null);
        item.run();
      }, []);

      React.useEffect(() => {
        /** 右键：接管为「添加到对话」。 */
        const onContextMenu = (event) => {
          const hit = hitOf(event.target);
          if (hit === null) return;
          event.preventDefault();
          event.stopPropagation();
          const current = selectionRef.current;
          const targets = current.length > 1 && current.some((item) => item.path === hit.path) ? current : [hit];
          setMenu({ x: event.clientX, y: event.clientY, targets, active: 0 });
        };

        /** 菜单开着时，菜单外的任何按下都先关掉它。 */
        const onPointerDown = (event) => {
          if (menuStateRef.current === null) return;
          const node = menuNodeRef.current;
          if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
          setMenu(null);
        };

        /** 修饰键点击 = 多选；普通点击保持树自己的打开/展开语义，只清掉选择。 */
        const onClick = (event) => {
          const hit = hitOf(event.target);
          if (hit === null) return;
          const modified = event.metaKey || event.ctrlKey || event.shiftKey;
          if (!modified) {
            setSelection((previous) => (previous.length === 0 ? previous : []));
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const rows = rowsOf();
          const entries = rows.map(itemOf).filter((item) => item.path !== null);
          setSelection((previous) => {
            const paths = entries.map((item) => item.path);
            if (event.shiftKey) {
              const anchor = previous.length > 0 ? previous[previous.length - 1].path : hit.path;
              const from = paths.indexOf(anchor);
              const to = paths.indexOf(hit.path);
              if (from === -1 || to === -1) return [hit];
              const start = Math.min(from, to);
              const end = Math.max(from, to);
              return entries.slice(start, end + 1);
            }
            const exists = previous.some((item) => item.path === hit.path);
            return exists ? previous.filter((item) => item.path !== hit.path) : [...previous, hit];
          });
        };

        /** 菜单开着时接管方向键与回车；Esc 关菜单或清选择。 */
        const onKeyDown = (event) => {
          const open = menuStateRef.current;
          if (open === null) {
            if (event.key === 'Escape') setSelection((previous) => (previous.length === 0 ? previous : []));
            return;
          }
          const items = itemsOf(open.targets);
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setMenu(null);
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            const reachable = items.map((item, index) => (item.enabled === false ? -1 : index)).filter((index) => index !== -1);
            setMenu((current) => {
              if (current === null || reachable.length === 0) return current;
              const at = reachable.indexOf(current.active);
              const step = event.key === 'ArrowDown' ? 1 : reachable.length - 1;
              const next = at === -1 ? reachable[0] : reachable[(at + step) % reachable.length];
              return { ...current, active: next };
            });
            return;
          }
          if (event.key === 'Enter') {
            const item = items[open.active];
            if (item === undefined || item.enabled === false) return;
            event.preventDefault();
            event.stopPropagation();
            activate(item);
          }
        };

        /** 滚动会让固定坐标的菜单错位，直接收起来。 */
        const onScroll = () => {
          if (menuStateRef.current !== null) setMenu(null);
        };

        document.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('scroll', onScroll, true);
        return () => {
          document.removeEventListener('contextmenu', onContextMenu, true);
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('scroll', onScroll, true);
        };
      }, [activate, hitOf, itemsOf, rowsOf]);

      const chip = selection.length === 0 ? null : React.createElement('span', {
        className: 'dsh-ftc-chipwrap',
        'data-files-to-chat-chip': true
      }, [
        React.createElement('button', {
          key: 'add',
          type: 'button',
          className: 'dsh-ftc-chip',
          title: t('header.title', { count: selection.length }),
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            runInsert(selectionRef.current);
          }
        }, `＋ ${t('header.add', { count: selection.length })}`),
        React.createElement('button', {
          key: 'clear',
          type: 'button',
          className: 'dsh-ftc-chip-clear',
          title: t('header.clear'),
          'aria-label': t('header.clear'),
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            setSelection([]);
          }
        }, '×')
      ]);

      const menuNode = menu === null ? null : (() => {
        const items = itemsOf(menu.targets);
        const left = Math.max(8, Math.min(menu.x, (globalThis.innerWidth ?? 0) - MENU_WIDTH - 8));
        const top = Math.max(8, Math.min(menu.y, (globalThis.innerHeight ?? 0) - items.length * ITEM_HEIGHT - 16));
        return ReactDOM.createPortal(React.createElement('div', {
          ref: menuNodeRef,
          className: 'dsh-ftc-menu',
          role: 'menu',
          'data-files-to-chat-menu': true,
          style: { position: 'fixed', left, top, zIndex: 1200 }
        }, items.map((item, index) => React.createElement('button', {
          key: item.id,
          type: 'button',
          role: 'menuitem',
          disabled: item.enabled === false,
          className: index === menu.active ? 'dsh-ftc-item dsh-ftc-item-active' : 'dsh-ftc-item',
          onMouseEnter: () => setMenu((current) => (current === null ? current : { ...current, active: index })),
          onMouseDown: (event) => {
            event.preventDefault();
            event.stopPropagation();
          },
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            activate(item);
          }
        }, [
          React.createElement('span', { key: 'label' }, item.label),
          item.hint === undefined ? null : React.createElement('span', { key: 'hint', className: 'dsh-ftc-item-hint' }, item.hint)
        ]))), document.body);
      })();

      const toastNode = toast === null ? null : ReactDOM.createPortal(React.createElement('div', {
        className: 'dsh-ftc-toast',
        role: 'status',
        'data-files-to-chat-toast': true
      }, toast.text), document.body);

      return React.createElement(React.Fragment, null, [
        React.createElement('span', {
          key: 'anchor',
          ref: anchorRef,
          'data-files-to-chat-anchor': true,
          style: { display: 'contents' }
        }, chip),
        menuNode,
        toastNode
      ]);
    }
    //#endregion

    /**
     * 挂载：注册表头插槽条目，并按需注册词典与样式表。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ensureStyle();
      const locale = ctx.get('locale');
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh, en }), 'files-to-chat: dictionaries');
      }
      ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({
        name: 'sidebar.right.tab.files.actions',
        id: 'files-to-chat',
        order: 40,
        locale: NS,
        inject: () => ({
          insertReferences: (sessionId, references, inputActions) => insertReferences(ctx, sessionId, references, inputActions)
        })
      }, FilesToChat));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    /** 给 node 侧测试用的纯函数出口（浏览器里无人读它）。 */
    exports.__test = { pathBasename, relativizeToCwd, formatFileMention, buildReference, buildReferences, interpolate, translate, MODIFIER };
    return module.exports;
  }
});
