---
title: "Docker安装的Mysql数据库定时备份脚本"
date: 2025-08-20T16:00:00.000Z
lastmod: 2025-08-21T01:32:15.838Z
description: "Docker安装的Mysql数据库定时备份脚本"
categories:
  - "技术"
  - "开发"
tags:
  - "Docker"
  - "MySQL"
  - "脚本"
url: "/2025/08/21/Docker安装的Mysql数据库定时备份脚本/"
draft: false
---

### 功能说明：

-   1.  使用 docker exec 调用 mysqldump，生成 .sql 备份文件；
-   2.  文件名中包含当前时间，保存在 mysql_backup/ 目录；
-   3.  自动清理：
    
    -   删除 超过 7 天的备份文件；
    -   保留每月 1 号的备份文件，不管时间多久。

### 脚本 mysql_backup.sh

```bash
#!/bin/bash

# ========== 配置 ==========
CONTAINER_NAME="mysql"
MYSQL_USER="dbuser"
MYSQL_PASSWORD="dbpassword"
BACKUP_DIR="/home/ubuntu/mysql_backup"

# ========== 创建备份目录 ==========
mkdir -p "$BACKUP_DIR"

# ========== 生成备份文件名 ==========
DATE=$(date '+%Y-%m-%d_%H-%M-%S')
BACKUP_FILE="${BACKUP_DIR}/backup_${DATE}.sql"

# ========== 执行备份 ==========
echo "开始备份：$BACKUP_FILE"
docker exec "$CONTAINER_NAME" mysqldump -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" --all-databases > "$BACKUP_FILE"

# ========== 清理逻辑 ==========
echo "清理旧备份..."

# 找出所有 .sql 文件
find "$BACKUP_DIR" -type f -name "*.sql" | while read file; do
    # 提取文件名中的日期
    filename=$(basename "$file")
    date_str=$(echo "$filename" | grep -oP '\d{4}-\d{2}-\d{2}')

    # 如果提取不到日期，跳过
    if [[ -z "$date_str" ]]; then
        continue
    fi

    # 获取今天日期和文件日期的时间戳
    file_ts=$(date -d "$date_str" +%s)
    today_ts=$(date +%s)

    # 计算文件和今天的天数差
    age_days=$(( (today_ts - file_ts) / 86400 ))

    # 如果超过 7 天且不是每月 1 号
    if [[ $age_days -gt 7 ]]; then
        day_of_month=$(date -d "$date_str" +%d)
        if [[ "$day_of_month" != "01" ]]; then
            echo "删除过期备份：$file"
            rm -f "$file"
        fi
    fi
done

echo "备份完成。"
```

### 设置定时任务

设置每天 12:00 和 20:00 备份一次，并将日志写入文件。

```plaintext
0 12,20 * * * /home/ubuntu/mysql_backup.sh >> /home/ubuntu/mysql_backup.log 2>&1
```
