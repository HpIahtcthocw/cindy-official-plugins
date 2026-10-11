# 用通讯录记人与整理

通讯录只保存在用户本机。你读到的档案会进入当前对话，由用户配置的模型处理。

## 先查再写

1. 对话里出现一个人或组织——陌生邮箱、手机号、平台 id、"这是谁"、要给某人发消息、准备会议——先调用
   `ghost_call({ ghost_id: "cindy-contacts", tool: "find", args: { query: "<线索原文>" } })`。
2. 命中后用 `get` 读全量档案，再决定是更新还是什么都不做。不要凭记忆新建。
3. `save` 新建返回 `DUPLICATE_SUSPECT` 时，逐个 `get` 候选确认是不是同一人：是，就带 `id` 更新；不是，才传 `allow_duplicate: true`。
4. 返回 `IDENTITY_CONFLICT` 时，这个邮箱/账号已属于 `conflictContactId` 那个人：更新那份档案，或在用户确认是同一人后 `merge`。

## 什么值得记

- 值得记：与用户真实共事或生活的人，以及持久的事实——新联系人、职位/公司/团队变化、新联系方式、明确的约定、值得记住的一次往来。
- 不记：一次性发件人、营销邮件、通知机器人、群发通讯；对话里顺带提到但与用户无关的名人。
- 不确定的信息（猜测的身份、推断的职位变化）用 `status: "pending"` 写入，让用户在通讯录里确认；不要静默写成已确认。

## 怎么写

- `summary` 是一句话介绍：是谁、在哪、做什么。
- `narrative` 是长期背景和你们的故事，用自然语言写几句；它会被整体覆盖，修改前先 `get` 读出原文再改写，不要丢掉旧内容。
- 有时效的事实用 `log_event` 记成带日期的事件（`date` 用事情发生的日期，不是今天）。
- `agent_notes` 只写给 AI 的处置提示，如偏好的联系方式、称呼、注意事项。
- 平台名用小写：`email`、`phone`、`feishu`、`slack`、`github`、`wechat`、`telegram`、`x`。

## 需要用户明确同意的操作

- `merge`、`delete`、`groups` 的 `delete`、`organize` 的批量移动：只在用户明确要求或确认后执行。
- `import_macos` 先用默认的 `dry_run` 告诉用户会新建和补全多少人，用户同意后再传 `dry_run: false`。
- 删除需要传 `confirm: true`；不确定用户是否要删除时先问。

## 整理通讯录

1. `find_duplicates` 找出疑似重复，对每一对 `get` 双方，把判断交给用户；同意后 `merge`，保留信息更全的一份为 `target`。
2. `list` 加 `status: "pending"` 查看待确认队列，向用户逐个确认后用 `organize` 的 `confirm`。
3. 分组用 `organize` 的 `add_to_group` / `move_to_group`；分组本身用 `groups` 管理。

## 自动维护

用户在通讯录里开启「自动整理」后，Cindy 会按设定的频率起一轮任务执行本节。每一轮都是增量的：

1. `maintenance` 传 `action: "begin"`，拿到 `checkpoint`（上次处理到的时间）、`now`、`maxChanges` 和 `guidance`（当前档位的要求）。首次运行的检查点是一周前。
2. 用 Cindy 历史工具读取检查点之后的对话：`list_sessions` 按时间筛选，再用 `get_chat_history` 读取，只看 `user` 和 `assistant`。用户装了邮件或日历插件时，也看同一时间段的往来邮件和会议参与人。
3. 只提取与用户真实往来的人和组织的新信息。每个人先 `find`；已有就更新（`save` 带 `id`、`log_event`、`relate`），没有再新建。推断出来的身份或职位变化写成 `pending`。
4. 本轮改动不超过 `maxChanges`，多出来的留到下一轮，不要在一轮里清空积压。不删除、不合并；疑似重复留给用户在通讯录里处理。
5. 最后 `maintenance` 传 `action: "end"`，带 `checkpoint`（通常是 begin 返回的 `now`）、`scanned`、`created`、`updated`、`pending`。没有任何新信息也要调用 end，否则下一轮会重复扫描。

档位：

- **同事为主**：每天一轮。重点是职位与团队变化、新联系方式、约定和值得记住的往来。
- **客户很多**：每 6 小时一轮，上限更高。客户联系人挂到所属公司（`relate`，公司不存在时先建 `kind: "org"` 的档案），放进以公司命名的分组；事件里写清需求、报价、合同、跟进约定和下次联系时间。

导入大量联系人（客户名单、表格、名片）时用 `save_many`，每次最多 100 条，逐条处理返回的失败。
