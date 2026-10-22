---
title: "Gitea 自动备份到 MinIO"
date: 2026-10-23T03:44:35+08:00
draft: false
description: "为了防止服务器故障、磁盘损坏或误操作导致代码仓库丢失，可以将 Gitea 数据目录定时同步到 MinIO 对象存储，实现异地备份。"
categories:
  - "技术"
tags:
  - "Gitea"
  - "MinIO"
  - "备份"
  - "自动化"
---

# Gitea 自动备份到 MinIO

## 方案说明

为了防止服务器故障、磁盘损坏或误操作导致代码仓库丢失，可以将 Gitea 数据目录定时同步到 MinIO 对象存储，实现异地备份。

本方案基于：

- Gitea
- MinIO
- MinIO Client（mc）
- Linux Crontab

同步方式采用 `mc mirror`，支持增量同步，仅传输新增或变更文件。

---

## 前置条件

### 0. docker compose 安装 MinIO

```
services:
  minio-server:  # 这里是正确的服务定义位置minio-server:
    image: quay.io/minio/minio:RELEASE.2025-04-03T14-56-28Z
    container_name: minio
    ports:
      - "9000:9000"  # API端口
      - "9001:9001"  # 控制台端口
    volumes:
      - /vol1/1000/docker/minio/data:/data  # 挂载数据目录
    environment:
      MINIO_ROOT_USER: username  # 默认管理员用户名
      MINIO_ROOT_PASSWORD: password  # 默认管理员密码
    command: server --console-address ":9001" /data  # 指定控制台端口和数据目录
    restart: always
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3
```

### 1. 安装 MinIO Client

```bash
curl https://dl.min.io/client/mc/release/linux-amd64/mc \
  -o /usr/local/bin/mc

chmod +x /usr/local/bin/mc
```

验证安装：

```bash
mc --version
```

### 2. 配置 MinIO 连接

添加 MinIO 服务：

```bash
mc alias set myminio \
  http://minio.example.com:9000 \
  ACCESS_KEY \
  SECRET_KEY
```

验证连接：

```bash
mc ls myminio
```

---

## Gitea 数据目录

确认 Gitea 实际数据目录，例如：

```
/home/rong/gitea
```

目录通常包含：

```
gitea/
├── repositories/   # Git 仓库
├── lfs/            # Git LFS 文件
├── data/           # 附件及其他数据
├── conf/           # 配置文件
└── log/            # 日志
```

---

## 手动执行备份

执行同步：

```bash
mc mirror --overwrite \
  /home/rong/gitea \
  myminio/backup/gitea
```

同步完成后：

```
myminio
└── backup
    └── gitea
        ├── repositories
        ├── lfs
        ├── data
        └── conf
```

---

## 配置定时任务

编辑 Crontab：

```bash
crontab -e
```

添加：

```bash
0 4 * * * /usr/local/bin/mc mirror --overwrite /home/rong/gitea myminio/backup/gitea >> /home/rong/gitea-backup.log 2>&1
```

含义：

| 配置项 | 说明 |
| --- | --- |
| 0 4 * * * | 每天凌晨 4 点执行 |
| mc mirror | 目录镜像同步 |
| --overwrite | 覆盖已存在文件 |
| /home/rong/gitea | 本地 Gitea 数据目录 |
| myminio/backup/gitea | MinIO 备份目录 |
| >> log | 记录执行日志 |
| 2>&1 | 记录错误日志 |

查看日志：

```bash
tail -f /home/rong/gitea-backup.log
```

---

## 关于 --remove 参数

可以使用：

```bash
mc mirror --overwrite --remove \
  /home/rong/gitea \
  myminio/backup/gitea
```

但不建议用于备份场景。

原因：

如果本地误删仓库：

```
/home/rong/gitea/repositories/project.git
```

下一次同步时，MinIO 中对应目录也会被删除。

因此：

- `-remove`：适合灾备镜像
- 不加 `-remove`：适合长期备份

推荐使用：

```bash
mc mirror --overwrite
```

---

## 数据恢复

从 MinIO 恢复：

```bash
mc mirror \
  myminio/backup/gitea \
  /home/rong/gitea
```

恢复完成后启动 Gitea：

```bash
docker restart gitea
```

或：

```bash
docker compose restart gitea
```

---

## 最佳实践

推荐策略：

- 每天凌晨自动同步
- MinIO 开启版本控制（Versioning）
- 定期验证备份可恢复性
- 重要数据同时备份到另一台服务器或云存储

推荐保留：

```
本地 Gitea
    ↓
MinIO 主备份
    ↓
异地存储（可选）
```

形成多副本备份体系，降低数据丢失风险。

---

## 示例目录结构

```
MinIO
└── backup
    └── gitea
        ├── repositories
        ├── lfs
        ├── data
        ├── conf
        └── log
```

该方案适用于 Docker 部署、NAS 部署以及传统 Linux 服务器部署的 Gitea 实例。
