# @ruaibeite/dsh-files-to-chat

右侧栏文件树的**右键 →「添加到对话」**：把文件或文件夹作为 `@` 引用插进当前会话的
输入框，支持多选批量插入。

```
右键任意文件/文件夹  →  添加到对话        →  草稿里多出一枚 @path 引用
⌘/Ctrl+点击 多选     →  右键 → 添加所选 N 项
```

## 它做什么

| 操作 | 结果 |
| --- | --- |
| 右键文件行 | 菜单：「添加到对话」「复制路径」 |
| 右键文件夹行 | 同上，插入 `@dir/` 形式的引用 |
| ⌘/Ctrl + 点击 | 把该行加入/移出选择（不会打开文件） |
| Shift + 点击 | 从上次选择连选到这一行 |
| 右键已选中的行 | 菜单变成「添加所选 N 项到对话」，一次插完整批 |
| 表头芯片 | 有选择时出现在文件树表头，点一下就能插入，`×` 清除选择 |
| Escape | 关菜单；菜单没开时清除选择 |

普通点击**完全不改变**文件树原有行为（打开文件 / 展开目录），只是顺手清掉选择。

## 插入的是什么

插入的是 `@` 引用语法本身——和你在输入框里打 `@` 再选一个文件完全等价：

- 工作区内的路径写成相对形式（`@iwcc/iwcc.sql`），工作区外保留绝对形式；
- 含空格的路径写成闭合引号形式（`@"my docs/a b.md"`、`@"ba docs/"`）；
- 引用**不会**附带文件内容：按 `dsh-file-reference` 的设计，`@path` 只是提示词里的
  一段文本，模型仍需用文件工具去读。所以加引用很便宜，也不会把大文件灌进上下文。

## 实现要点

官方 `dsh-client-ui-sidebar-files` 的行是只读渲染
（`<li data-files-entry data-files-path>` + 一个 `<button>`），没有行级插槽，只有表头的
`sidebar.right.tab.files.actions`。因此本插件：

1. 注册进表头插槽（Session 作用域），从而拿到 `sessionId`、`inputActions`，以及所有者
   传入的 `absolutePath`（该树显示的根 = 该会话 cwd）；
2. 从自己在表头渲染的零宽锚点向上找到本标签的树根 `[data-files-root]`，用**捕获阶段**
   的 `contextmenu` / `click` / `keydown` 监听增强行行为；
3. 选中的行靠本插件打的 `data-files-to-chat-selected` 标记 + 一张注入的样式表显示，
   所以不改写官方组件的渲染。

插入按可用性降级，两条发现路径互为备份：

- **输入面**：优先用框架交给 Session 作用域组件的标准 prop `inputActions`；它缺席时
  退回作用域里的会话服务——`ctx.sessions.scope(sessionId).get('conversation')
  .input.for(scope)` 返回的就是输入机本身，也就是 `slash/input-insert-reference` 的
  监听器调用的同一个对象。所以即使插槽没有下发 `inputActions`，本插件照样能插入。
- **引用形态**：先直连输入机的 `insertReference`（得到**真正的原子引用 chip**：图标、
  整块删除、剪贴板投影都由官方负责），失败再退回官方事件
  `slash/input-insert-reference`（`@` 补全菜单 pick 的同一条路径，载荷形状与
  `ui-reference` 的 pick 产物一致），两条都不行才降级为纯文本
  `inputActions.insertText(mention, span)`——这是官方 Voice Input 插件正在用的公开面，
  模型侧语义与 chip 相同。

两条通道都用 `inputActions.captureInsertion()` 的 `draftRev` 做 CAS：插入期间草稿被改
过就失败，此时引用文本会被复制到剪贴板并提示，而不是静默丢掉。草稿正忙（提交/裁决中）
时同样走剪贴板降级。插入成功后会把键盘交回输入框（`machine.focus()`），光标正好落在
刚插入的引用之后。

## 安装

```sh
./install.sh                 # 装进 desktop profile（默认，也就是桌面 App 用的那个）
PROFILE_NAME=web ./install.sh # 装进别的 profile
```

手工等价做法：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add /Users/ruaibeite/Desktop/dsh-files-to-chat
```

装完**重启 Harness**（浏览器半边是随会话引导下发的，光刷新页面不够）。确认挂载：

```sh
dsh --profile desktop --dump-config | grep -A2 files-to-chat
```

## 已知限制

- 只增强官方文件树的**行**（文件与文件夹）。`other` 类型（socket、设备文件等）不可读，
  菜单不出现，右键仍是系统菜单。
- 多选状态是本插件自己的，存在组件内存里：切换标签、刷新树、换会话都会清空（这是刻意的
  ——它不是文件树的状态，别的入口改不动它）。
- 文件夹引用只插 `@dir/`，不会展开成目录下的文件清单。
- 依赖官方的行 DOM 契约（`data-files-entry` / `data-files-path` / `data-files-root`）。
  DSH 改这些属性名时，右键菜单会安静地不再出现（不会误伤别处）。

## 开发

```sh
node test/mention.mjs   # 路径相对化、@ 引用语法、批量构建的纯函数回归
```

客户端入口 `client/client.js` 是**手写的**预构建模块（`window.__ModuleLoader__.load`），
不需要打包步骤；改完重启 Harness 即可。

## License

MIT
