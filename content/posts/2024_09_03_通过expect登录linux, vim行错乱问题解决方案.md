---
title: "通过expect登录linux, vim行错乱问题解决方案"
date: 2024-09-03T02:57:50.840Z
lastmod: 2024-09-03T02:59:34.731Z
description: "背景当使用 expect 登入你的虚拟主机的时候，你会发现使用 vim，会经常出现行错乱的问题。 原因expect 脚本自动 ssh 登陆，当终端窗口发生变化时，默认 expect 不会将终端窗口大小改变的信号传送到远程的服务器上，因此在使用上会出现很不方便的地方，比如 vim 打开文件时出现串行，要是含有中文的文件可能根本无法编辑。 解决12345678#!/usr/bin/env expect"
categories:
  - "技术"
  - "开发"
tags:
  - "ssh"
url: "/2024/09/03/通过expect登录linux, vim行错乱问题解决方案/"
draft: false
---

### 背景

当使用 expect 登入你的虚拟主机的时候，你会发现使用 vim，会经常出现行错乱的问题。

### 原因

expect 脚本自动 ssh 登陆，当终端窗口发生变化时，默认 expect 不会将终端窗口大小改变的信号传送到远程的服务器上，因此在使用上会出现很不方便的地方，比如 vim 打开文件时出现串行，要是含有中文的文件可能根本无法编辑。

### 解决

```bash
#!/usr/bin/env expect 
#trap sigwinch spawned
trap {
 set rows [stty rows]
 set cols [stty columns]
 stty rows $rows columns $cols < $spawn_out(slave,name)
} WINCH
#...
```

结果你发现完全OK ，不再乱行了
