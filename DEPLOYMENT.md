# 免费候选版部署与验收

本文件是待执行清单，不代表云服务已建立。保留原私有插件和本机数据，公开服务使用独立仓库、数据库与登录配置。任何要求银行卡或升级的步骤先停止，不默认付费。

## 1. 先注册账户

注册 [Neon](https://console.neon.tech/) 与 [Auth0](https://auth0.com/signup) 免费账号。接受条款、登录验证和授权由账户所有者完成。不要把数据库连接串、Client Secret、会话密钥或登录验证码发到聊天或提交到 Git。

## 2. Neon 独立数据库

新建单独的 Free 项目，不连接或导入原私有测试数据；选择与 Render 尽量接近的区域。在项目 Connect 面板取 PostgreSQL 连接串，保存为 Render 的 `DATABASE_URL`。可使用带 pooler 的连接地址；应用连接池最多 5 条连接，事务使用同一个客户端和事务级锁。连接的 TLS 验证不可关闭。

应用的 `pnpm migrate` 创建三张独立表：公共工效、个人历史、每日保存计数。迁移幂等且只插入缺失的默认工效；没有 HTTP 迁移入口，也不会导入私人文件。生产数据库测试前备份；不通过删库、清表解决迁移问题。[Neon Node 指南](https://neon.com/docs/guides/node)

## 3. Auth0 网站登录

使用专用免费租户默认域名，不开自定义付费域名。新建 **Regular Web Application**，启用用于注册用户的连接。网站采用 Authorization Code + PKCE，服务器保存 Client Secret。

将实际 Render HTTPS 根地址记为 `PUBLIC_ORIGIN`。Blueprint 通过自引用 `RENDER_EXTERNAL_URL` 自动获取实际地址，不预先猜测域名。在 Auth0 网站应用中精确设置 Callback URL 为该地址加 `/callback`，例如 `https://workforce.example/callback`；不要使用通配符。当前退出只清除本网站会话，不触发全局 Auth0 退出，因此共享电脑切换账号时还应在登录页明确选择账号。

填写环境变量：`AUTH0_ISSUER_BASE_URL` 是租户 HTTPS 根地址，`AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` 来自该网站应用。`SESSION_SECRET` 由 Render 随机生成，轮换会使既有网站会话失效。[Auth0 Express 指南](https://auth0.com/docs/quickstart/webapp/express)

## 4. Auth0 公开 MCP 授权

网站登录应用不等于 ChatGPT MCP 授权客户端；不要把网站 cookie 或网站 Client Secret 放进内嵌 HTML。

在租户注册独立 API，标识符设置为实际 `PUBLIC_ORIGIN` 加 `/mcp`，签名算法 RS256，添加权限 `workforce:read` 与 `workforce:write`。默认 `AUTH0_AUDIENCE` 就是该标识符；若另设标识符必须在 Render 同步配置，不能跳过 audience 校验。允许本应用所需的用户委托授权，避免要求并未配置的自定义角色规则。

为 MCP 启用 Auth0 的 **Resource Parameter Compatibility Profile**，使 OAuth `resource` 正确对应 API audience。若租户仍返回 userinfo audience 的不透明 token，先核对该开关和默认 audience，不降低 JWT 验证条件。[Auth0 MCP audience 排障](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0)

ChatGPT 客户端注册按最终插件创建界面的真实要求选择：支持预注册客户端时，新建单独的 OAuth 客户端，只登记界面显示的精确回调地址，并在安全配置区填写其 Client ID/Secret；若该发布路径要求动态注册，按 Auth0 MCP 文档配置 DCR 或受支持的 CIMD，并核对连接允许第三方应用使用、用户委托访问和授权 scopes。启用开放 DCR 会扩大客户端注册范围，不在本地改造时自动开启。两种方式不能以未经验证的示例地址代替实际回调。

资源地址为 `PUBLIC_ORIGIN/mcp`，公开元数据为 `PUBLIC_ORIGIN/.well-known/oauth-protected-resource`。匿名可发现工具描述，但所有工效、个人资料、历史和写操作都要求授权；scope 不足返回 OAuth 升级提示，非管理员不能用重新授权获得工效维护权。[OpenAI 插件认证](https://developers.openai.com/plugins/build/auth)

管理员由 Render 中的 `ADMIN_SUBJECTS` 指定已验证 Auth0 用户的原始 sub，可逗号分隔；不填则无人可修改公共库。不得用邮箱或前端勾选框授权。两种客户端都必须映射到同一 Auth0 用户，才能在网页和 ChatGPT 看到同一份个人历史；使用两个不同登录身份的记录不会自动合并。

## 5. Render 免费 Web 服务

仅管理本仓库的新服务，不改私有服务或原隧道。候选 `render.yaml` 明确 `plan: free`、关闭自动部署；不创建 Render 数据库、磁盘、worker、付费预部署任务或预览环境。部署前核对服务名未被其他资源占用。

构建采用锁文件和禁用安装脚本，先进行发布预检。免费计划没有 pre-deploy，因此启动命令显式先运行幂等迁移，再启动公开 HTTP 服务。进程监听 Render 的 `PORT` 和 `0.0.0.0`。`/health` 是不唤醒外部数据库的进程存活检查；`/ready` 另外检查数据库可用性，部署后两项都要验收。新建时 `sync:false` 请求安全填写必需变量；后续修改必须在服务 Environment 中保存并重新部署，不能认为改 YAML 空占位会更新既有密钥。[Blueprint 参考](https://render.com/docs/blueprint-spec)、[部署说明](https://render.com/docs/deploys)

渲染的四页 HTML 由服务器明确注入公开模式标识。不能直接用静态站点发布 `public/` 来替代此服务器，否则没有认证、数据库或账号隔离。

## 6. 上线前逐项验收（尚未执行）

1. Render 部署状态真实为 live，HTTPS `/health` 版本正确，`/ready` 成功；无数据库或密钥泄露日志。
2. 两个不同个人账号分别完成真实网站登录和 ChatGPT OAuth，未登录不能读库/历史。
3. 账号 A 生成一条合成方案，B 无法列出、读取或删除它；伪造编号和角色不提升权限。
4. 公开工效对 A/B 均可读，只有管理员可维护；测试后保留测试记录还是删自己的记录需明确决定，不触碰任何私有记录。
5. 同 requestId 重试只保存一条；资料变化使指纹失效；工效缺失时提示补充，不冒称完整方案。
6. 当前 ChatGPT 完成 prepare→确认条件→generate 流程，四页切换、原面板结果回填、柱状图和横道图缩放都可用。网页复制请求到同一公开插件也能找回原结果；不调用模型 API。
7. 注销/切换账号不闪现上一账号方案、比例或草稿；分别验收网页及内嵌宿主状态。
8. 用户确认默认工效可公开、隐私政策/支持入口/数据删除说明与公开展示权限后，再提交平台公开发布审核；代码上传不等于公开上架。

数据库恢复与数据保留策略需在实际免费账户能力下复核；应用回滚不会回滚数据库。暂停公开服务不影响本机私有测试版。不得用同一私有数据库、密钥或本机隧道冒充独立公开版。
