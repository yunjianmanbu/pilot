# 零售门店会员中枢（行业方案包示例）

这是一个**可交付给客户的方案包**模板：目录里有方案清单、插件源码、品牌预设和落地说明，
唯独没有私钥。

```
retail-member/
├── solution.json              # 方案清单：插件、权限、品牌、信任锚
├── README.md                  # 本文（交付给客户的落地说明）
└── plugins/
    └── retail-loyalty/
        ├── plugin.json        # 插件清单：路由、权限、角色、限流
        └── index.mjs          # 业务实现：登记 / 查积分 / 核销
```

## 1. 供应商侧：生成密钥并签名

```bash
# 一次性：生成供应商自己的 ed25519 密钥对（自签名，不需要 CA）
pilot plugin keygen --label "示例供应商" --out ./keys
# keys/示例供应商.private.pem  只留在供应商手里
# keys/示例供应商.public.pem   随方案包或合同交给客户

# 每次改完源码并构建后重新签名（覆盖 plugins/ 下所有插件）
pilot plugin sign --all --key ./keys/供应商.private.pem --workspace .
```

签名覆盖 `plugin.json` 与它声明的 `entry` 文件两个文件的字节。改任何一行都要重签，
否则客户侧会看到 `tampered`。

## 2. 客户侧：先审、再装、再验

```bash
# 只读预检：打印每个插件的签名状态、申请权限、阻塞项，不写任何文件
pilot solution plan ./retail-member

# 把供应商公钥加入本工作区信任库
pilot plugin trust ./retail-member/keys/供应商.public.pem --label "示例供应商"

# 安装（会写 .pilot/plugins/<id>/、grants.json、trusted-keys.json、solution.lock.json）
pilot solution install ./retail-member --accept-permissions

# 之后任何本地改动都会被锁文件比出来
pilot solution verify
```

## 3. 门店落地要点

| 事项 | 做法 |
| --- | --- |
| 会员数据落点 | `$PILOT_PLUGIN_STATE_DIR/loyalty.json`（权限 0600），不在工作区源码树里 |
| 谁能查积分 | `loyalty:read`：角色 `clerk`（店员）、`manager`、`owner` |
| 谁能核销 | `loyalty:write`：角色 `manager`、`owner` |
| 会话来源 | 由 `pilot-auth` 之类的 session provider 提供；没有时 `auth: "required"` 的路由一律 401 |
| 升级 | 客户侧重复 `solution install`，插件目录整体替换，锁文件记录新 digest |
| 回滚 | 保留上一版方案包目录，重新 `install` 即可；`trusted-keys.json` 不会因升级丢失 |

## 4. 验收清单

- [ ] `pilot solution plan` 输出 `RESULT PASS`
- [ ] `pilot plugin verify` 输出 `RESULT PASS：全部 trusted`
- [ ] 匿名调用 `GET /api/plugins/retail-loyalty/points` 返回 401 且带 `WWW-Authenticate`
- [ ] `clerk` 角色调用 `POST /redeem` 返回 403
- [ ] `pilot solution verify` 输出 `RESULT PASS：与安装时的签名一致`
- [ ] 停服务后 `$PILOT_PLUGIN_STATE_DIR` 里没有出现明文密码类数据（本插件不含账号体系）

## 5. 这个示例刻意没做什么

- 不带私钥、不做证书吊销、不做时间戳服务：信任完全由客户本地的
  `.pilot/plugins/trusted-keys.json` 决定。
- 不做数据库：状态落 JSON 文件，够门店单机用；连锁多店请把 handler 换成真实后端调用。
- 不做多语言界面：`branding.locale` 只是给上层壳子的提示字段。
