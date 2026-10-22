---
title: "如何在 Quest 3 上安装 Parsec 串流 PC 或 MacOS"
date: 2025-04-24T01:40:57.591Z
lastmod: 2025-04-24T01:43:32.497Z
description: "如何在 Quest 3 上安装 Parsec 串流 PC 或 MacOS在这篇博客中，我们将详细介绍如何在 Meta Quest 3 上安装 Parsec 客户端，并通过远程串流连接到你的 PC 或 MacOS 设备。整个过程非常简单，通过在 APKPure 下载 Parsec 的 XAPK 文件，然后使用 SAI（Split APKs Installer）在 Quest 3 上进行安装，我们就能"
categories:
  - "技术"
  - "好玩的"
tags:
  - "Quest"
  - "头显"
  - "串流"
  - "Parsec"
  - "Meta"
  - "VR"
url: "/2025/04/24/如何在 Meta Quest 3 上安装 Parsec 串流 PC 或 MacOS/"
draft: false
---

# 如何在 Quest 3 上安装 Parsec 串流 PC 或 MacOS

在这篇博客中，我们将详细介绍如何在 Meta Quest 3 上安装 Parsec 客户端，并通过远程串流连接到你的 PC 或 MacOS 设备。整个过程非常简单，通过在 APKPure 下载 Parsec 的 XAPK 文件，然后使用 SAI（Split APKs Installer）在 Quest 3 上进行安装，我们就能轻松实现远程桌面体验。

* * *

### 第 1 步：下载 Parsec XAPK 文件

1.  访问 [APKPure](https://www.apkpure.com/) 网站，搜索 Parsec 客户端，选择适合 `arm64-v8a` 架构的版本。通常，APKPure 会提供一个 XAPK 格式的下载链接。
    
    在我们的示例中，使用了这个链接：[下载 Parsec XAPK](https://d.apkpure.com/b/XAPK/tv.parsec.client?versionCode=315009705&nc=arm64-v8a&sv=28)。
    
2.  下载完成后，你会得到一个 `.xapk` 文件，这个文件实际上是一个压缩包，里面包含了多个 APK 文件。
    

* * *

### 第 2 步：解压 XAPK 文件

1.  **将 `.xapk` 文件的扩展名改为 `.zip`**，然后解压这个文件。
    
2.  解压后，你会看到两个 APK 文件：
    
    -   `tv.parsec.client.apk`（主程序）
    -   `config.arm64_v8a.apk`（针对 ARM64 架构的配置 APK）

这些文件必须一起安装，才能确保 Parsec 客户端正常运行。

* * *

### 第 3 步：安装 SAI（Split APKs Installer）

1.  使用 **SideQuest** 或 **USB** 将 **SAI APK** 安装到你的 Quest 3 上。可以在 [SAI GitHub 页面](https://github.com/Aefyr/SAI/releases) 下载最新版本的 SAI 安装包。
    
2.  安装完成后，在 Quest 3 上打开 **SAI** 应用。
    

* * *

### 第 4 步：使用 SAI 安装 Parsec 客户端

1.  打开 SAI 后，点击界面中的 **“安装 APKs”** 按钮。
    
2.  浏览文件系统，选择你之前解压出的这两个 APK 文件：
    
    -   `tv.parsec.client.apk`（主程序）
    -   `config.arm64_v8a.apk`（配置 APK）
3.  勾选这两个文件并点击 **“安装”**。安装过程中，SAI 会自动处理分包 APK，确保 Parsec 客户端能够在 Quest 3 上正常运行。
    
4.  安装完成后，返回 Quest 3 的 **“未知来源”** 页面，你会看到 **Parsec** 应用图标。
    

* * *

### 第 5 步：连接到 PC 或 MacOS

1.  在你的 PC 或 MacOS 上，下载并安装 **Parsec 客户端**。如果你还没有账户，可以创建一个免费账号。
    
2.  在 Parsec 应用中登录你的账户。
    
3.  在 Quest 3 上启动 Parsec 客户端，使用你的账号登录，并找到你要连接的设备。
    
4.  一旦连接成功，你就可以通过 Quest 3 享受高质量的远程桌面体验，无论是玩游戏、办公，还是使用其他 PC 或 Mac 应用。
    

* * *

### 小贴士

-   **网络要求**：确保你的 PC/Mac 和 Quest 3 都连接到同一 Wi-Fi 网络，以获得更好的串流体验。
-   **权限设置**：首次使用 Parsec 时，可能需要授予应用网络、麦克风等权限。
-   **控制方式**：你可以通过 Quest 3 的虚拟桌面进行鼠标和键盘控制，甚至使用手柄进行游戏控制。

* * *

### 总结

通过这个简单的过程，你就能在 Quest 3 上安装 Parsec 客户端，并通过串流远程访问你的 PC 或 MacOS 设备。使用 SAI 安装分包 APK，使整个过程更加简便，无需复杂的命令行操作。

享受你的 VR 串流体验吧！

* * *
