# builtin-tools

随安装包分发的通用工具。**这个目录由脚本生成，不要手改。**

```bash
# 在 pilot/client 下执行；--from 指向已沉淀（提升为全局）的工具目录
pnpm builtin:pack
```

生成的每个条目包含：`tool.json`、入口脚本、自测脚本，以及一份 `index.json`。
`index.json` 里每个工具的 `sha256` 是打包脚本**跑完该工具自测之后**按运行时的同一算法
（`sha256('manifest\0' + tool.json 原文 + '\0entry\0' + 入口字节 + '\0test\0' + 自测字节)`）算出来的。

首次启动时 `ensureBuiltinTools()`（`src/main/agent/builtin-tools.ts`）会在
`resources/builtin-tools`（npm 安装时为 `<包根>/builtin-tools`）找到它，逐个交给
`DynamicToolRegistry.adoptBundled()`：重新哈希磁盘上的字节、必须与 `index.json` 一致，
才把该工具写进 `<userData>/tools/global/<name>` 并记为已批准。规则：

- 用户改过的同名全局工具不会被覆盖（哈希已不匹配批准记录）；
- 只有「仍然处于批准状态」的旧版本才会被整包升级；
- 任何一步不匹配都只跳过并在汇总里报告，不抛进本次 run。

`--allow-unverified` 只用于自测需要真实桌面环境的工具（例如需要微信窗口），
此时 `index.json` 里记 `verified: false`。
